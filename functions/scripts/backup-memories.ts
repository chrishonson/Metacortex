import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  buildManifest,
  checkTruncation,
  serializeArchive,
  type ArchiveManifest
} from "../src/archive.js";
import { readMemoriesForArchive } from "../src/archiveFirestore.js";
import { loadEnvironment, readArg, readFirebaseProject } from "./support/cli.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const functionsDirectory = path.resolve(scriptDirectory, "..");
const repoRoot = path.resolve(functionsDirectory, "..");

loadEnvironment(functionsDirectory);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const noPush = args.includes("--no-push");
const archiveDir =
  readArg(args, "archive-dir") ?? process.env.METACORTEX_ARCHIVE_DIR;
const projectId =
  readArg(args, "project") ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.GCLOUD_PROJECT ??
  readFirebaseProject(repoRoot) ??
  "my-brain-88870";
const collectionName =
  readArg(args, "memory-collection") ??
  process.env.MEMORY_COLLECTION?.trim() ??
  "memory_vectors";
const embeddingModel =
  process.env.GEMINI_EMBEDDING_MODEL?.trim() || "text-embedding-004";
const embeddingDimensions = Number.parseInt(
  process.env.GEMINI_EMBEDDING_DIMENSIONS?.trim() || "768",
  10
);

if (!archiveDir) {
  console.error(
    "METACORTEX_ARCHIVE_DIR is not set. Point it at your private archive repository, or pass --archive-dir."
  );
  process.exit(1);
}

if (!fs.existsSync(archiveDir)) {
  console.error(`archive directory does not exist: ${archiveDir}`);
  process.exit(1);
}

const archivePath = path.join(archiveDir, "memories.ndjson");
const manifestPath = path.join(archiveDir, "manifest.json");

const app = getApps().length === 0 ? initializeApp({ projectId }) : getApp();
const firestore = getFirestore(app);

console.log(`project: ${projectId}`);
console.log(`collection: ${collectionName}`);
console.log(`archive: ${archiveDir}`);
console.log(`mode: ${dryRun ? "dry-run" : "write"}`);

const memories = await readMemoriesForArchive(firestore, collectionName);
const previousManifest = readManifest(manifestPath);
const verdict = checkTruncation(previousManifest?.document_count, memories.length);

console.log(
  `documents: ${memories.length}` +
    (previousManifest ? ` (previous: ${previousManifest.document_count})` : "")
);

if (!verdict.allowed && !force) {
  console.error(`refusing to write: ${verdict.reason}`);
  process.exit(1);
}

if (!verdict.allowed) {
  console.warn(`--force overriding guardrail: ${verdict.reason}`);
}

const manifest = buildManifest({
  memories,
  generatedAt: Date.now(),
  projectId,
  collection: collectionName,
  embeddingModel,
  embeddingDimensions
});

console.log(`states: ${JSON.stringify(manifest.state_histogram)}`);

if (dryRun) {
  console.log("Dry run complete. Nothing written.");
  process.exit(0);
}

fs.writeFileSync(archivePath, serializeArchive(memories), "utf8");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const status = git(["status", "--porcelain"], archiveDir).trim();

if (!status) {
  console.log("Archive unchanged; nothing to commit.");
  process.exit(0);
}

git(["add", "memories.ndjson", "manifest.json"], archiveDir);
git(
  [
    "commit",
    "-m",
    `chore(archive): ${manifest.document_count} memories from ${collectionName}`
  ],
  archiveDir
);

if (noPush) {
  console.log("Committed. Skipping push (--no-push).");
  process.exit(0);
}

git(["push"], archiveDir);
console.log("Committed and pushed.");

function git(gitArgs: string[], cwd: string): string {
  return execFileSync("git", gitArgs, { cwd, encoding: "utf8" });
}

function readManifest(filePath: string): ArchiveManifest | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as ArchiveManifest;
}
