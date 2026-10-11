import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bundleHash, canonicalJson, compareRuns, corpusHash, parseBundle, parseRun,
  providerResponseSchema, runProvider, sha256, summarizeRun,
  type ProviderEvalBundle, type ProviderEvalRun, type ProviderResponse } from "../src/providerEvaluation.js";

export function fixtureBundle(): ProviderEvalBundle {
  return parseBundle({schema_version: "provider-eval-bundle.v1", bundle_id: "test-v1", scope: "one-principal",
    sources: ["a", "b", "c", "d"].map(id => ({id, content: id, sha256: sha256(id), scope: "one-principal",
      created_at: "2026-09-01T00:00:00.000Z", metadata: {}})),
    cases: ["first", "second"].map(case_id => ({case_id, incident_id: case_id, split: "development",
      query: case_id, limit: 5, required_ids: [case_id === "first" ? "a" : "b"],
      label: {source: "synthetic_definition", review_status: "needs_review", evidence: ["test fixture"]},
      scenario: {request: case_id, fixture: {}, must: [], must_not: [], checks: ["fixture assertion"]}}))});
}
function response(ids: string[] | null, status: "success" | "error" | "unknown" = "success"): ProviderResponse {
  return {status, ranked_source_ids: ids, synthesized_answer: null, error_code: status === "error" ? "timeout" : null, latency_ms: null};
}
export function fixtureRun(bundle: ProviderEvalBundle, ranks: (string[] | null)[][], name = "scripted"): ProviderEvalRun {
  return parseRun({schema_version: "provider-eval-run.v1", run_id: name, bundle_sha256: bundleHash(bundle),
    provider: {name, version: "fixture-v1", config_sha256: sha256(name), mode: "recorded", corpus_sha256: corpusHash(bundle)},
    protocol: {kind: "retrieval-only", repetitions: ranks.length, cutoffs: [1, 5]},
    rows: ranks.flatMap((results, index) => bundle.cases.map((c, i) => ({case_id: c.case_id, repetition: index + 1, response: response(results[i]!)})))}, bundle);
}

