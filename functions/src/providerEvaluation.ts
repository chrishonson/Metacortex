import { createHash } from "node:crypto";
import { z } from "zod";
import { computeRetrievalEvalMetrics } from "./retrievalEvaluation.js";

const id = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const sourceSchema = z.object({
  id, content: id, sha256: hash, scope: id, created_at: z.string().datetime(),
  metadata: z.record(z.unknown())
}).strict();
const caseSchema = z.object({
  case_id: id, incident_id: id, split: z.enum(["development", "validation"]),
  query: id.nullable(), limit: z.number().int().positive().max(100),
  required_ids: z.array(id),
  label: z.object({
    source: z.enum(["synthetic_definition", "source_grounded_draft", "reviewer_confirmed", "implicit_fetch"]),
    review_status: z.enum(["needs_review", "reviewed"]), evidence: z.array(id).min(1)
  }).strict(),
  scenario: z.object({
    request: id, fixture: z.record(z.unknown()), must: z.array(id),
    must_not: z.array(id), checks: z.array(id).min(1)
  }).strict()
}).strict();
const bundleSchema = z.object({
  schema_version: z.literal("provider-eval-bundle.v1"), bundle_id: id,
  scope: id, sources: z.array(sourceSchema).min(1), cases: z.array(caseSchema).min(1)
}).strict();
export type ProviderEvalBundle = z.infer<typeof bundleSchema>;

