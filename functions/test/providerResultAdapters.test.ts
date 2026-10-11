import { describe, expect, it } from "vitest";
import { normalizeSearchResult } from "../src/providerResultAdapters.js";

describe("pinned provider result adapters", () => {
  const sourceMap = new Map([["native-1", "first"], ["https://fixture.invalid/one", "first"], ["https://fixture.invalid/two", "second"]]);
  const row = (url: string | null) => ({url, title: "not-a-stable-id", content: "source excerpt"});
  it("maps MetaCortex IDs to canonical source IDs", () => {
    expect(normalizeSearchResult({provider: "metacortex", payload: {matches: [{id: "native-1"}]}, sourceMap, limit: 5, latencyMs: 10}))
      .toMatchObject({status: "success", ranked_source_ids: ["first"], latency_ms: 10});
  });
  it("maps pinned Onyx URLs and deduplicates chunks before applying the client source cap", () => {
    expect(normalizeSearchResult({provider: "onyx-v4.7.1", payload: {results: [row("https://fixture.invalid/one"), row("https://fixture.invalid/one"), row("https://fixture.invalid/two")]}, sourceMap, limit: 2, latencyMs: null}))
      .toMatchObject({status: "success", ranked_source_ids: ["first", "second"]});
  });
  it("refuses the incompatible website shape and never invents an empty successful search", () => {
    expect(normalizeSearchResult({provider: "onyx-v4.7.1", payload: {documents: []}, sourceMap, limit: 5, latencyMs: 1}))
      .toMatchObject({status: "error", ranked_source_ids: null});
  });
  it("keeps an error envelope distinct from successful empty results", () => {
    expect(normalizeSearchResult({provider: "onyx-v4.7.1", payload: {error: "secret diagnostic", results: []}, sourceMap, limit: 5, latencyMs: 1}))
      .toMatchObject({status: "error", error_code: "provider_error_payload", ranked_source_ids: null});
    expect(normalizeSearchResult({provider: "onyx-v4.7.1", payload: {results: []}, sourceMap, limit: 5, latencyMs: 1}))
      .toMatchObject({status: "success", ranked_source_ids: []});
  });
  it("reports unknown identity instead of dropping an unmapped result or using its title", () => {
    expect(normalizeSearchResult({provider: "onyx-v4.7.1", payload: {results: [row("https://fixture.invalid/one"), row(null)]}, sourceMap, limit: 1, latencyMs: 1}))
      .toMatchObject({status: "unknown", ranked_source_ids: null, error_code: "unmapped_native_source"});
  });
});
