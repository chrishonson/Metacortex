import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  decide,
  evaluateVariant,
  isAnswerable,
  type TieringCorpus,
  type TieringVariantId
} from "../src/tieringEvaluation.js";

const corpusPath = fileURLToPath(new URL("../eval/tiering/corpus.json", import.meta.url));
const raw = readFileSync(corpusPath);
const corpus = JSON.parse(raw.toString("utf8")) as TieringCorpus;
const baseline = evaluateVariant(corpus, "B0");
const variants: TieringVariantId[] = ["V1", "V2", "V3", "V4"];
const results = variants.map(variant => evaluateVariant(corpus, variant));

const fixturePath = fileURLToPath(new URL("../eval/tiering/generated-summaries.json", import.meta.url));
let v4GeneratedPayload: {
  result: ReturnType<typeof evaluateVariant>;
  decision: ReturnType<typeof decide>;
  shortfalls: string[];
} | undefined;

if (existsSync(fixturePath)) {
  const fixtureRaw = readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(fixtureRaw) as {
    summaries: Array<{ key: string; summary: string }>;
  };
  const summaryMap: Record<string, string> = {};
  for (const item of fixture.summaries) {
    summaryMap[item.key] = item.summary;
  }
  const result = evaluateVariant(corpus, "V4", summaryMap);
  const decision = decide(baseline, result);
  const shortfalls = corpus.memories
    .filter(memory => !isAnswerable(summaryMap[memory.key] ?? "", memory))
    .map(memory => memory.key);

  v4GeneratedPayload = {
    result,
    decision,
    shortfalls
  };
}

process.stdout.write(`${JSON.stringify({
  corpus_id: corpus.corpus_id,
  corpus_sha256: createHash("sha256").update(raw).digest("hex"),
  results: [baseline, ...results],
  decisions: results.map(result => decide(baseline, result)),
  ...(v4GeneratedPayload
    ? {
        v4_generated: {
          result: v4GeneratedPayload.result,
          decision: v4GeneratedPayload.decision,
          shortfalls: v4GeneratedPayload.shortfalls
        },
        v4_generated_shortfalls: v4GeneratedPayload.shortfalls
      }
    : {})
}, null, 2)}\n`);
