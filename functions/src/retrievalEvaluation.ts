import type { Firestore } from "firebase-admin/firestore";

import type { RetrievalEvent } from "./observability.js";
import type { BranchState } from "./types.js";

export const RETRIEVAL_EVAL_COLLECTION = "retrieval_eval_cases";
const FIRESTORE_BATCH_LIMIT = 450;

export type RetrievalEvalTargetMode = "isolated" | "production";
export type RetrievalEvalSource = "synthetic_flow" | "observed_events";

export interface RetrievalEvalCase {
  schema_version: 1;
  case_id: string;
  target_mode: RetrievalEvalTargetMode;
  source: RetrievalEvalSource;
  query: string;
  filters: {
    filter_topic?: string | null;
    filter_state: BranchState;
  };
  limit: number;
  memory_collection: string;
  positive_ids: string[];
  label_source: "implicit_fetch";
  created_at: number;
  updated_at: number;
}

export interface RetrievalEvalCaseStore {
  deleteCases(
    targetMode: RetrievalEvalTargetMode,
    source: RetrievalEvalSource
  ): Promise<void>;
  writeCases(cases: readonly RetrievalEvalCase[]): Promise<void>;
  listCases(targetMode: RetrievalEvalTargetMode): Promise<RetrievalEvalCase[]>;
}

export class FirestoreRetrievalEvalCaseStore implements RetrievalEvalCaseStore {
  constructor(
    private readonly firestore: Firestore,
    private readonly collectionName = RETRIEVAL_EVAL_COLLECTION
  ) {}

  async deleteCases(
    targetMode: RetrievalEvalTargetMode,
    source: RetrievalEvalSource
  ): Promise<void> {
    const snapshot = await this.firestore
      .collection(this.collectionName)
      .where("target_mode", "==", targetMode)
      .where("source", "==", source)
      .get();

    for (const documents of chunk(snapshot.docs, FIRESTORE_BATCH_LIMIT)) {
      const batch = this.firestore.batch();

      for (const document of documents) {
        batch.delete(document.ref);
      }

      await batch.commit();
    }
  }

  async writeCases(cases: readonly RetrievalEvalCase[]): Promise<void> {
    for (const caseChunk of chunk(cases, FIRESTORE_BATCH_LIMIT)) {
      const batch = this.firestore.batch();

      for (const evalCase of caseChunk) {
        batch.set(
          this.firestore.collection(this.collectionName).doc(evalCase.case_id),
          evalCase
        );
      }

      await batch.commit();
    }
  }

  async listCases(targetMode: RetrievalEvalTargetMode): Promise<RetrievalEvalCase[]> {
    const snapshot = await this.firestore
      .collection(this.collectionName)
      .where("target_mode", "==", targetMode)
      .get();

    return snapshot.docs
      .map(document => document.data() as RetrievalEvalCase)
      .filter(evalCase => evalCase.schema_version === 1)
      .sort((left, right) => left.case_id.localeCompare(right.case_id));
  }
}

export async function replaceRetrievalEvalCases(
  store: RetrievalEvalCaseStore,
  targetMode: RetrievalEvalTargetMode,
  source: RetrievalEvalSource,
  cases: readonly RetrievalEvalCase[]
): Promise<void> {
  await store.deleteCases(targetMode, source);
  await store.writeCases(cases);
}

export interface SyntheticEvalDefinition {
  case_id: string;
  query: string;
  filter_topic?: string;
  filter_state: BranchState;
  limit: number;
  positive_keys: string[];
}

export function buildSyntheticEvalCases(input: {
  definitions: readonly SyntheticEvalDefinition[];
  memoryIdsByKey: ReadonlyMap<string, string>;
  memoryCollection: string;
  timestamp: number;
}): RetrievalEvalCase[] {
  return input.definitions.map(definition => ({
    schema_version: 1,
    case_id: definition.case_id,
    target_mode: "isolated",
    source: "synthetic_flow",
    query: definition.query,
    filters: {
      filter_topic: definition.filter_topic ?? null,
      filter_state: definition.filter_state
    },
    limit: definition.limit,
    memory_collection: input.memoryCollection,
    positive_ids: definition.positive_keys.map(key => {
      const memoryId = input.memoryIdsByKey.get(key);

      if (!memoryId) {
        throw new Error(`Synthetic eval definition references unknown memory key: ${key}`);
      }

      return memoryId;
    }),
    label_source: "implicit_fetch",
    created_at: input.timestamp,
    updated_at: input.timestamp
  }));
}

