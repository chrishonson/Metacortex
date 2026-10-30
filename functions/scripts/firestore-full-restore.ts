import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { loadEnvironment, readArg } from "./support/cli.js";
import {
  ArchiveValidationError,
  FirestoreMirrorStore,
  IncompatibleVectorsError,
  openFirestore,
  restoreArchive,
  RestoreIncompleteError,
  RestoreTargetError,
  RestoreVerificationError
} from "./support/firestore-full-mirror.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const functionsDirectory = path.resolve(scriptDirectory, "..");

loadEnvironment(functionsDirectory);

const args = process.argv.slice(2);
const write = args.includes("--write");
const prune = args.includes("--prune");
const clearTarget = args.includes("--clear-target-collections");
const acceptUnknownEmbeddingSpace = args.includes("--accept-unknown-embedding-space");

const projectId = readArg(args, "project");
const archiveDir = readArg(args, "archive-dir") ?? process.env.METACORTEX_ARCHIVE_DIR;
const targetPrefix = readArg(args, "target-prefix");
const confirmProject = readArg(args, "confirm-project");

if (!projectId) {
  console.error(
    "usage: firestore-full-restore --project <id> --archive-dir <path> [--write] [--target-prefix <p>] [--prune] [--clear-target-collections] [--confirm-project <id>] [--accept-unknown-embedding-space]"
  );
  console.error("Dry-run by default. Pass --write to execute upsert. --prune or --clear-target-collections requires --confirm-project <id>.");
  process.exit(1);
}

if (!archiveDir) {
  console.error("pass --archive-dir or set METACORTEX_ARCHIVE_DIR");
  process.exit(1);
}

const config = loadConfig(process.env);
const firestore = openFirestore(projectId, "restore-target");
const store = new FirestoreMirrorStore(firestore);

console.log(`target: ${projectId}`);
console.log(`archive: ${archiveDir}`);
console.log(`mode: ${write ? "write" : "dry-run"}`);
if (targetPrefix) {
  console.log(`target_prefix: ${targetPrefix}`);
}
console.log(`prune: ${prune}`);
console.log(`clear_target: ${clearTarget}`);

try {
  const result = await restoreArchive(store, archiveDir, {
    write,
    targetPrefix,
    replace: {
      prune,
      clearTarget,
      confirmProject
    },
    targetEmbedding: {
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions
    },
    acceptUnknownEmbeddingSpace,
    onProgress: (msg: string) => console.log(msg)
  });

  console.log(JSON.stringify(result, null, 2));

  if (!write) {
    console.log("Dry run complete. Re-run with --write to restore.");
    process.exit(0);
  }

  console.log(`restore_complete=true collections=${result.collections.length}`);
} catch (error) {
  if (
    error instanceof RestoreIncompleteError ||
    error instanceof RestoreVerificationError ||
    error instanceof RestoreTargetError ||
    error instanceof IncompatibleVectorsError ||
    error instanceof ArchiveValidationError
  ) {
    console.error(error.message);
  } else {
    console.error(`Restore error: ${(error as Error).message}`);
  }
  process.exit(1);
}
