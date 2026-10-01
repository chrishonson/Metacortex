import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvironment, readArg } from "./support/cli.js";
import {
  countDocuments,
  dumpCollection,
  listCollectionIds,
  MANIFEST_SCHEMA,
  openFirestore,
  removeStaleNdjsonFiles,
  writeManifest,
  type FullBackupCollectionEntry
} from "./support/firestore-full-mirror.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const functionsDirectory = path.resolve(scriptDirectory, "..");

loadEnvironment(functionsDirectory);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectId = readArg(args, "project");
const archiveDir = readArg(args, "archive-dir") ?? process.env.METACORTEX_ARCHIVE_DIR;

if (!projectId) {
  console.error("usage: firestore-full-backup --project <id> --archive-dir <path> [--dry-run]");
  process.exit(1);
}

if (!archiveDir) {
  console.error("pass --archive-dir or set METACORTEX_ARCHIVE_DIR");
  process.exit(1);
}

const firestore = openFirestore(projectId, "backup-source");

console.log(`project: ${firestore.projectId}`);
console.log(`archive: ${archiveDir}`);
console.log(`mode: ${dryRun ? "dry-run" : "write"}`);
console.log("discovery: listCollections()");
console.log("snapshot: full rewrite (not incremental)");

const collectionIds = await listCollectionIds(firestore);
console.log(`collections discovered: ${collectionIds.length}`);
console.log(JSON.stringify(collectionIds));

if (collectionIds.length === 0) {
  console.error("listCollections() returned no collections");
  process.exit(1);
}

if (!dryRun) {
  fs.mkdirSync(archiveDir, { recursive: true });
}

const collections: FullBackupCollectionEntry[] = [];

for (const collectionId of collectionIds) {
  const liveCount = await countDocuments(firestore, collectionId);
  console.log(`count ${projectId}/${collectionId}=${liveCount}`);

  if (dryRun) {
    collections.push({
      id: collectionId,
      document_count: liveCount,
      ndjson: `${collectionId}.ndjson`,
      bytes: 0
    });
    continue;
  }

  const entry = await dumpCollection(firestore, collectionId, archiveDir);
  if (entry.document_count !== liveCount) {
    console.error(
      `dump/count mismatch for ${collectionId}: dumped ${entry.document_count} counted ${liveCount}`
    );
    process.exit(1);
  }
  console.log(
    `dumped ${collectionId} documents=${entry.document_count} bytes=${entry.bytes} file=${entry.ndjson}`
  );
  collections.push(entry);
}

if (dryRun) {
  console.log("Dry run complete. Nothing written.");
  process.exit(0);
}

const stale = removeStaleNdjsonFiles(archiveDir, collectionIds);
if (stale.length > 0) {
  console.log(`removed stale ndjson: ${JSON.stringify(stale)}`);
}

const generatedAt = new Date();
writeManifest(archiveDir, {
  schema: MANIFEST_SCHEMA,
  source_project: projectId,
  generated_at: generatedAt.toISOString(),
  generated_at_ms: generatedAt.getTime(),
  discovery: "listCollections()",
  collection_ids: collectionIds,
  collections
});

console.log(`wrote ${path.join(archiveDir, "manifest.json")}`);
console.log(`collections_backed_up=${collections.length}`);
