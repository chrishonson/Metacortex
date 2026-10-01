import fs from "node:fs";
import path from "node:path";

import { getApps, initializeApp, type App } from "firebase-admin/app";
import {
  FieldPath,
  getFirestore,
  type Firestore,
  type QueryDocumentSnapshot
} from "firebase-admin/firestore";

import {
  decodeDocument,
  DOCUMENT_ID_FIELD,
  encodeDocument
} from "./firestore-codec.js";

export const PROD_PROJECT_ID = "my-brain-88870";
export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_SCHEMA = "metacortex-firestore-full-backup-v1";
export const PAGE_SIZE = 400;
export const WRITE_BATCH_LIMIT = 400;

export interface FullBackupCollectionEntry {
  id: string;
  document_count: number;
  ndjson: string;
  bytes: number;
}

export interface FullBackupManifest {
  schema: typeof MANIFEST_SCHEMA;
  source_project: string;
  generated_at: string;
  generated_at_ms: number;
  discovery: "listCollections()";
  collection_ids: string[];
  collections: FullBackupCollectionEntry[];
}

export function assertWritableProject(projectId: string): void {
  if (projectId === PROD_PROJECT_ID) {
    throw new Error(
      `refusing writes to prod project ${PROD_PROJECT_ID}; pass a non-prod --project`
    );
  }
}

export function openFirestore(projectId: string, role: string): Firestore {
  const name = `full-mirror-${role}-${projectId}`;
  const existing = getApps().find((app: App) => app.name === name);
  const app = existing ?? initializeApp({ projectId }, name);
  const firestore = getFirestore(app);
  const resolved = firestore.projectId;

  if (resolved && resolved !== projectId) {
    throw new Error(
      `firestore project mismatch for ${role}: expected ${projectId}, got ${resolved}`
    );
  }

  return firestore;
}

/**
 * Inventory comes only from live listCollections(). Never pass a hardcoded set.
 */
export async function listCollectionIds(firestore: Firestore): Promise<string[]> {
  const refs = await firestore.listCollections();
  return refs.map(ref => ref.id).sort((left, right) => left.localeCompare(right));
}

export async function countDocuments(
  firestore: Firestore,
  collectionId: string
): Promise<number> {
  const snap = await firestore.collection(collectionId).count().get();
  return snap.data().count;
}

export async function readAllDocs(
  firestore: Firestore,
  collectionId: string
): Promise<QueryDocumentSnapshot[]> {
  const docs: QueryDocumentSnapshot[] = [];
  let lastId: string | undefined;

  while (true) {
    let query = firestore
      .collection(collectionId)
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);

    if (lastId) {
      query = query.startAfter(lastId);
    }

    const snap = await query.get();
    if (snap.empty) {
      break;
    }

    docs.push(...snap.docs);
    lastId = snap.docs[snap.docs.length - 1].id;
    if (snap.size < PAGE_SIZE) {
      break;
    }
  }

  return docs;
}

export function ndjsonFileName(collectionId: string): string {
  if (collectionId.includes("/") || collectionId.includes("\\") || collectionId.includes("..")) {
    throw new Error(`refusing unsafe collection id for filename: ${collectionId}`);
  }
  return `${collectionId}.ndjson`;
}

export function serializeNdjson(docs: Array<Record<string, unknown>>): string {
  return docs.map(doc => `${JSON.stringify(doc)}\n`).join("");
}

export function parseNdjson(raw: string): Array<Record<string, unknown>> {
  const docs: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    docs.push(JSON.parse(trimmed) as Record<string, unknown>);
  }
  return docs;
}

export function encodedDocumentIds(docs: Array<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const doc of docs) {
    const id = doc[DOCUMENT_ID_FIELD];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`archive document missing ${DOCUMENT_ID_FIELD}`);
    }
    ids.add(id);
  }
  return ids;
}

export function idsToPrune(targetIds: readonly string[], keepIds: ReadonlySet<string>): string[] {
  return targetIds.filter(id => !keepIds.has(id));
}

/**
 * Drop NDJSON files for collections that listCollections() no longer returns.
 * Leaves non-NDJSON files (AUDIT, gate JSON) untouched.
 */
