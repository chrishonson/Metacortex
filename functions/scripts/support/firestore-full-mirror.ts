import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getApps, initializeApp, type App } from "firebase-admin/app";
import {
  FieldPath,
  getFirestore,
  type CollectionReference,
  type Firestore,
  type QueryDocumentSnapshot
} from "firebase-admin/firestore";

import {
  decodeDocument,
  DOCUMENT_ID_FIELD,
  encodeDocument,
  stableStringify
} from "./firestore-codec.js";

export const PROD_PROJECT_ID = "my-brain-88870";
export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_SCHEMA_V1 = "metacortex-firestore-full-backup-v1";
export const MANIFEST_SCHEMA = "metacortex-firestore-full-backup-v2";
export const PAGE_SIZE = 400;
export const WRITE_BATCH_LIMIT = 400;

export interface MirrorDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface MirrorStore {
  readonly projectId: string;
  discoverCollectionPaths(): Promise<string[]>;
  readCollection(path: string): Promise<MirrorDocument[]>;
  countDocuments(path: string): Promise<number>;
  listDocumentIds(path: string): Promise<string[]>;
  writeDocuments(path: string, docs: MirrorDocument[]): Promise<number>;
  deleteDocuments(path: string, ids: string[]): Promise<number>;
  referenceFor(path: string): unknown;
}

export interface FullBackupCollectionEntry {
  path: string;
  document_count: number;
  ndjson: string;
  bytes: number;
  sha256: string;
  vector_dimensions: number[];
  id?: string;
}

export interface FullBackupManifest {
  schema: typeof MANIFEST_SCHEMA | typeof MANIFEST_SCHEMA_V1;
  source_project: string;
  generated_at: string;
  generated_at_ms: number;
  discovery: "recursive-listCollections" | "listCollections()";
  embedding: { model: string; dimensions: number } | null;
  collection_paths: string[];
  collections: FullBackupCollectionEntry[];
  legacy?: boolean;
  collection_ids?: string[];
}

