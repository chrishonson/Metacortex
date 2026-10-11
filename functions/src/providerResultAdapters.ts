import { z } from "zod";
import type { ProviderResponse } from "./providerEvaluation.js";

const metaPayload = z.object({matches: z.array(z.object({id: z.string().min(1)}))});
// Pinned to Onyx v4.7.1, commit 4316ec0706894e4a9751ac032f6d7816aca66142.
// Current website examples use a different shape. Never infer IDs from titles.
const onyxPayload = z.object({results: z.array(z.object({
  url: z.string().nullable(), content: z.string(), title: z.string()
}))});

/** Caller retains the native response as restricted evidence. This function only normalizes ranks. */
export function normalizeSearchResult(input: {
  provider: "metacortex" | "onyx-v4.7.1"; payload: unknown;
  sourceMap: ReadonlyMap<string, string>; limit: number; latencyMs: number | null;
}): ProviderResponse {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("Invalid source cap");
  const base = {synthesized_answer: null, latency_ms: input.latencyMs};
  if (input.payload && typeof input.payload === "object" && "error" in input.payload && input.payload.error) {
    return {...base, status: "error", ranked_source_ids: null, error_code: "provider_error_payload"};
  }
  let nativeIds: (string | null)[];
  if (input.provider === "metacortex") {
    const parsed = metaPayload.safeParse(input.payload);
    if (!parsed.success) return {...base, status: "error", ranked_source_ids: null, error_code: "invalid_metacortex_payload"};
    nativeIds = parsed.data.matches.map(m => m.id);
  } else {
    const parsed = onyxPayload.safeParse(input.payload);
    if (!parsed.success) return {...base, status: "error", ranked_source_ids: null, error_code: "invalid_onyx_payload"};
    nativeIds = parsed.data.results.map(m => m.url);
  }
  // Check the whole native response before truncation: out-of-corpus results cannot be hidden by the cap.
  if (nativeIds.some(native => native === null || !input.sourceMap.has(native))) {
    return {...base, status: "unknown", ranked_source_ids: null, error_code: "unmapped_native_source"};
  }
  const canonicalIds = [...new Set(nativeIds.map(native => input.sourceMap.get(native!)!))];
  return {...base, status: "success", ranked_source_ids: canonicalIds.slice(0, input.limit), error_code: null};
}
