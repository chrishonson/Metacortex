import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  describeEmbeddingMismatch,
  parseArchive,
  restoreMemories,
  type ArchiveManifest,
  type ArchivedMemory,
  type RestoreTarget
} from "../src/archive.js";
import { FirestoreRestoreTarget } from "../src/archiveFirestore.js";
import { loadConfig } from "../src/config.js";
import { GeminiEmbeddingClient } from "../src/embeddings.js";
import { loadEnvironment, readArg, readFirebaseProject } from "./support/cli.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const functionsDirectory = path.resolve(scriptDirectory, "..");
const repoRoot = path.resolve(functionsDirectory, "..");

loadEnvironment(functionsDirectory);

const args = process.argv.slice(2);
const write = args.includes("--write");
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

const config = loadConfig(process.env);
const memories = parseArchive(
  fs.readFileSync(path.join(archiveDir, "memories.ndjson"), "utf8")
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(archiveDir, "manifest.json"), "utf8")
) as ArchiveManifest;

console.log(`archive: ${archiveDir}`);
console.log(`archived at: ${new Date(manifest.generated_at).toISOString()}`);
console.log(`documents: ${memories.length}`);
console.log(`target: ${projectId}/${targetCollection}`);
console.log(`mode: ${write ? "write" : "dry-run"}`);

if (memories.length !== manifest.document_count) {
  console.warn(
    `warning: archive holds ${memories.length} documents but the manifest records ${manifest.document_count}`
  );
}

const mismatch = describeEmbeddingMismatch(manifest, {
  embeddingModel: config.embeddingModel,
  embeddingDimensions: config.embeddingDimensions
});

if (mismatch) {
  console.warn(`warning: ${mismatch}`);
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
  }
});

console.log(`Restored ${result.restored} documents into ${targetCollection}.`);