export class ArchiveValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Archive validation failed with ${problems.length} problem(s):\n- ${problems.join(
        "\n- "
      )}`
    );
    this.name = "ArchiveValidationError";
  }
}

export interface ValidatedArchiveCollection {
  entry: FullBackupCollectionEntry;
  docs: Array<Record<string, unknown>>;
}

export interface ValidatedArchive {
  manifest: FullBackupManifest;
  collections: ValidatedArchiveCollection[];
}

export class RestoreTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreTargetError";
  }
}

export class IncompatibleVectorsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleVectorsError";
  }
}

export class RestoreIncompleteError extends Error {
  constructor(
    message: string,
    readonly report: unknown,
    readonly completedCollections: string[]
  ) {
    super(message);
    this.name = "RestoreIncompleteError";
  }
}

export class RestoreVerificationError extends Error {
  constructor(
    message: string,
    readonly report: unknown
  ) {
    super(message);
    this.name = "RestoreVerificationError";
  }
}

export interface RestoreOptions {
  write: boolean;
  targetPrefix?: string;
  replace?: {
    prune: boolean;
    clearTarget: boolean;
    confirmProject: string | undefined;
  };
  targetEmbedding: { model: string; dimensions: number } | null;
  acceptUnknownEmbeddingSpace?: boolean;
  sourceProjectOverride?: string;
  onProgress?: (message: string) => void;
}

export interface RestoreCollectionReport {
  path: string;
  target_path: string;
  archive_count: number;
  target_count_before: number | null;
  written: number;
  deleted: number;
  pruned: number;
  extra_target_docs?: number;
  status: "planned" | "written" | "verified";
}

export interface RestoreReport {
  complete: boolean;
  collections: RestoreCollectionReport[];
}

export function assertWritableProject(projectId: string): void {
  if (projectId === PROD_PROJECT_ID) {
    throw new Error(
      `refusing writes to prod project ${PROD_PROJECT_ID}; pass a non-prod --project`
    );
  }
}

export function firestoreProjectId(firestore: Firestore): string {
  const projectId: unknown = Reflect.get(firestore, "projectId");
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new Error("cannot verify Firestore project; refusing operator operation");
  }
  return projectId;
}

export function isValidCollectionPath(pathStr: string): boolean {
  if (typeof pathStr !== "string" || pathStr.trim().length === 0) {
    return false;
  }
  if (pathStr.startsWith("/") || pathStr.endsWith("/")) {
    return false;
  }
  const segments = pathStr.split("/");
  if (segments.some(seg => seg.length === 0 || seg === "." || seg === "..")) {
    return false;
  }
  return segments.length % 2 === 1;
}

export function assertValidCollectionPath(pathStr: string): void {
  if (!isValidCollectionPath(pathStr)) {
    throw new Error(`invalid collection path: ${pathStr}`);
  }
}

export function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function extractVectorDimensions(doc: unknown): number[] {
  const dimensions: number[] = [];
  const inspect = (val: unknown): void => {
    if (val === null || typeof val !== "object") {
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        inspect(item);
      }
      return;
    }
    const obj = val as Record<string, unknown>;
    if (obj.__fs === "vector" && Array.isArray(obj.values)) {
      dimensions.push(obj.values.length);
    }
    for (const v of Object.values(obj)) {
      inspect(v);
    }
  };
  inspect(doc);
  return dimensions;
}

export function ndjsonFileName(pathOrId: string): string {
  if (
    !pathOrId ||
    pathOrId.trim().length === 0 ||
    pathOrId.includes("..") ||
    pathOrId.split("/").some(s => s === "..")
  ) {
    throw new Error(`refusing unsafe collection path for filename: ${pathOrId}`);
  }
  return `${encodeURIComponent(pathOrId)}.ndjson`;
}

export function serializeNdjson(docs: Array<Record<string, unknown>>): string {
  return docs.map(doc => `${stableStringify(doc)}\n`).join("");
}

export function parseNdjsonLines(
  raw: string,
  filePath: string,
  problems: string[]
): Array<Record<string, unknown>> {
  const docs: Array<Record<string, unknown>> = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      continue;
    }
    try {
      docs.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch (error) {
      problems.push(
        `malformed JSON line in ${filePath} at line ${index + 1}: ${(error as Error).message}`
      );
    }
  }
  return docs;
}

export function parseNdjson(raw: string): Array<Record<string, unknown>> {
  const problems: string[] = [];
  const docs = parseNdjsonLines(raw, "ndjson", problems);
  if (problems.length > 0) {
    throw new Error(problems[0]);
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

export function idsToPrune(
  targetIds: readonly string[],
  keepIds: ReadonlySet<string>
): string[] {
  return targetIds.filter(id => !keepIds.has(id));
}

export function removeStaleNdjsonFiles(
  archiveDir: string,
  collectionPaths: readonly string[]
): string[] {
  if (!fs.existsSync(archiveDir)) {
    return [];
  }

  const keep = new Set(collectionPaths.map(ndjsonFileName));
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

export function resolveTargetPath(pathStr: string, targetPrefix?: string): string {
  if (!targetPrefix) {
    return pathStr;
  }
  const segments = pathStr.split("/");
  segments[0] = `${targetPrefix}${segments[0]}`;
  return segments.join("/");
}

export class FirestoreMirrorStore implements MirrorStore {
  constructor(readonly firestore: Firestore) {}

  get projectId(): string {
    return firestoreProjectId(this.firestore);
  }

  async discoverCollectionPaths(): Promise<string[]> {
    const rootCollections = await this.firestore.listCollections();
    const discovered = new Set<string>();

    const traverse = async (colRef: CollectionReference): Promise<void> => {
      discovered.add(colRef.path);
      const docRefs = await colRef.listDocuments();
      for (const docRef of docRefs) {
        const subCollections = await docRef.listCollections();
        for (const subCol of subCollections) {
          await traverse(subCol);
        }
      }
    };

    for (const root of rootCollections) {
      await traverse(root);
    }

    return Array.from(discovered).sort((left, right) => left.localeCompare(right));
  }

  async readCollection(pathStr: string): Promise<MirrorDocument[]> {
    assertValidCollectionPath(pathStr);
    const docs: MirrorDocument[] = [];
    let lastId: string | undefined;

    while (true) {
      let query = this.firestore
        .collection(pathStr)
        .orderBy(FieldPath.documentId())
        .limit(PAGE_SIZE);

      if (lastId) {
        query = query.startAfter(lastId);
      }

      const snap = await query.get();
      if (snap.empty) {
        break;
      }

      for (const doc of snap.docs as QueryDocumentSnapshot[]) {
        docs.push({
          id: doc.id,
          data: doc.data() as Record<string, unknown>
        });
      }
      lastId = snap.docs[snap.docs.length - 1].id;
      if (snap.size < PAGE_SIZE) {
        break;
      }
    }

    docs.sort((left, right) => left.id.localeCompare(right.id));
    return docs;
  }

  async countDocuments(pathStr: string): Promise<number> {
    assertValidCollectionPath(pathStr);
    const snap = await this.firestore.collection(pathStr).count().get();
    return snap.data().count;
  }

  async listDocumentIds(pathStr: string): Promise<string[]> {
    assertValidCollectionPath(pathStr);
    const docs = await this.readCollection(pathStr);
    return docs.map(doc => doc.id);
  }

  async writeDocuments(pathStr: string, docs: MirrorDocument[]): Promise<number> {
    assertValidCollectionPath(pathStr);
    assertWritableProject(this.projectId);
    let written = 0;
    const collection = this.firestore.collection(pathStr);

    for (let offset = 0; offset < docs.length; offset += WRITE_BATCH_LIMIT) {
      const chunk = docs.slice(offset, offset + WRITE_BATCH_LIMIT);
      const batch = this.firestore.batch();
      for (const doc of chunk) {
        batch.set(collection.doc(doc.id), doc.data);
        written += 1;
      }
      await batch.commit();
    }

    return written;
  }

  async deleteDocuments(pathStr: string, ids: string[]): Promise<number> {
    assertValidCollectionPath(pathStr);
    assertWritableProject(this.projectId);
    let deleted = 0;
    const collection = this.firestore.collection(pathStr);

    for (let offset = 0; offset < ids.length; offset += WRITE_BATCH_LIMIT) {
      const chunk = ids.slice(offset, offset + WRITE_BATCH_LIMIT);
      const batch = this.firestore.batch();
      for (const id of chunk) {
        batch.delete(collection.doc(id));
        deleted += 1;
      }
      await batch.commit();
    }

    return deleted;
  }

  referenceFor(pathStr: string): unknown {
    return this.firestore.doc(pathStr);
  }
}

export function openFirestore(projectId: string, role: string): Firestore {
  const name = `full-mirror-${role}-${projectId}`;
  const existing = getApps().find((app: App) => app.name === name);
  const app = existing ?? initializeApp({ projectId }, name);
  const firestore = getFirestore(app);
  const resolved = firestoreProjectId(firestore);

  if (resolved && resolved !== projectId) {
    throw new Error(
      `firestore project mismatch for ${role}: expected ${projectId}, got ${resolved}`
    );
  }

  return firestore;
}

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

  const dimSet = new Set<number>();
  for (const doc of docs) {
    for (const d of extractVectorDimensions(doc)) {
      dimSet.add(d);
    }
  }

  return {
    path: collectionId,
    id: collectionId,
    document_count: docs.length,
    ndjson: fileName,
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: computeSha256(body),
    vector_dimensions: Array.from(dimSet).sort((a, b) => a - b)
  };
}

export async function clearCollection(
  firestore: Firestore,
  collectionId: string
): Promise<number> {
  assertWritableProject(firestoreProjectId(firestore));
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
  assertWritableProject(firestoreProjectId(firestore));
  let written = 0;
  const collection = firestore.collection(collectionId);

  for (let offset = 0; offset < docs.length; offset += WRITE_BATCH_LIMIT) {
    const chunk = docs.slice(offset, offset + WRITE_BATCH_LIMIT);
    const batch = firestore.batch();
    for (const encoded of chunk) {
      const { id, data } = decodeDocument(encoded, p => firestore.doc(p));
      batch.set(collection.doc(id), data);
      written += 1;
    }
    await batch.commit();
  }

  return written;
}

export async function pruneAbsentDocuments(
  firestore: Firestore,
  collectionId: string,
  keepIds: ReadonlySet<string>
): Promise<number> {
  assertWritableProject(firestoreProjectId(firestore));
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

  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8")
  ) as Record<string, unknown>;

  if (manifest.schema !== MANIFEST_SCHEMA && manifest.schema !== MANIFEST_SCHEMA_V1) {
    throw new Error(
      `unsupported manifest schema ${String(manifest.schema)}; expected ${MANIFEST_SCHEMA}`
    );
  }

  if (!Array.isArray(manifest.collections) || manifest.collections.length === 0) {
    throw new Error("manifest collections must be a non-empty array");
  }

  if (manifest.schema === MANIFEST_SCHEMA_V1) {
    const rawCollections = manifest.collections as Array<{
      id: string;
      document_count: number;
      ndjson: string;
      bytes: number;
    }>;
    const collections: FullBackupCollectionEntry[] = rawCollections.map(c => ({
      path: c.id,
      id: c.id,
      document_count: c.document_count,
      ndjson: c.ndjson,
      bytes: c.bytes,
      sha256: "",
      vector_dimensions: []
    }));
    const collectionPaths = collections.map(c => c.path);
    return {
      schema: MANIFEST_SCHEMA_V1,
      source_project: String(manifest.source_project),
      generated_at: String(manifest.generated_at),
      generated_at_ms: Number(manifest.generated_at_ms),
      discovery: "listCollections()",
      embedding: null,
      collection_paths: collectionPaths,
      collections,
      legacy: true,
      collection_ids: collectionPaths
    };
  }

  return manifest as unknown as FullBackupManifest;
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
    throw new Error(
      `missing archive file ${entry.ndjson} for collection ${entry.path ?? entry.id}`
    );
  }
  const docs = parseNdjson(fs.readFileSync(filePath, "utf8"));
  if (docs.length !== entry.document_count) {
    throw new Error(
      `${entry.ndjson} has ${docs.length} documents but manifest records ${entry.document_count}`
    );
  }
  return docs;
}

export function validateArchive(archiveDir: string): ValidatedArchive {
  const problems: string[] = [];

  let manifest: FullBackupManifest;
  try {
    manifest = readManifest(archiveDir);
  } catch (error) {
    throw new ArchiveValidationError([(error as Error).message]);
  }

  if (
    !Array.isArray(manifest.collection_paths) ||
    manifest.collection_paths.length !== manifest.collections.length ||
    manifest.collection_paths.some((p, i) => p !== manifest.collections[i].path)
  ) {
    problems.push("manifest collection_paths does not match collections[].path order");
  }

  const seenPaths = new Set<string>();
  for (const entry of manifest.collections) {
    if (seenPaths.has(entry.path)) {
      problems.push(`duplicate collection path: ${entry.path}`);
    } else {
      seenPaths.add(entry.path);
    }

    if (!isValidCollectionPath(entry.path)) {
      problems.push(
        `invalid collection path (even path segments or empty segments not allowed): ${entry.path}`
      );
    }
  }

  const validatedCollections: ValidatedArchiveCollection[] = [];
  const placeholderResolver = (targetPath: string): unknown => ({
    __type: "DocumentReferencePlaceholder",
    path: targetPath
  });

  for (const entry of manifest.collections) {
    const expectedFileName = ndjsonFileName(entry.path);
    if (entry.ndjson !== expectedFileName) {
      problems.push(
        `ndjson file name mismatch for ${entry.path}: expected ${expectedFileName}, got ${entry.ndjson}`
      );
    }

    const filePath = path.join(archiveDir, entry.ndjson);
    if (!fs.existsSync(filePath)) {
      problems.push(`missing ndjson file for ${entry.path}: ${entry.ndjson}`);
      continue;
    }

    const fileBytes = fs.readFileSync(filePath);
    const computedSha = computeSha256(fileBytes);

    if (manifest.legacy) {
      entry.sha256 = computedSha;
    } else if (computedSha !== entry.sha256) {
      problems.push(
        `sha256 mismatch for ${entry.path}: file has ${computedSha}, manifest records ${entry.sha256}`
      );
    }

    const docs = parseNdjsonLines(fileBytes.toString("utf8"), entry.ndjson, problems);

    if (docs.length !== entry.document_count) {
      problems.push(
        `document count mismatch for ${entry.path}: line count ${docs.length} != document_count ${entry.document_count}`
      );
    }

    const seenIds = new Set<string>();
    const observedDimensionsSet = new Set<number>();

    for (const doc of docs) {
      const id = doc[DOCUMENT_ID_FIELD];
      if (typeof id !== "string" || id.trim().length === 0) {
        problems.push(`document missing non-empty string _id in ${entry.path}`);
      } else if (seenIds.has(id)) {
        problems.push(`duplicate _id in ${entry.path}: ${id}`);
      } else {
        seenIds.add(id);
      }

      try {
        decodeDocument(doc, placeholderResolver);
      } catch (error) {
        const msg = (error as Error).message;
        if (msg.includes("unknown __fs tag")) {
          problems.push(`unknown __fs tag in document ${String(id)} in ${entry.path}: ${msg}`);
        } else {
          problems.push(`malformed tag or value in document ${String(id)} in ${entry.path}: ${msg}`);
        }
      }

      for (const dim of extractVectorDimensions(doc)) {
        observedDimensionsSet.add(dim);
      }
    }

    const observedDimensions = Array.from(observedDimensionsSet).sort((a, b) => a - b);
    if (manifest.legacy) {
      entry.vector_dimensions = observedDimensions;
    } else {
      const expectedDims = [...(entry.vector_dimensions ?? [])].sort((a, b) => a - b);
      if (
        observedDimensions.length !== expectedDims.length ||
        observedDimensions.some((d, idx) => d !== expectedDims[idx])
      ) {
        problems.push(
          `vector dimension disagreeing with the manifest for ${entry.path}: observed [${observedDimensions.join(
            ","
          )}], manifest records [${expectedDims.join(",")}]`
        );
      }
    }

    if (manifest.embedding) {
      for (const dim of observedDimensions) {
        if (dim !== manifest.embedding.dimensions) {
          problems.push(
            `vector dimension ${dim} in ${entry.path} disagrees with manifest embedding dimension ${manifest.embedding.dimensions}`
          );
        }
      }
    }

    validatedCollections.push({ entry, docs });
  }

  if (problems.length > 0) {
    throw new ArchiveValidationError(problems);
  }

  return {
    manifest,
    collections: validatedCollections
  };
}

export async function verifyRestore(
  target: MirrorStore,
  archiveDir: string,
  options?: {
    targetPrefix?: string;
    prune?: boolean;
    onProgress?: (message: string) => void;
  }
): Promise<RestoreReport> {
  const validated = validateArchive(archiveDir);
  const manifest = validated.manifest;
  const verificationFailures: string[] = [];
  const finalReports: RestoreCollectionReport[] = [];

  for (const { entry, docs } of validated.collections) {
    options?.onProgress?.(`verifying ${entry.path}`);
    const targetPath = resolveTargetPath(entry.path, options?.targetPrefix);
    const targetDocs = await target.readCollection(targetPath);

    const targetEncoded = targetDocs.map(d => encodeDocument(d.id, d.data));
    targetEncoded.sort((a, b) =>
      String(a[DOCUMENT_ID_FIELD]).localeCompare(String(b[DOCUMENT_ID_FIELD]))
    );

    const targetDocMap = new Map<string, Record<string, unknown>>();
    for (const d of targetEncoded) {
      targetDocMap.set(String(d[DOCUMENT_ID_FIELD]), d);
    }

    const archiveDocMap = new Map<string, Record<string, unknown>>();
    for (const d of docs) {
      archiveDocMap.set(String(d[DOCUMENT_ID_FIELD]), d);
    }

    const missing: string[] = [];
    const extra: string[] = [];
    const changed: string[] = [];

    for (const [id, archiveDoc] of archiveDocMap.entries()) {
      const targetDoc = targetDocMap.get(id);
      if (!targetDoc) {
        missing.push(id);
      } else if (stableStringify(archiveDoc) !== stableStringify(targetDoc)) {
        changed.push(id);
      }
    }

    for (const id of targetDocMap.keys()) {
      if (!archiveDocMap.has(id)) {
        extra.push(id);
      }
    }

    const pruneRequested = Boolean(options?.prune);
    const extraDocsCount = pruneRequested ? undefined : extra.length;

    if (pruneRequested && extra.length > 0) {
      const capped = extra.slice(0, 20);
      verificationFailures.push(
        `collection ${entry.path}: target has ${extra.length} extra document(s) after prune: ${capped.join(", ")}`
      );
    }

    if (missing.length > 0) {
      const capped = missing.slice(0, 20);
      verificationFailures.push(
        `collection ${entry.path}: target is missing ${missing.length} document(s): ${capped.join(", ")}`
      );
    }

    if (changed.length > 0) {
      const capped = changed.slice(0, 20);
      verificationFailures.push(
        `collection ${entry.path}: target has ${changed.length} changed document(s): ${capped.join(", ")}`
      );
    }

    if (!manifest.legacy) {
      if (pruneRequested) {
        const targetSha = computeSha256(serializeNdjson(targetEncoded));
        if (targetSha !== entry.sha256) {
          verificationFailures.push(
            `collection ${entry.path}: content sha256 mismatch (target: ${targetSha}, archive: ${entry.sha256})`
          );
        }
      } else {
        const subsetDocs = targetEncoded.filter(d =>
          archiveDocMap.has(String(d[DOCUMENT_ID_FIELD]))
        );
        const subsetSha = computeSha256(serializeNdjson(subsetDocs));
        if (subsetSha !== entry.sha256) {
          verificationFailures.push(
            `collection ${entry.path}: content sha256 mismatch on archive subset (target: ${subsetSha}, archive: ${entry.sha256})`
          );
        }
      }
    }

    finalReports.push({
      path: entry.path,
      target_path: targetPath,
      archive_count: entry.document_count,
      target_count_before: null,
      written: docs.length,
      deleted: 0,
      pruned: 0,
      extra_target_docs: extraDocsCount,
      status: "verified"
    });
  }

  if (verificationFailures.length > 0) {
    throw new RestoreVerificationError(
      `Content verification failed:\n- ${verificationFailures.join("\n- ")}`,
      finalReports
    );
  }

  return {
    complete: true,
    collections: finalReports
  };
}

export async function restoreArchive(
  target: MirrorStore,
  archiveDir: string,
  options: RestoreOptions
): Promise<RestoreReport> {
  const validated: ValidatedArchive = validateArchive(archiveDir);
  const manifest = validated.manifest;
  const sourceProject = options.sourceProjectOverride ?? manifest.source_project;

  if (options.write) {
    assertWritableProject(target.projectId);
  }

  const hasConfirmation = options.replace?.confirmProject === target.projectId;
  const isSameProject = target.projectId === sourceProject;
  if (isSameProject && !options.targetPrefix && !hasConfirmation) {
    throw new RestoreTargetError(
      "target project equals the archive source project; restore into a different project, pass --target-prefix, or use explicit replacement (--prune/--clear-target-collections with --confirm-project <target>)"
    );
  }

  const isReplacementRequested = Boolean(
    options.replace?.prune || options.replace?.clearTarget
  );
  if (isReplacementRequested && !hasConfirmation) {
    throw new RestoreTargetError(
      "replacement requires --confirm-project <target project id>"
    );
  }

  const hasVectors = validated.collections.some(
    c => c.entry.vector_dimensions && c.entry.vector_dimensions.length > 0
  );

  if (hasVectors) {
    if (!manifest.embedding) {
      if (!options.acceptUnknownEmbeddingSpace) {
        throw new IncompatibleVectorsError(
          "archive embedding space is unknown (legacy v1 manifest). Pass --accept-unknown-embedding-space or use the portable import (npm run restore:memories) which re-embeds into a separate collection"
        );
      }
    } else {
      if (!options.targetEmbedding) {
        throw new IncompatibleVectorsError(
          `target embedding space is null while archive contains vectors (${manifest.embedding.model}/${manifest.embedding.dimensions}d); do not import these vectors. Use the portable import (npm run restore:memories) which re-embeds into a separate collection`
        );
      }

      if (
        manifest.embedding.model !== options.targetEmbedding.model ||
        manifest.embedding.dimensions !== options.targetEmbedding.dimensions
      ) {
        throw new IncompatibleVectorsError(
          `archive embedding space (${manifest.embedding.model}/${manifest.embedding.dimensions}d) differs from target embedding space (${options.targetEmbedding.model}/${options.targetEmbedding.dimensions}d); do not import these vectors. Use the portable import (npm run restore:memories) which re-embeds into a separate collection`
        );
      }
    }
  }

  if (!options.write) {
    const plannedReports: RestoreCollectionReport[] = [];
    for (const { entry } of validated.collections) {
      const targetPath = resolveTargetPath(entry.path, options.targetPrefix);
      const before = await target.countDocuments(targetPath);
      plannedReports.push({
        path: entry.path,
        target_path: targetPath,
        archive_count: entry.document_count,
        target_count_before: before,
        written: 0,
        deleted: 0,
        pruned: 0,
        status: "planned"
      });
    }
    return {
      complete: false,
      collections: plannedReports
    };
  }

  const reportMap = new Map<string, RestoreCollectionReport>();
  const completedCollections: string[] = [];

  try {
    for (const { entry, docs } of validated.collections) {
      options.onProgress?.(`writing ${entry.path}`);
      const targetPath = resolveTargetPath(entry.path, options.targetPrefix);
      const beforeCount = await target.countDocuments(targetPath);

      let deleted = 0;
      if (options.replace?.clearTarget) {
        const existingIds = await target.listDocumentIds(targetPath);
        deleted = await target.deleteDocuments(targetPath, existingIds);
      }

      const mirrorDocs: MirrorDocument[] = docs.map(rawDoc => {
        const decoded = decodeDocument(rawDoc, p => target.referenceFor(p));
        return { id: decoded.id, data: decoded.data };
      });

      const written = await target.writeDocuments(targetPath, mirrorDocs);

      let pruned = 0;
      if (options.replace?.prune && !options.replace?.clearTarget) {
        const archiveIdSet = new Set(docs.map(d => String(d[DOCUMENT_ID_FIELD])));
        const existingIds = await target.listDocumentIds(targetPath);
        const toPrune = existingIds.filter(id => !archiveIdSet.has(id));
        if (toPrune.length > 0) {
          pruned = await target.deleteDocuments(targetPath, toPrune);
        }
      }

      completedCollections.push(entry.path);
      reportMap.set(entry.path, {
        path: entry.path,
        target_path: targetPath,
        archive_count: entry.document_count,
        target_count_before: beforeCount,
        written,
        deleted: deleted + pruned,
        pruned,
        status: "written"
      });
    }
  } catch (error) {
    const err = error as Error;
    const partialReports = Array.from(reportMap.values());
    throw new RestoreIncompleteError(
      `RESTORE INCOMPLETE: ${err.message}. re-run the same command to finish; upserts are idempotent`,
      partialReports,
      completedCollections
    );
  }

  const verifiedReport = await verifyRestore(target, archiveDir, {
    targetPrefix: options.targetPrefix,
    prune: isReplacementRequested,
    onProgress: options.onProgress
  });

  const mergedCollections: RestoreCollectionReport[] = verifiedReport.collections.map(vc => {
    const writeReport = reportMap.get(vc.path);
    return {
      ...vc,
      target_count_before: writeReport?.target_count_before ?? null,
      written: writeReport?.written ?? vc.written,
      deleted: writeReport?.deleted ?? vc.deleted,
      pruned: writeReport?.pruned ?? vc.pruned
    };
  });

  return {
    complete: true,
    collections: mergedCollections
  };
}

export async function backupToArchive(
  store: MirrorStore,
  archiveDir: string,
  opts: {
    embedding: { model: string; dimensions: number } | null;
    now?: () => Date;
    dryRun?: boolean;
  }
): Promise<FullBackupManifest> {
  const collectionPaths = await store.discoverCollectionPaths();
  if (collectionPaths.length === 0) {
    throw new Error("refusing backup: discovered zero collections");
  }

  const collections: FullBackupCollectionEntry[] = [];
  const encodedCollections: Array<{ entry: FullBackupCollectionEntry; body: string }> = [];

  for (const collectionPath of collectionPaths) {
    const docs = await store.readCollection(collectionPath);
    const liveCount = await store.countDocuments(collectionPath);
    if (docs.length !== liveCount) {
      throw new Error(
        `dump/count mismatch for ${collectionPath}: dumped ${docs.length} counted ${liveCount}`
      );
    }

    const encodedDocs = docs
      .map(doc => encodeDocument(doc.id, doc.data))
      .sort((left, right) =>
        String(left[DOCUMENT_ID_FIELD]).localeCompare(String(right[DOCUMENT_ID_FIELD]))
      );

    const dimSet = new Set<number>();
    for (const d of encodedDocs) {
      for (const dim of extractVectorDimensions(d)) {
        dimSet.add(dim);
      }
    }
    const vectorDimensions = Array.from(dimSet).sort((a, b) => a - b);
    const fileName = ndjsonFileName(collectionPath);
    const body = serializeNdjson(encodedDocs);
    const sha256 = computeSha256(body);
    const bytes = Buffer.byteLength(body, "utf8");

    const entry: FullBackupCollectionEntry = {
      path: collectionPath,
      id: collectionPath,
      document_count: encodedDocs.length,
      ndjson: fileName,
      bytes,
      sha256,
      vector_dimensions: vectorDimensions
    };

    collections.push(entry);
    encodedCollections.push({ entry, body });
  }

  const hasVectors = collections.some(c => c.vector_dimensions.length > 0);
  if (hasVectors && !opts.embedding) {
    throw new Error(
      "archive contains vectors but no embedding configuration was provided"
    );
  }

  const embedding = hasVectors ? opts.embedding : null;
  const now = opts.now ? opts.now() : new Date();

  const manifest: FullBackupManifest = {
    schema: MANIFEST_SCHEMA,
    source_project: store.projectId,
    generated_at: now.toISOString(),
    generated_at_ms: now.getTime(),
    discovery: "recursive-listCollections",
    embedding,
    collection_paths: collectionPaths,
    collections,
    collection_ids: collectionPaths
  };

  if (opts.dryRun) {
    return manifest;
  }

  fs.mkdirSync(archiveDir, { recursive: true });
  for (const { entry, body } of encodedCollections) {
    fs.writeFileSync(path.join(archiveDir, entry.ndjson), body, "utf8");
  }

  writeManifest(archiveDir, manifest);
  removeStaleNdjsonFiles(archiveDir, collectionPaths);

  return manifest;
}
