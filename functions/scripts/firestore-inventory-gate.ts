import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvironment, readArg } from "./support/cli.js";
import {
  countDocuments,
  listCollectionIds,
  openFirestore
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

const measuredAt = new Date().toISOString();
const sourceIds = await listCollectionIds(sourceDb);
const targetIds = await listCollectionIds(targetDb);
const targetIdSet = new Set(targetIds);

const collections: Array<{
  id: string;
  source_count: number;
  target_count: number | null;
  present_on_target: boolean;
  ok: boolean;
}> = [];

for (const id of sourceIds) {
  const sourceCount = await countDocuments(sourceDb, id);
  const presentOnTarget = targetIdSet.has(id);
  const targetCount = presentOnTarget ? await countDocuments(targetDb, id) : null;
  collections.push({
    id,
    source_count: sourceCount,
    target_count: targetCount,
    present_on_target: presentOnTarget,
    ok: presentOnTarget && targetCount === sourceCount
  });
}

const sourceIdSet = new Set(sourceIds);
const targetOnly = [];
for (const id of targetIds) {
  if (sourceIdSet.has(id)) {
    continue;
  }
  targetOnly.push({
    id,
    target_count: await countDocuments(targetDb, id)
  });
}

const failures = collections.filter(entry => !entry.ok);
const report = {
  ok: failures.length === 0 && sourceIds.length > 0,
  measured_at: measuredAt,
  discovery: "listCollections()",
  source_project: sourceProject,
  target_project: targetProject,
  source_collection_count: sourceIds.length,
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
