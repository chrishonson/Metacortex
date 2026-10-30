import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { decide, evaluateVariant, type TieringCorpus, type TieringVariantId } from "../src/tieringEvaluation.js";

const corpusPath = fileURLToPath(new URL("../eval/tiering/corpus.json", import.meta.url));
const raw = readFileSync(corpusPath);
const corpus = JSON.parse(raw.toString("utf8")) as TieringCorpus;
const baseline = evaluateVariant(corpus, "B0");
const variants: TieringVariantId[] = ["V1", "V2", "V3", "V4"];
const results = variants.map(variant => evaluateVariant(corpus, variant));

process.stdout.write(`${JSON.stringify({
  corpus_id: corpus.corpus_id,
  corpus_sha256: createHash("sha256").update(raw).digest("hex"),
  results: [baseline, ...results],
  decisions: results.map(result => decide(baseline, result))
}, null, 2)}\n`);
