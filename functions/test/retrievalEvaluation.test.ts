import { describe, expect, it } from "vitest";

import type { RetrievalEvent } from "../src/observability.js";
import {
  buildSyntheticEvalCases,
  computeRetrievalEvalMetrics,
  correlateImplicitFetches,
  replaceRetrievalEvalCases,
  type RetrievalEvalCase,
  type RetrievalEvalCaseStore,
  type RetrievalEvalSource,
  type RetrievalEvalTargetMode
} from "../src/retrievalEvaluation.js";

describe("retrieval evaluation", () => {
  it("builds synthetic cases with resolved positive ids", () => {
    const cases = buildSyntheticEvalCases({
      definitions: [
        {
          case_id: "networking",
          query: "shared iOS networking",
          filter_topic: "networking",
          filter_state: "active",
          limit: 5,
          positive_keys: ["ktor"]
        }
      ],
      memoryIdsByKey: new Map([["ktor", "memory-42"]]),
      memoryCollection: "memory_vectors_eval",
      timestamp: 100
    });

    expect(cases).toEqual([
      expect.objectContaining({
        case_id: "networking",
        target_mode: "isolated",
        source: "synthetic_flow",
        positive_ids: ["memory-42"],
        label_source: "implicit_fetch"
      })
    ]);
  });

  it("correlates successful fetches to the most recent search containing the id", () => {
    const events: RetrievalEvent[] = [
      searchEvent({ eventId: "search-1", timestamp: 100, resultIds: ["a", "b"] }),
      searchEvent({ eventId: "search-2", timestamp: 200, resultIds: ["b"] }),
      fetchEvent({ eventId: "fetch-1", timestamp: 250, memoryId: "b" }),
      fetchEvent({ eventId: "fetch-2", timestamp: 260, memoryId: "missing" })
    ];

    expect(correlateImplicitFetches(events)).toEqual([
      expect.objectContaining({
        case_id: "observed-search-2",
        query: "query search-2",
        positive_ids: ["b"],
        target_mode: "production",
        source: "observed_events"
      })
    ]);
  });

  it("computes ranking, empty-result, and latency metrics", () => {
    const metrics = computeRetrievalEvalMetrics([
      {
        case_id: "one",
        positive_ids: ["a"],
        returned_ids: ["x", "a"],
        latency_ms: 10
      },
      {
        case_id: "two",
        positive_ids: ["b", "c"],
        returned_ids: ["c"],
        latency_ms: 20
      },
      {
        case_id: "three",
        positive_ids: ["d"],
        returned_ids: [],
        latency_ms: 100
      }
    ]);

    expect(metrics).toMatchObject({
      case_count: 3,
      hit_at_k: { "1": 0.333333, "5": 0.666667 },
      recall_at_k: { "1": 0.166667, "5": 0.5 },
      mrr: 0.5,
      zero_result_count: 1,
      zero_result_rate: 0.333333,
      latency_ms: { p50: 20, p95: 100 }
    });
  });

  it("replaces a source partition instead of retaining obsolete cases", async () => {
    const obsolete = evalCase("obsolete");
    const retainedOtherSource = {
      ...evalCase("observed"),
      source: "observed_events" as const
    };
    const store = new InMemoryEvalCaseStore([obsolete, retainedOtherSource]);
    const replacement = evalCase("replacement");

    await replaceRetrievalEvalCases(
      store,
      "isolated",
      "synthetic_flow",
      [replacement]
    );

    expect(await store.listCases("isolated")).toEqual([
      retainedOtherSource,
      replacement
    ]);
  });
});

class InMemoryEvalCaseStore implements RetrievalEvalCaseStore {
  constructor(private cases: RetrievalEvalCase[]) {}

  async deleteCases(
    targetMode: RetrievalEvalTargetMode,
    source: RetrievalEvalSource
  ): Promise<void> {
    this.cases = this.cases.filter(
      evalCase => evalCase.target_mode !== targetMode || evalCase.source !== source
    );
  }

  async writeCases(cases: readonly RetrievalEvalCase[]): Promise<void> {
    this.cases.push(...cases);
  }

  async listCases(targetMode: RetrievalEvalTargetMode): Promise<RetrievalEvalCase[]> {
    return this.cases.filter(evalCase => evalCase.target_mode === targetMode);
  }
}

function evalCase(caseId: string): RetrievalEvalCase {
  return {
    schema_version: 1,
    case_id: caseId,
    target_mode: "isolated",
    source: "synthetic_flow",
    query: caseId,
    filters: { filter_topic: null, filter_state: "active" },
    limit: 5,
    memory_collection: "memory_vectors_eval",
    positive_ids: [caseId],
    label_source: "implicit_fetch",
    created_at: 100,
    updated_at: 100
  };
}

function searchEvent(input: {
  eventId: string;
  timestamp: number;
  resultIds: string[];
}): RetrievalEvent {
  return {
    event_id: input.eventId,
    tool_event_id: `tool-${input.eventId}`,
    event_type: "search",
    client_id: "client",
    status: "success",
    timestamp: input.timestamp,
    expires_at: new Date(),
    memory_collection: "memory_vectors",
    query: `query ${input.eventId}`,
    filter_state: "active",
    limit: 5,
    result_count: input.resultIds.length,
    results: input.resultIds.map((id, index) => ({ id, rank: index + 1 }))
  };
}

function fetchEvent(input: {
  eventId: string;
  timestamp: number;
  memoryId: string;
}): RetrievalEvent {
  return {
    event_id: input.eventId,
    tool_event_id: `tool-${input.eventId}`,
    event_type: "fetch",
    client_id: "client",
    status: "success",
    timestamp: input.timestamp,
    expires_at: new Date(),
    memory_collection: "memory_vectors",
    memory_id: input.memoryId,
    found: true
  };
}
