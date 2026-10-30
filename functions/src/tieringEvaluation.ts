import { computeRetrievalEvalMetrics, type RetrievalEvalMetrics } from "./retrievalEvaluation.js";

export interface TieringMemory {
  key: string;
  topic: string;
  content: string;
  oracle_summary: string;
}

export interface TieringCase {
  case_id: string;
  query: string;
  positive_keys: string[];
  limit: number;
}

export interface TieringCorpus {
  corpus_id: string;
  memories: TieringMemory[];
  cases: TieringCase[];
}

export type TieringVariantId = "B0" | "V1" | "V2" | "V3" | "V4";

interface VariantSpec {
  indexTexts: (memory: TieringMemory) => string[];
  payload: (memory: TieringMemory) => string;
  generationCallsPerWrite: number;
}

export const SEARCH_SUMMARY_LIMIT = 220;
const VECTOR_DIMENSIONS = 512;
const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how in is it of on or the this to use used uses what when which with how long until".split(" ")
);

export function truncateSummary(value: string, limit = SEARCH_SUMMARY_LIMIT): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

export function firstSentence(value: string): string {
  const match = value.match(/^.*?[.!?](\s|$)/);
  return (match ? match[0] : value).trim();
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(token => token.length > 1 && !STOPWORDS.has(token))
    .map(token => token.replace(/(ing|ed|es|s)$/, "") || token);
}

export function hashedEmbedding(value: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  for (const token of tokenize(value)) {
    let hash = 2166136261;
    for (const char of token) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    }
    vector[(hash >>> 0) % VECTOR_DIMENSIONS]! += 1;
  }
  return vector;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

export const TIERING_VARIANTS: Record<TieringVariantId, VariantSpec> = {
  B0: { indexTexts: m => [m.content], payload: m => truncateSummary(m.content), generationCallsPerWrite: 0 },
  V1: { indexTexts: m => [firstSentence(m.content)], payload: m => truncateSummary(m.content), generationCallsPerWrite: 0 },
  V2: { indexTexts: m => [m.oracle_summary], payload: m => truncateSummary(m.content), generationCallsPerWrite: 1 },
  V3: { indexTexts: m => [m.content, m.oracle_summary], payload: m => truncateSummary(m.content), generationCallsPerWrite: 1 },
  V4: { indexTexts: m => [m.content], payload: m => m.oracle_summary, generationCallsPerWrite: 1 }
};

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

/** A returned summary answers a positive when it holds at least half of the oracle summary's terms. */
export function isAnswerable(payload: string, memory: TieringMemory): boolean {
  const required = new Set(tokenize(memory.oracle_summary));
  const present = new Set(tokenize(payload));
  const overlap = [...required].filter(token => present.has(token)).length;
  return required.size > 0 && overlap / required.size >= 0.5;
}

export interface TieringVariantResult {
  variant: TieringVariantId;
  metrics: Omit<RetrievalEvalMetrics, "observations" | "latency_ms">;
  answerability: number;
  cost: {
    index_tokens_per_memory: number;
    embedding_calls_per_write: number;
    generation_calls_per_write: number;
    payload_tokens_per_query: number;
    ranking_ms_total: number;
  };
}

export function evaluateVariant(corpus: TieringCorpus, variant: TieringVariantId): TieringVariantResult {
  const spec = TIERING_VARIANTS[variant];
  const byKey = new Map(corpus.memories.map(memory => [memory.key, memory]));
  const index = corpus.memories.map(memory => ({
    memory,
    vectors: spec.indexTexts(memory).map(hashedEmbedding)
  }));
  const started = performance.now();
  const observations = corpus.cases.map(testCase => {
    const query = hashedEmbedding(testCase.query);
    const ranked = index
      .map(entry => ({
        key: entry.memory.key,
        score: Math.max(...entry.vectors.map(vector => cosineSimilarity(query, vector)))
      }))
      .filter(entry => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
      .slice(0, testCase.limit);
    return {
      case_id: testCase.case_id,
      positive_ids: testCase.positive_keys,
      returned_ids: ranked.map(entry => entry.key),
      latency_ms: 0
    };
  });
  const rankingMs = performance.now() - started;
  const { observations: _o, latency_ms: _l, ...metrics } = computeRetrievalEvalMetrics(observations, [1, 5]);

  const answerable = observations.filter(observation =>
    observation.positive_ids.every(key => {
      if (!observation.returned_ids.includes(key)) {
        return false;
      }
      const memory = byKey.get(key)!;
      return isAnswerable(spec.payload(memory), memory);
    })
  ).length;
  const payloadTokens = observations.reduce(
    (total, observation) =>
      total + observation.returned_ids.reduce((sum, key) => sum + estimateTokens(spec.payload(byKey.get(key)!)), 0),
    0
  );
  const indexTokens = corpus.memories.reduce(
    (total, memory) => total + spec.indexTexts(memory).reduce((sum, text) => sum + estimateTokens(text), 0),
    0
  );

  return {
    variant,
    metrics,
    answerability: round(answerable / Math.max(1, observations.length)),
    cost: {
      index_tokens_per_memory: round(indexTokens / Math.max(1, corpus.memories.length)),
      embedding_calls_per_write: spec.indexTexts(corpus.memories[0]!).length,
      generation_calls_per_write: spec.generationCallsPerWrite,
      payload_tokens_per_query: round(payloadTokens / Math.max(1, observations.length)),
      ranking_ms_total: round(rankingMs)
    }
  };
}

export interface TieringDecision {
  variant: TieringVariantId;
  regression: boolean;
  go: boolean;
  reason: string;
}

/** Applies the pre-registered criteria from docs/research/2026-10-30-tiering-evaluation-plan.md. */
export function decide(baseline: TieringVariantResult, candidate: TieringVariantResult): TieringDecision {
  const recallDrop = candidate.metrics.recall_at_k["5"]! < baseline.metrics.recall_at_k["5"]!;
  const payloadGrowth = candidate.cost.payload_tokens_per_query > baseline.cost.payload_tokens_per_query * 1.1;
  const regression = recallDrop || payloadGrowth;
  const mrrGain = candidate.metrics.mrr - baseline.metrics.mrr;
  const answerGain = candidate.answerability - baseline.answerability;
  const isPayloadVariant = candidate.variant === "V4";
  const go = !regression && (isPayloadVariant ? answerGain >= 0.2 : candidate.variant !== "V1" && mrrGain >= 0.05);
  const reason = regression
    ? [recallDrop && "recall@5 dropped", payloadGrowth && "payload tokens grew over 10%"].filter(Boolean).join(", ")
    : isPayloadVariant
      ? `answerability ${signed(answerGain)}`
      : `MRR ${signed(mrrGain)}`;
  return { variant: candidate.variant, regression, go, reason };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;
}
