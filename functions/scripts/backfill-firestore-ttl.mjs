import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(functionsDir, "..");
const explicitEnvKeys = new Set(Object.keys(process.env));
const loadedEnv = {};

for (const fileName of [".env", ".env.prod"]) {
  loadEnvFile(path.join(functionsDir, fileName), loadedEnv);
}

for (const [key, value] of Object.entries(loadedEnv)) {
  if (!explicitEnvKeys.has(key)) {
    process.env[key] = value;
  }
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const projectId =
  readArg("project") ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.GCLOUD_PROJECT ??
  readFirebaseProject(repoRoot) ??
  "my-brain-88870";
const memoryCollection =
  readArg("memory-collection") ??
  process.env.MEMORY_COLLECTION?.trim() ??
  "memory_vectors";
const batchSize = positiveInt(readArg("batch-size"), 250, "batch-size");

if (getApps().length === 0) {
  initializeApp({ projectId });
}

const firestore = getFirestore();
const fingerprintCollection = `${memoryCollection}_write_fingerprints`;

console.log(`project: ${projectId}`);
console.log(`mode: ${write ? "write" : "dry-run"}`);
console.log(`fingerprint collection: ${fingerprintCollection}`);
console.log("event collection: memory_events");

const fingerprintResult = await backfillFingerprints(
  firestore.collection(fingerprintCollection),
  batchSize,
  write
);
const eventResult = await backfillEvents(
  firestore.collection("memory_events"),
  batchSize,
  write
);

console.log("fingerprints:", fingerprintResult);
console.log("memory_events:", eventResult);

if (!write) {
  console.log("Dry run complete. Re-run with --write to apply updates.");
}

async function backfillFingerprints(collection, batchLimit, shouldWrite) {
  const snapshot = await collection.get();
  const updates = [];
  let skipped = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const update = {};
    const dedupeExpiresAt =
      typeof data.dedupe_expires_at === "number"
        ? data.dedupe_expires_at
        : typeof data.expires_at === "number"
          ? data.expires_at
          : undefined;
    const updatedAt =
      typeof data.updated_at === "number"
        ? data.updated_at
        : typeof dedupeExpiresAt === "number"
          ? dedupeExpiresAt - 15 * 60 * 1000
          : undefined;

    if (typeof dedupeExpiresAt === "number" && typeof data.dedupe_expires_at !== "number") {
      update.dedupe_expires_at = dedupeExpiresAt;
    }

    if (!hasFirestoreTimestamp(data.expires_at)) {
      if (typeof updatedAt !== "number") {
        skipped += 1;
        continue;
      }

      update.expires_at = new Date(updatedAt + 30 * 24 * 60 * 60 * 1000);
    }

    if (typeof data.updated_at !== "number" && typeof updatedAt === "number") {
      update.updated_at = updatedAt;
    }

    if (Object.keys(update).length > 0) {
      updates.push({ ref: doc.ref, update });
    }
  }

  if (shouldWrite) {
    await commitUpdates(updates, batchLimit);
  }

  return {
    scanned: snapshot.size,
    update_count: updates.length,
    skipped
  };
}

async function backfillEvents(collection, batchLimit, shouldWrite) {
  const snapshot = await collection.get();
  const updates = [];
  let skipped = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (hasFirestoreTimestamp(data.expires_at)) {
      continue;
    }

    const timestamp =
      typeof data.timestamp === "number"
        ? data.timestamp
        : timestampToMillis(data.timestamp);

    if (typeof timestamp !== "number") {
      skipped += 1;
      continue;
    }

    updates.push({
      ref: doc.ref,
      update: {
        expires_at: new Date(timestamp + 90 * 24 * 60 * 60 * 1000)
      }
    });
  }

  if (shouldWrite) {
    await commitUpdates(updates, batchLimit);
  }

  return {
    scanned: snapshot.size,
    update_count: updates.length,
    skipped
  };
}

async function commitUpdates(updates, batchLimit) {
  for (let index = 0; index < updates.length; index += batchLimit) {
    const batch = firestore.batch();

    for (const { ref, update } of updates.slice(index, index + batchLimit)) {
      batch.set(ref, update, { merge: true });
    }

    await batch.commit();
  }
}

function hasFirestoreTimestamp(value) {
  return value instanceof Date || typeof value?.toDate === "function";
}

function timestampToMillis(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value?.toMillis === "function") {
    return value.toMillis();
  }

  return undefined;
}

function readArg(name) {
  const index = args.findIndex(arg => arg === `--${name}`);

  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function positiveInt(value, fallback, key) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return parsed;
}

function loadEnvFile(filePath, target) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    target[key] = value;
  }
}

function readFirebaseProject(rootDir) {
  const firebaseRcPath = path.join(rootDir, ".firebaserc");

  if (!fs.existsSync(firebaseRcPath)) {
    return undefined;
  }

  const firebaseRc = JSON.parse(fs.readFileSync(firebaseRcPath, "utf8"));
  const project = firebaseRc.projects?.prod ?? firebaseRc.projects?.default;

  return typeof project === "string" && project.trim() ? project.trim() : undefined;
}
