import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  describeEmbeddingMismatch,
  parseArchive,
  restoreMemories,
  validatePortableArchive,
  type ArchiveManifest,
  type ArchivedMemory,
  type RestoreTarget
} from "../src/archive.js";
import { FirestoreRestoreTarget } from "../src/archiveFirestore.js";
import { loadConfig } from "../src/config.js";
import { GeminiEmbeddingClient } from "../src/embeddings.js";
import { loadEnvironment, readArg, readFirebaseProject } from "./support/cli.js";
import { assertWritableProject } from "./support/firestore-full-mirror.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const functionsDirectory = path.resolve(scriptDirectory, "..");
const repoRoot = path.resolve(functionsDirectory, "..");

loadEnvironment(functionsDirectory);

const args = process.argv.slice(2);
const write = args.includes("--write");
const replaceLive = args.includes("--replace-live");
const confirmCollection = readArg(args, "confirm-collection");
const archiveDir =
  readArg(args, "archive-dir") ?? process.env.METACORTEX_ARCHIVE_DIR;
const projectId =
  readArg(args, "project") ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.GCLOUD_PROJECT ??
  readFirebaseProject(repoRoot) ??
  "my-brain-88870";
const targetCollection = readArg(args, "collection");

if (!archiveDir) {
  console.error("METACORTEX_ARCHIVE_DIR is not set. Pass --archive-dir.");
  process.exit(1);
}

if (!targetCollection) {
  console.error(
    "--collection is required. Restore into a scratch collection first and diff it before touching memory_vectors."
  );
  process.exit(1);
}

const manifestPath = path.join(archiveDir, "manifest.json");
const memoriesPath = path.join(archiveDir, "memories.ndjson");

if (!fs.existsSync(manifestPath) || !fs.existsSync(memoriesPath)) {
  console.error(`missing manifest.json or memories.ndjson in ${archiveDir}`);
  process.exit(1);
}

let manifest: ArchiveManifest;
let memories: ArchivedMemory[];

try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ArchiveManifest;
  memories = parseArchive(fs.readFileSync(memoriesPath, "utf8"));
} catch (error) {
  console.error(`archive is malformed: ${(error as Error).message}`);
  process.exit(1);
}

// Validate the whole archive BEFORE any Firestore access, in dry-run and write mode
const problems = validatePortableArchive(memories, manifest);
if (problems.length > 0) {
  console.error("archive failed validation:\n- " + problems.join("\n- "));
  process.exit(1);
}

const config = loadConfig(process.env);
const liveCollectionName = config.memoryCollection || "memory_vectors";

// Target guards: refuse prod project and refuse live collection unless confirmed
if (write) {
  try {
    assertWritableProject(projectId);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  if (targetCollection === liveCollectionName) {
    if (!replaceLive || confirmCollection !== targetCollection) {
      console.error(
        `refusing write to live collection ${liveCollectionName}; pass --replace-live and --confirm-collection ${liveCollectionName}`
      );
      process.exit(1);
    }
  }
}

console.log(`archive: ${archiveDir}`);
console.log(`archived at: ${new Date(manifest.generated_at).toISOString()}`);
console.log(`documents: ${memories.length}`);
console.log(`target: ${projectId}/${targetCollection}`);
console.log(`mode: ${write ? "write" : "dry-run"}`);

const mismatch = describeEmbeddingMismatch(manifest, {
  embeddingModel: config.embeddingModel,
  embeddingDimensions: config.embeddingDimensions
});

if (mismatch) {
  console.warn(
    `warning: ${mismatch}; portable import re-embeds with the current model`
  );
}

if (!write) {
  console.log("Dry run complete. Re-run with --write to restore.");
  process.exit(0);
}

const app = getApps().length === 0 ? initializeApp({ projectId }) : getApp();
const firestore = getFirestore(app);
const embeddings = new GeminiEmbeddingClient({
  apiKey: config.geminiApiKey,
  model: config.embeddingModel,
  dimensions: config.embeddingDimensions
});
const target: RestoreTarget = new FirestoreRestoreTarget(
  firestore,
  targetCollection
);

let completed = 0;

try {
  const result = await restoreMemories({
    memories,
    embeddings,
    target: {
      async writeMemory(memory: ArchivedMemory, embedding: number[]) {
        await target.writeMemory(memory, embedding);
        completed += 1;

        if (completed % 25 === 0) {
          console.log(`restored ${completed}/${memories.length}`);
        }
      }
    },
    manifest
  });

  console.log(`Restored ${result.restored} documents into ${targetCollection}.`);
} catch (error) {
  console.error(
    `Restored ${completed} so far. RESTORE INCOMPLETE; re-run to finish (writes are idempotent by document id): ${(error as Error).message}`
  );
  process.exit(1);
}
