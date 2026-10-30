import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { loadEnvironment, readArg } from "./support/cli.js";
import {
  backupToArchive,
  firestoreProjectId,
  FirestoreMirrorStore,
  openFirestore
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

const config = loadConfig(process.env);
const firestore = openFirestore(projectId, "backup-source");
const store = new FirestoreMirrorStore(firestore);

console.log(`project: ${firestoreProjectId(firestore)}`);
console.log(`archive: ${archiveDir}`);
console.log(`mode: ${dryRun ? "dry-run" : "write"}`);
console.log("discovery: recursive-listCollections");
console.log("snapshot: full rewrite (not incremental)");

try {
  const manifest = await backupToArchive(store, archiveDir, {
    embedding: {
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions
    },
    dryRun
  });

  console.log(`collections discovered: ${manifest.collection_paths.length}`);
  console.log(JSON.stringify(manifest.collection_paths));

  for (const col of manifest.collections) {
    console.log(
      `dumped ${col.path} documents=${col.document_count} bytes=${col.bytes} file=${col.ndjson}`
    );
  }

  if (dryRun) {
    console.log("Dry run complete. Nothing written.");
    process.exit(0);
  }

  console.log(`wrote ${path.join(archiveDir, "manifest.json")}`);
  console.log(`collections_backed_up=${manifest.collections.length}`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
