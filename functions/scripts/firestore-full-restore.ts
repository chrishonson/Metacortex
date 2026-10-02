import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvironment, readArg } from "./support/cli.js";
import {
  assertWritableProject,
  clearCollection,
  countDocuments,
  firestoreProjectId,
  encodedDocumentIds,
  loadArchiveCollection,
  openFirestore,
  pruneAbsentDocuments,
  readManifest,
  writeDocuments
} from "./support/firestore-full-mirror.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const functionsDirectory = path.resolve(scriptDirectory, "..");

loadEnvironment(functionsDirectory);

const args = process.argv.slice(2);
const write = args.includes("--write");
const clearTarget = args.includes("--clear-target-collections");
const projectId = readArg(args, "project");
const archiveDir = readArg(args, "archive-dir") ?? process.env.METACORTEX_ARCHIVE_DIR;

if (!projectId) {
  console.error(
    "usage: firestore-full-restore --project <id> --archive-dir <path> [--write] [--clear-target-collections]"
  );
  console.error("--write converges by default (upsert + prune). --clear-target-collections is an optional wipe first.");
  process.exit(1);
}

if (!archiveDir) {
  console.error("pass --archive-dir or set METACORTEX_ARCHIVE_DIR");
  process.exit(1);
}

assertWritableProject(projectId);

const manifest = readManifest(archiveDir);
const collectionIds = manifest.collection_ids;
if (
  collectionIds.length !== manifest.collections.length ||
  collectionIds.some((id, index) => id !== manifest.collections[index].id)
) {
  console.error("manifest collection_ids does not match collections[].id order");
  process.exit(1);
}

console.log(`target: ${projectId}`);
console.log(`archive: ${archiveDir}`);
console.log(`source_project: ${manifest.source_project}`);
console.log(`mode: ${write ? "write" : "dry-run"}`);
console.log("converge: upsert+prune");
console.log(
  `clear_target_collections: ${clearTarget}${clearTarget ? " (wipe then upsert; prune skipped)" : ""}`
);
console.log("inventory: archive manifest (produced by listCollections() on source)");
console.log("absent_archive_collections: left on target (not deleted)");
console.log(`collections: ${JSON.stringify(collectionIds)}`);

const firestore = write ? openFirestore(projectId, "restore-target") : undefined;
if (firestore) {
  assertWritableProject(firestoreProjectId(firestore));
}

const report: Array<{
  id: string;
  archive_count: number;
  target_count_before: number | null;
  pruned: number;
  deleted: number;
  written: number;
  target_count_after: number | null;
}> = [];

for (const entry of manifest.collections) {
  const docs = loadArchiveCollection(archiveDir, entry);
  const keepIds = encodedDocumentIds(docs);
  const before = firestore ? await countDocuments(firestore, entry.id) : null;
  console.log(
    `plan ${entry.id} archive=${entry.document_count} target_before=${before ?? "n/a"}`
  );

  let pruned = 0;
  let deleted = 0;
  let written = 0;
  let after: number | null = null;

  if (write && firestore) {
    if (clearTarget) {
      deleted = await clearCollection(firestore, entry.id);
      console.log(`cleared ${projectId}/${entry.id} deleted=${deleted}`);
    } else {
      pruned = await pruneAbsentDocuments(firestore, entry.id, keepIds);
      deleted = pruned;
      console.log(`pruned ${projectId}/${entry.id} extra_ids=${pruned}`);
    }
    written = await writeDocuments(firestore, entry.id, docs);
    after = await countDocuments(firestore, entry.id);
    console.log(`upserted ${projectId}/${entry.id} written=${written} count=${after}`);
    if (after !== entry.document_count) {
      console.error(
        `restore count mismatch for ${entry.id}: target ${after} != archive ${entry.document_count}`
      );
      process.exit(1);
    }
  }

  report.push({
    id: entry.id,
    archive_count: entry.document_count,
    target_count_before: before,
    pruned,
    deleted,
    written,
    target_count_after: after
  });
}

console.log(JSON.stringify({ converge: "upsert+prune", collections: report }, null, 2));

if (!write) {
  console.log("Dry run complete. Re-run with --write to restore.");
  process.exit(0);
}

console.log(`collections_restored=${report.length}`);