export function removeStaleNdjsonFiles(
  archiveDir: string,
  collectionIds: readonly string[]
): string[] {
  if (!fs.existsSync(archiveDir)) {
    return [];
  }

  const keep = new Set(collectionIds.map(ndjsonFileName));
  const removed: string[] = [];
  for (const fileName of fs.readdirSync(archiveDir)) {
    if (!fileName.endsWith(".ndjson") || keep.has(fileName)) {
      continue;
    }
    fs.unlinkSync(path.join(archiveDir, fileName));
    removed.push(fileName);
  }
  return removed;
}

export async function dumpCollection(
  firestore: Firestore,
  collectionId: string,
  archiveDir: string
): Promise<FullBackupCollectionEntry> {
  const snapshots = await readAllDocs(firestore, collectionId);
  const docs = snapshots
    .map(doc => encodeDocument(doc.id, doc.data() as Record<string, unknown>))
    .sort((left, right) =>
      String(left[DOCUMENT_ID_FIELD]).localeCompare(String(right[DOCUMENT_ID_FIELD]))
    );
  const fileName = ndjsonFileName(collectionId);
  const outPath = path.join(archiveDir, fileName);
  const body = serializeNdjson(docs);
  fs.writeFileSync(outPath, body, "utf8");

  return {
    id: collectionId,
    document_count: docs.length,
    ndjson: fileName,
    bytes: Buffer.byteLength(body)
  };
}

export async function clearCollection(
  firestore: Firestore,
  collectionId: string
): Promise<number> {
  assertWritableProject(firestore.projectId);
  let deleted = 0;

  while (true) {
    const snap = await firestore.collection(collectionId).limit(WRITE_BATCH_LIMIT).get();
    if (snap.empty) {
      break;
    }
    const batch = firestore.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      deleted += 1;
    }
    await batch.commit();
  }

  return deleted;
}

export async function writeDocuments(
  firestore: Firestore,
  collectionId: string,
  docs: Array<Record<string, unknown>>
): Promise<number> {
  assertWritableProject(firestore.projectId);
  let written = 0;
  const collection = firestore.collection(collectionId);

  for (let offset = 0; offset < docs.length; offset += WRITE_BATCH_LIMIT) {
    const chunk = docs.slice(offset, offset + WRITE_BATCH_LIMIT);
    const batch = firestore.batch();
    for (const encoded of chunk) {
      const { id, data } = decodeDocument(encoded);
      batch.set(collection.doc(id), data);
      written += 1;
    }
    await batch.commit();
  }

  return written;
}

/**
 * Delete target docs whose ids are not in the archive snapshot for this collection.
 * Does not delete collections that are absent from the archive.
 */
export async function pruneAbsentDocuments(
  firestore: Firestore,
  collectionId: string,
  keepIds: ReadonlySet<string>
): Promise<number> {
  assertWritableProject(firestore.projectId);
  const existing = await readAllDocs(firestore, collectionId);
  const extraIds = new Set(idsToPrune(existing.map(doc => doc.id), keepIds));
  const toDelete = existing.filter(doc => extraIds.has(doc.id));
  let deleted = 0;

  for (let offset = 0; offset < toDelete.length; offset += WRITE_BATCH_LIMIT) {
    const chunk = toDelete.slice(offset, offset + WRITE_BATCH_LIMIT);
    const batch = firestore.batch();
    for (const doc of chunk) {
      batch.delete(doc.ref);
      deleted += 1;
    }
    await batch.commit();
  }

  return deleted;
}

export function readManifest(archiveDir: string): FullBackupManifest {
  const manifestPath = path.join(archiveDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`missing ${MANIFEST_FILE} in ${archiveDir}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as FullBackupManifest;
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new Error(
      `unsupported manifest schema ${String(manifest.schema)}; expected ${MANIFEST_SCHEMA}`
    );
  }
  if (!Array.isArray(manifest.collections) || manifest.collections.length === 0) {
    throw new Error("manifest collections must be a non-empty array from listCollections()");
  }

  return manifest;
}

export function writeManifest(archiveDir: string, manifest: FullBackupManifest): void {
  fs.writeFileSync(
    path.join(archiveDir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}

export function loadArchiveCollection(
  archiveDir: string,
  entry: FullBackupCollectionEntry
): Array<Record<string, unknown>> {
  const filePath = path.join(archiveDir, entry.ndjson);
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing archive file ${entry.ndjson} for collection ${entry.id}`);
  }
  const docs = parseNdjson(fs.readFileSync(filePath, "utf8"));
  if (docs.length !== entry.document_count) {
    throw new Error(
      `${entry.ndjson} has ${docs.length} documents but manifest records ${entry.document_count}`
    );
  }
  return docs;
}