describe("frozen provider evaluation", () => {
  it("freezes all eight behavior specifications without marking them executed or reviewed", () => {
    const bundle = parseBundle(JSON.parse(fs.readFileSync(new URL("../eval/s4/bundle.json", import.meta.url), "utf8")));
    expect(bundle.cases).toHaveLength(8);
    expect(bundle.cases.filter(c => c.query !== null)).toHaveLength(5);
    expect(bundle.cases.every(c => c.label.review_status === "needs_review")).toBe(true);
    expect(bundle.cases.find(c => c.case_id === "compaction_loses_constraint")!.scenario.request).toContain("without rotating");
  });

  it("rejects content tampering, unknown labels and cross-scope sources", () => {
    const bundle = fixtureBundle();
    bundle.sources[0]!.content = "changed";
    expect(() => parseBundle(bundle)).toThrow("hash mismatch");
    bundle.sources[0]!.sha256 = sha256("changed");
    bundle.sources[0]!.scope = "other";
    expect(() => parseBundle(bundle)).toThrow("outside bundle scope");
    const missing = fixtureBundle(); missing.cases[0]!.required_ids = ["absent"];
    expect(() => parseBundle(missing)).toThrow("Invalid required sources");
  });

  it("prevents retries/paraphrases of an incident crossing splits", () => {
    const bundle = fixtureBundle();
    bundle.cases[1]!.incident_id = bundle.cases[0]!.incident_id;
    bundle.cases[1]!.split = "validation";
    expect(() => parseBundle(bundle)).toThrow("crosses splits");
  });

  it("hashes object key order consistently and detects context/order changes", () => {
    expect(canonicalJson({b: 1, a: 2})).toBe(canonicalJson({a: 2, b: 1}));
    const bundle = fixtureBundle(), before = bundleHash(bundle);
    bundle.cases[0]!.scenario.request = "No rotation";
    expect(bundleHash(bundle)).not.toBe(before);
    expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
  });

  it("does not promote implicit fetch evidence to reviewed relevance", () => {
    const bundle = fixtureBundle();
    bundle.cases[0]!.label = {source: "implicit_fetch", review_status: "reviewed", evidence: ["fetch"]};
    expect(() => parseBundle(bundle)).toThrow("cannot certify");
  });

  it("catches the regression hidden by the pilot's improved average", () => {
    const bundle = fixtureBundle();
    const before = fixtureRun(bundle, [[["c", "d", "b", "a"], ["a", "b"]]], "baseline");
    const after = fixtureRun(bundle, [[["a"], ["a", "c", "d", "b"]]], "candidate");
    const report = compareRuns(bundle, before, after);
    expect(report.candidate.rank_metrics!.mrr).toBeGreaterThan(report.baseline.rank_metrics!.mrr);
    expect(report.status).toBe("regression");
    expect(report.changes.find(c => c.case_id === "second")!.regression).toBe(true);
    expect(report.adoption_eligible).toBe(false);
  });

  it("catches loss of a second required fact even if the first rank stays the same", () => {
    const bundle = fixtureBundle(); bundle.cases[0]!.required_ids = ["a", "c"];
    const report = compareRuns(bundle, fixtureRun(bundle, [[["a", "c"], ["b"]]]), fixtureRun(bundle, [[["a"], ["b"]]]));
    expect(report.regression_count).toBe(1);
  });

  it("checks every repetition and never silently drops missing/duplicate rows", () => {
    const bundle = fixtureBundle(), run = fixtureRun(bundle, [[["a"], ["b"]], [["a"], ["b"]]]);
    run.rows.pop(); expect(() => parseRun(run, bundle)).toThrow("Incomplete");
    run.rows.push(run.rows[0]!); expect(() => parseRun(run, bundle)).toThrow("duplicate");
  });

  it("rejects changed bundles, protocol settings, corpus assertions and live/recorded mixing", () => {
    const bundle = fixtureBundle(), before = fixtureRun(bundle, [[["a"], ["b"]]]);
    const after = structuredClone(before); after.bundle_sha256 = sha256("other");
    expect(() => compareRuns(bundle, before, after)).toThrow("bundle/corpus");
    after.bundle_sha256 = before.bundle_sha256; after.provider.corpus_sha256 = sha256("other");
    expect(() => compareRuns(bundle, before, after)).toThrow("bundle/corpus");
    after.provider.corpus_sha256 = before.provider.corpus_sha256; after.protocol.cutoffs = [1];
    expect(() => compareRuns(bundle, before, after)).toThrow("same protocol");
    after.protocol = before.protocol; after.provider.mode = "live";
    expect(() => compareRuns(bundle, before, after)).toThrow("observation mode");
  });

  it("keeps unknown rankings and unmeasured latency out of numeric metrics", () => {
    const bundle = fixtureBundle(), run = fixtureRun(bundle, [[null, null]]);
    const summary = summarizeRun(run, bundle);
    expect(summary.rank_metrics).toBeNull();
    expect(summary.latency_ms).toEqual({measured_count: 0, unknown_count: 2, p50: null, p95: null});
    expect(compareRuns(bundle, run, run).status).toBe("incomplete");
    expect(summary.behavior_scenarios_not_executed).toEqual(["first", "second"]);
  });

  it("retains failed calls and distinguishes them from successful empty results", async () => {
    const bundle = fixtureBundle();
    const search = vi.fn().mockRejectedValueOnce(new Error("private-header-secret")).mockResolvedValueOnce(response([]));
    const run = await runProvider({bundle, provider: {descriptor: fixtureRun(bundle, [[["a"], ["b"]]]).provider, search}, runId: "failures", repetitions: 1});
    const summary = summarizeRun(run, bundle);
    expect(run.rows).toHaveLength(2);
    expect(summary.error_count).toBe(1);
    expect(summary.rank_metrics!.zero_result_count).toBe(1);
    expect(JSON.stringify(run)).not.toContain("private-header-secret");
    expect(summary.latency_ms.unknown_count).toBe(2);
  });

  it("marks loss of previously observable results as a regression", () => {
    const bundle = fixtureBundle(), before = fixtureRun(bundle, [[["a"], ["b"]]]), after = structuredClone(before);
    after.rows[0]!.response = response(null, "error");
    expect(compareRuns(bundle, before, after)).toMatchObject({regression_count: 1, uncomparable_count: 1});
  });

  it("validates provider response semantics and canonical source mappings", () => {
    expect(() => providerResponseSchema.parse(response(["a"], "error"))).toThrow();
    expect(() => providerResponseSchema.parse(response(["a", "a"]))).toThrow();
    const bundle = fixtureBundle(), run = fixtureRun(bundle, [[["a"], ["b"]]]);
    run.rows[0]!.response.ranked_source_ids = ["unmapped-native-chunk"];
    expect(() => parseRun(run, bundle)).toThrow("unknown sources");
  });
  it("validates the corpus assertion before making any provider call", async () => {
    const bundle = fixtureBundle(), descriptor = fixtureRun(bundle, [[["a"], ["b"]]]).provider;
    descriptor.corpus_sha256 = sha256("wrong corpus");
    const search = vi.fn();
    await expect(runProvider({bundle, provider: {descriptor, search}, runId: "invalid", repetitions: 1})).rejects.toThrow("corpus");
    expect(search).not.toHaveBeenCalled();
  });

  it("retains an invalid result as a failed observation and continues other cases", async () => {
    const bundle = fixtureBundle(), descriptor = fixtureRun(bundle, [[["a"], ["b"]]]).provider;
    const search = vi.fn().mockResolvedValueOnce(response(["unknown-source"])).mockResolvedValueOnce(response(["b"]));
    const run = await runProvider({bundle, provider: {descriptor, search}, runId: "mapping-gap", repetitions: 1});
    expect(run.rows.map(r => r.response.status)).toEqual(["error", "success"]);
  });

  it("cannot report a clean comparison when no retrieval case was executed", () => {
    const bundle = fixtureBundle(); for (const c of bundle.cases) { c.query = null; c.required_ids = []; }
    const run = parseRun({schema_version: "provider-eval-run.v1", run_id: "no-queries", bundle_sha256: bundleHash(bundle),
      provider: {name: "scripted", version: "v1", config_sha256: sha256("fixture"), mode: "recorded", corpus_sha256: corpusHash(bundle)},
      protocol: {kind: "retrieval-only", repetitions: 1, cutoffs: [1, 5]}, rows: []}, bundle);
    expect(compareRuns(bundle, run, run).status).toBe("incomplete");
  });

});