/** Canonical object ordering, while preserving semantically significant array order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function bundleHash(bundle: ProviderEvalBundle): string {
  return sha256(canonicalJson(bundle));
}
export function parseBundle(input: unknown): ProviderEvalBundle {
  const bundle = bundleSchema.parse(input);
  if (!unique(bundle.sources.map(s => s.id)) || !unique(bundle.cases.map(c => c.case_id))) {
    throw new Error("Duplicate source or case ID");
  }
  const sources = new Map(bundle.sources.map(s => [s.id, s]));
  for (const source of bundle.sources) {
    if (sha256(source.content) !== source.sha256) throw new Error(`Source hash mismatch: ${source.id}`);
    if (source.scope !== bundle.scope) throw new Error(`Source outside bundle scope: ${source.id}`);
  }
  const splits = new Map<string, string>();
  for (const item of bundle.cases) {
    if (splits.has(item.incident_id) && splits.get(item.incident_id) !== item.split) {
      throw new Error(`Incident crosses splits: ${item.incident_id}`);
    }
    splits.set(item.incident_id, item.split);
    if (!unique(item.required_ids) || item.required_ids.some(key => !sources.has(key))) {
      throw new Error(`Invalid required sources: ${item.case_id}`);
    }
    if (item.query !== null && item.required_ids.length === 0) {
      throw new Error(`Retrieval case has no relevance labels: ${item.case_id}`);
    }
    if (item.label.source === "implicit_fetch" && item.label.review_status === "reviewed") {
      throw new Error("A fetch signal cannot certify reviewed relevance");
    }
  }
  return bundle;
}

// This is an observable retrieval boundary, not a claim about model input or use.
export const providerResponseSchema = z.object({
  status: z.enum(["success", "error", "unknown"]),
  ranked_source_ids: z.array(id).nullable(),
  synthesized_answer: z.string().nullable(),
  error_code: id.nullable(),
  latency_ms: z.number().finite().nonnegative().nullable()
}).strict().superRefine((value, context) => {
  if (value.status !== "success" && value.ranked_source_ids !== null) {
    context.addIssue({code: z.ZodIssueCode.custom, message: "Errors/unknowns cannot invent rankings"});
  }
  if (value.status === "error" && value.error_code === null) {
    context.addIssue({code: z.ZodIssueCode.custom, message: "Error needs a diagnostic code"});
  }
  if (value.status === "success" && value.error_code !== null) {
    context.addIssue({code: z.ZodIssueCode.custom, message: "Successful response cannot contain an error"});
  }
  if (value.ranked_source_ids && !unique(value.ranked_source_ids)) {
    context.addIssue({code: z.ZodIssueCode.custom, message: "Ranked canonical sources must be unique"});
  }
});
export type ProviderResponse = z.infer<typeof providerResponseSchema>;
export interface ContextEvalProvider {
  descriptor: ProviderDescriptor;
  search(input: {query: string; limit: number; scope: string}): Promise<ProviderResponse>;
}
const descriptorSchema = z.object({
  name: id, version: id, config_sha256: hash,
  mode: z.enum(["recorded", "live"]), corpus_sha256: hash
}).strict();
export type ProviderDescriptor = z.infer<typeof descriptorSchema>;
const rowSchema = z.object({
  case_id: id, repetition: z.number().int().positive(), response: providerResponseSchema
}).strict();
const runSchema = z.object({
  schema_version: z.literal("provider-eval-run.v1"), run_id: id,
  bundle_sha256: hash, provider: descriptorSchema,
  protocol: z.object({
    kind: z.literal("retrieval-only"), repetitions: z.number().int().positive(),
    cutoffs: z.array(z.number().int().positive()).min(1)
  }).strict(), rows: z.array(rowSchema)
}).strict();
export type ProviderEvalRun = z.infer<typeof runSchema>;

export function corpusHash(bundle: ProviderEvalBundle): string {
  return sha256(canonicalJson({scope: bundle.scope, sources: bundle.sources}));
}
export function parseRun(input: unknown, bundle: ProviderEvalBundle): ProviderEvalRun {
  const run = runSchema.parse(input);
  if (run.bundle_sha256 !== bundleHash(bundle) || run.provider.corpus_sha256 !== corpusHash(bundle)) {
    throw new Error("Run does not match the frozen bundle/corpus");
  }
  if (!unique(run.protocol.cutoffs.map(String))) throw new Error("Duplicate cutoffs");
  const cases = new Map(bundle.cases.filter(c => c.query !== null).map(c => [c.case_id, c]));
  const sources = new Set(bundle.sources.map(s => s.id));
  const seen = new Set<string>();
  for (const row of run.rows) {
    const item = cases.get(row.case_id);
    const key = `${row.case_id}:${row.repetition}`;
    if (!item || row.repetition > run.protocol.repetitions || seen.has(key)) {
      throw new Error(`Unexpected or duplicate observation: ${key}`);
    }
    seen.add(key);
    const returned = row.response.ranked_source_ids;
    if (returned && (returned.length > item.limit || returned.some(key => !sources.has(key)))) {
      throw new Error(`Observation contains unknown sources or exceeds limit: ${key}`);
    }
  }
  if (seen.size !== cases.size * run.protocol.repetitions) throw new Error("Incomplete run observation matrix");
  return run;
}

/** Preserve each failure. A failed request never becomes a successful empty search. */
export async function runProvider(input: {
  bundle: ProviderEvalBundle; provider: ContextEvalProvider; runId: string;
  repetitions: number; cutoffs?: number[];
}): Promise<ProviderEvalRun> {
  const bundle = parseBundle(input.bundle);
  if (!Number.isInteger(input.repetitions) || input.repetitions < 1) throw new Error("Invalid repetitions");
  id.parse(input.runId);
  const protocol = runSchema.shape.protocol.parse({kind: "retrieval-only", repetitions: input.repetitions, cutoffs: input.cutoffs ?? [1, 5]});
  if (!unique(protocol.cutoffs.map(String))) throw new Error("Duplicate cutoffs");
  const descriptor = descriptorSchema.parse(input.provider.descriptor);
  if (descriptor.corpus_sha256 !== corpusHash(bundle)) throw new Error("Provider corpus does not match bundle");
  const sourceIds = new Set(bundle.sources.map(source => source.id));
  const rows: ProviderEvalRun["rows"] = [];
  for (let repetition = 1; repetition <= input.repetitions; repetition++) {
    for (const item of bundle.cases) {
      if (item.query === null) continue;
      let response: ProviderResponse;
      try {
        response = providerResponseSchema.parse(await input.provider.search({
          query: item.query, limit: item.limit, scope: bundle.scope
        }));
        if (response.ranked_source_ids && (response.ranked_source_ids.length > item.limit ||
            response.ranked_source_ids.some(id => !sourceIds.has(id)))) {
          throw new Error("Provider returned an invalid canonical source mapping");
        }
      } catch {
        // Do not serialize raw provider errors: they may contain private URLs or headers.
        response = {status: "error", ranked_source_ids: null, synthesized_answer: null,
          error_code: "provider_call_or_contract_failed", latency_ms: null};
      }
      rows.push({case_id: item.case_id, repetition, response});
    }
  }
  return parseRun({schema_version: "provider-eval-run.v1", run_id: input.runId,
    bundle_sha256: bundleHash(bundle), provider: input.provider.descriptor,
    protocol, rows}, bundle);
}