export function correlateImplicitFetches(
  events: readonly RetrievalEvent[],
  options: { maxDelayMs?: number } = {}
): RetrievalEvalCase[] {
  const maxDelayMs = options.maxDelayMs ?? 30 * 60 * 1000;
  const searches = events
    .filter(
      (event): event is Extract<RetrievalEvent, { event_type: "search" }> =>
        event.event_type === "search" && event.status === "success"
    )
    .sort((left, right) => left.timestamp - right.timestamp);
  const fetches = events
    .filter(
      (event): event is Extract<RetrievalEvent, { event_type: "fetch" }> =>
        event.event_type === "fetch" &&
        event.status === "success" &&
        event.found === true
    )
    .sort((left, right) => left.timestamp - right.timestamp);
  const matches = new Map<
    string,
    { search: (typeof searches)[number]; positiveIds: Set<string>; updatedAt: number }
  >();

  for (const fetch of fetches) {
    const search = searches
      .filter(candidate =>
        candidate.client_id === fetch.client_id &&
        candidate.memory_collection === fetch.memory_collection &&
        candidate.timestamp <= fetch.timestamp &&
        fetch.timestamp - candidate.timestamp <= maxDelayMs &&
        candidate.results?.some(result => result.id === fetch.memory_id)
      )
      .at(-1);

    if (!search) {
      continue;
    }

    const existing = matches.get(search.event_id);

    if (existing) {
      existing.positiveIds.add(fetch.memory_id);
      existing.updatedAt = Math.max(existing.updatedAt, fetch.timestamp);
    } else {
      matches.set(search.event_id, {
        search,
        positiveIds: new Set([fetch.memory_id]),
        updatedAt: fetch.timestamp
      });
    }
  }

  return [...matches.values()]
    .map(({ search, positiveIds, updatedAt }) => ({
      schema_version: 1 as const,
      case_id: `observed-${search.event_id.replaceAll("/", "-")}`,
      target_mode: "production" as const,
      source: "observed_events" as const,
      query: search.query,
      filters: {
        filter_topic: search.filter_topic ?? null,
        filter_state: search.filter_state as BranchState
      },
      limit: search.limit,
      memory_collection: search.memory_collection,
      positive_ids: [...positiveIds],
      label_source: "implicit_fetch" as const,
      created_at: search.timestamp,
      updated_at: updatedAt
    }))
    .sort((left, right) => left.case_id.localeCompare(right.case_id));
}

export interface RetrievalEvalObservation {
  case_id: string;
  positive_ids: string[];
  returned_ids: string[];
  latency_ms: number;
}

export interface RetrievalEvalMetrics {
  case_count: number;
  hit_at_k: Record<string, number>;
  recall_at_k: Record<string, number>;
  mrr: number;
  zero_result_count: number;
  zero_result_rate: number;
  latency_ms: {
    p50: number;
    p95: number;
  };
  observations: RetrievalEvalObservation[];
}

export function computeRetrievalEvalMetrics(
  observations: readonly RetrievalEvalObservation[],
  cutoffs: readonly number[] = [1, 5]
): RetrievalEvalMetrics {
  const normalizedCutoffs = [...new Set(cutoffs)]
    .filter(cutoff => Number.isInteger(cutoff) && cutoff > 0)
    .sort((left, right) => left - right);
  const hitAtK: Record<string, number> = {};
  const recallAtK: Record<string, number> = {};

  for (const cutoff of normalizedCutoffs) {
    const hitTotal = observations.reduce((total, observation) => {
      const positiveIds = new Set(observation.positive_ids);
      const hit = observation.returned_ids
        .slice(0, cutoff)
        .some(id => positiveIds.has(id));
      return total + Number(hit);
    }, 0);
    const recallTotal = observations.reduce((total, observation) => {
      const positiveIds = new Set(observation.positive_ids);

      if (positiveIds.size === 0) {
        return total;
      }

      const retrievedPositiveCount = new Set(
        observation.returned_ids
          .slice(0, cutoff)
          .filter(id => positiveIds.has(id))
      ).size;
      return total + retrievedPositiveCount / positiveIds.size;
    }, 0);

    hitAtK[String(cutoff)] = safeAverage(hitTotal, observations.length);
    recallAtK[String(cutoff)] = safeAverage(recallTotal, observations.length);
  }

  const reciprocalRankTotal = observations.reduce((total, observation) => {
    const positiveIds = new Set(observation.positive_ids);
    const index = observation.returned_ids.findIndex(id => positiveIds.has(id));
    return total + (index === -1 ? 0 : 1 / (index + 1));
  }, 0);
  const zeroResultCount = observations.filter(
    observation => observation.returned_ids.length === 0
  ).length;
  const latencies = observations.map(observation => observation.latency_ms);

  return {
    case_count: observations.length,
    hit_at_k: hitAtK,
    recall_at_k: recallAtK,
    mrr: safeAverage(reciprocalRankTotal, observations.length),
    zero_result_count: zeroResultCount,
    zero_result_rate: safeAverage(zeroResultCount, observations.length),
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95)
    },
    observations: observations.map(observation => ({
      ...observation,
      latency_ms: Number(observation.latency_ms.toFixed(3))
    }))
  };
}

function safeAverage(total: number, count: number): number {
  return count === 0 ? 0 : Number((total / count).toFixed(6));
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return Number(sorted[index]!.toFixed(3));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}
