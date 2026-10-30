import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvironment, readArg } from "./support/cli.js";
import { encodeDocument, DOCUMENT_ID_FIELD } from "./support/firestore-codec.js";
import {
  computeSha256,
  FirestoreMirrorStore,
  openFirestore,
  serializeNdjson,
  type MirrorDocument
} from "./support/firestore-full-mirror.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const functionsDirectory = path.resolve(scriptDirectory, "..");

loadEnvironment(functionsDirectory);

const args = process.argv.slice(2);
const sourceProject = readArg(args, "source-project");
const targetProject = readArg(args, "target-project");
const outPath = readArg(args, "out");

if (!sourceProject || !targetProject) {
  console.error(
    "usage: firestore-inventory-gate --source-project <id> --target-project <id> [--out path]"
  );
  process.exit(1);
}

const sourceDb = openFirestore(sourceProject, "gate-source");
const targetDb = openFirestore(targetProject, "gate-target");

const sourceStore = new FirestoreMirrorStore(sourceDb);
const targetStore = new FirestoreMirrorStore(targetDb);

const measuredAt = new Date().toISOString();
const sourcePaths = await sourceStore.discoverCollectionPaths();
const targetPaths = await targetStore.discoverCollectionPaths();
const targetPathSet = new Set(targetPaths);

const collections: Array<{
  id: string;
  source_count: number;
  target_count: number | null;
  present_on_target: boolean;
  ok: boolean;
  source_sha256?: string;
  target_sha256?: string;
}> = [];

for (const colPath of sourcePaths) {
  const sourceDocs = await sourceStore.readCollection(colPath);
  const sourceCount = sourceDocs.length;
  const sourceEncoded = sourceDocs
    .map((d: MirrorDocument) => encodeDocument(d.id, d.data))
    .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
      String(a[DOCUMENT_ID_FIELD]).localeCompare(String(b[DOCUMENT_ID_FIELD]))
    );
  const sourceSha = computeSha256(serializeNdjson(sourceEncoded));

  const presentOnTarget = targetPathSet.has(colPath);
  let targetCount: number | null = null;
  let targetSha: string | undefined;

  if (presentOnTarget) {
    const targetDocs = await targetStore.readCollection(colPath);
    targetCount = targetDocs.length;
    const targetEncoded = targetDocs
      .map((d: MirrorDocument) => encodeDocument(d.id, d.data))
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
        String(a[DOCUMENT_ID_FIELD]).localeCompare(String(b[DOCUMENT_ID_FIELD]))
      );
    targetSha = computeSha256(serializeNdjson(targetEncoded));
  }

  const ok = presentOnTarget && targetCount === sourceCount && targetSha === sourceSha;

  collections.push({
    id: colPath,
    source_count: sourceCount,
    target_count: targetCount,
    present_on_target: presentOnTarget,
    ok,
    source_sha256: sourceSha,
    target_sha256: targetSha
  });
}

const sourcePathSet = new Set(sourcePaths);
const targetOnly: Array<{ id: string; target_count: number }> = [];
for (const colPath of targetPaths) {
  if (sourcePathSet.has(colPath)) {
    continue;
  }
  targetOnly.push({
    id: colPath,
    target_count: await targetStore.countDocuments(colPath)
  });
}

const failures = collections.filter(entry => !entry.ok);
const report = {
  ok: failures.length === 0 && sourcePaths.length > 0,
  measured_at: measuredAt,
  discovery: "recursive-listCollections",
  source_project: sourceProject,
  target_project: targetProject,
  source_collection_count: sourcePaths.length,
  collections,
  target_only: targetOnly,
  failures: failures.map(entry => ({
    id: entry.id,
    source_count: entry.source_count,
    target_count: entry.target_count,
    present_on_target: entry.present_on_target
  }))
};

const json = `${JSON.stringify(report, null, 2)}\n`;
process.stdout.write(json);

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json, "utf8");
}

if (!report.ok) {
  process.exit(1);
}
