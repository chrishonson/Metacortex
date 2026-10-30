import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  decide,
  evaluateVariant,
  firstSentence,
  hashedEmbedding,
  isAnswerable,
  truncateSummary,
  type TieringCorpus
} from "../src/tieringEvaluation.js";

const raw = readFileSync(new URL("../eval/tiering/corpus.json", import.meta.url));
const corpus = JSON.parse(raw.toString("utf8")) as TieringCorpus;

describe("tiering evaluation", () => {
  it("keeps the frozen corpus unchanged", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      "1547197f75825f18ec33c26955d0175e6d2e28f2b06f9a8d80fee92c08d132e9"
    );
    const keys = new Set(corpus.memories.map(memory => memory.key));
    for (const testCase of corpus.cases) {
      for (const key of testCase.positive_keys) {
        expect(keys.has(key)).toBe(true);
      }
    }
  });

  it("embeds deterministically and scores identical text as 1", () => {
    const vector = hashedEmbedding("Ktor Darwin engine");
    expect(hashedEmbedding("Ktor Darwin engine")).toEqual(vector);
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1);
    expect(cosineSimilarity(vector, hashedEmbedding(""))).toBe(0);
  });

  it("extracts tiers and truncates like search_context", () => {
    expect(firstSentence("One fact. Two facts.")).toBe("One fact.");
    expect(firstSentence("No terminator")).toBe("No terminator");
    expect(truncateSummary("x".repeat(300))).toHaveLength(220);
  });

  it("judges answerability by oracle term overlap", () => {
    const memory = corpus.memories.find(item => item.key === "deploy-region")!;
    expect(isAnswerable(truncateSummary(memory.content), memory)).toBe(false);
    expect(isAnswerable(memory.oracle_summary, memory)).toBe(true);
  });

  it("reproduces the recorded results and decisions", () => {
    const baseline = evaluateVariant(corpus, "B0");
    expect(baseline.metrics.recall_at_k["5"]).toBe(1);
    expect(baseline.metrics.mrr).toBeCloseTo(0.9074, 4);
    expect(baseline.answerability).toBeCloseTo(0.4444, 4);

    const decisions = (["V1", "V2", "V3", "V4"] as const).map(variant =>
      decide(baseline, evaluateVariant(corpus, variant))
    );
    expect(decisions.map(decision => [decision.variant, decision.regression, decision.go])).toEqual([
      ["V1", true, false],
      ["V2", false, true],
      ["V3", false, true],
      ["V4", false, true]
    ]);
  });

  it("flags payload growth as a regression", () => {
    const baseline = evaluateVariant(corpus, "B0");
    const inflated = { ...baseline, variant: "V2" as const, cost: { ...baseline.cost, payload_tokens_per_query: baseline.cost.payload_tokens_per_query * 2 } };
    expect(decide(baseline, inflated)).toMatchObject({ regression: true, go: false, reason: "payload tokens grew over 10%" });
  });
});