export function summarizeRun(run: ProviderEvalRun, bundle: ProviderEvalBundle) {
  const valid = parseRun(run, bundle);
  const cases = new Map(bundle.cases.map(c => [c.case_id, c]));
  const ranked = valid.rows.filter(row => row.response.status === "success" && row.response.ranked_source_ids !== null);
  const observations = ranked.map(row => ({case_id: `${row.case_id}:${row.repetition}`,
    positive_ids: cases.get(row.case_id)!.required_ids,
    returned_ids: row.response.ranked_source_ids!, latency_ms: row.response.latency_ms ?? 0}));
  const computed = computeRetrievalEvalMetrics(observations, valid.protocol.cutoffs);
  // The legacy metric requires a numeric latency. Never report placeholder zeros as measured latency.
  const latencies = valid.rows.flatMap(row => row.response.latency_ms === null ? [] : [row.response.latency_ms]);
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : null;
  return {
    total_observations: valid.rows.length, ranked_observations: ranked.length,
    error_count: valid.rows.filter(r => r.response.status === "error").length,
    unknown_rank_count: valid.rows.filter(r => r.response.status !== "error" && r.response.ranked_source_ids === null).length,
    unreviewed_case_count: bundle.cases.filter(c => c.label.review_status !== "reviewed").length,
    behavior_scenarios_not_executed: bundle.cases.map(c => c.case_id),
    rank_metrics: ranked.length ? {case_count: computed.case_count, hit_at_k: computed.hit_at_k,
      recall_at_k: computed.recall_at_k, mrr: computed.mrr, zero_result_count: computed.zero_result_count} : null,
    latency_ms: {measured_count: sorted.length, unknown_count: valid.rows.length - sorted.length,
      p50: percentile(0.5), p95: percentile(0.95)}
  };
}

export function compareRuns(bundle: ProviderEvalBundle, baselineInput: unknown, candidateInput: unknown) {
  const baseline = parseRun(baselineInput, bundle), candidate = parseRun(candidateInput, bundle);
  if (baseline.provider.mode !== candidate.provider.mode || canonicalJson(baseline.protocol) !== canonicalJson(candidate.protocol)) {
    throw new Error("Comparison requires the same protocol and observation mode");
  }
  const cases = new Map(bundle.cases.map(c => [c.case_id, c]));
  const rowKey = (row: ProviderEvalRun["rows"][number]) => `${row.case_id}:${row.repetition}`;
  const candidates = new Map(candidate.rows.map(row => [rowKey(row), row]));
  const changes = baseline.rows.map(before => {
    const after = candidates.get(rowKey(before))!;
    const item = cases.get(before.case_id)!;
    const values = (row: typeof before) => {
      const ids = row.response.ranked_source_ids;
      if (row.response.status !== "success" || ids === null) return null;
      const index = ids.findIndex(key => item.required_ids.includes(key));
      return {rank: index < 0 ? null : index + 1,
        reciprocal_rank: index < 0 ? 0 : 1 / (index + 1),
        recalled: ids.filter(key => item.required_ids.includes(key)).length / item.required_ids.length,
        recall_at_k: baseline.protocol.cutoffs.map(k => ids.slice(0, k).filter(key => item.required_ids.includes(key)).length / item.required_ids.length)};
    };
    const b = values(before), a = values(after);
    const regression = b !== null && (a === null || a.reciprocal_rank < b.reciprocal_rank || a.recalled < b.recalled ||
      a.recall_at_k.some((v, i) => v < b.recall_at_k[i]!));
    return {case_id: before.case_id, repetition: before.repetition,
      before_status: before.response.status, after_status: after.response.status,
      before: b, after: a, regression, comparable: a !== null && b !== null};
  });
  const regressionCount = changes.filter(c => c.regression).length;
  const unknownCount = changes.filter(c => !c.comparable).length;
  return {schema_version: "provider-eval-comparison.v1", bundle_sha256: bundleHash(bundle),
    baseline: {provider: baseline.provider, ...summarizeRun(baseline, bundle)},
    candidate: {provider: candidate.provider, ...summarizeRun(candidate, bundle)},
    changes, regression_count: regressionCount, uncomparable_count: unknownCount,
    status: regressionCount ? "regression" : unknownCount || changes.length === 0 ? "incomplete" : "no_observed_retrieval_regression",
    adoption_eligible: false,
    limitation: "Retrieval-only comparison. Behavior scenarios are not executed; labels retain their review status. This is not an adoption decision."};
}
