# TIERING #83: hypotheses and frozen corpus

Written and committed before any experiment ran. Results go in `2026-10-30-tiering-evaluation-results.md` and must not change this file.

## Frozen corpus

`functions/eval/tiering/corpus.json`, `tiering-frozen-v1`, sha256 `1547197f75825f18ec33c26955d0175e6d2e28f2b06f9a8d80fee92c08d132e9`.

24 synthetic memories and 18 queries with labeled relevant memories. The first 8 memories and 6 queries are copied from the existing isolated retrieval evaluation (`functions/scripts/retrieval-eval.ts`), which stays unchanged. Eight memories are long notes whose decisive fact sits after about 230 characters of filler, so the current 220-character search summary truncates it. Eight are distractors. Queries run without a topic filter, which is harder than the existing evaluation. Each memory has a hand-written `oracle_summary`, an optimistic stand-in for an LLM-generated summary. No live data, Firestore or paid model is used.

## Retained baseline

B0: index the full content (the current `retrieval_text` behavior), rank by cosine similarity, return the current 220-character truncated summary per hit, and fetch full content on demand.

The experiment cannot call Gemini embeddings. All variants use one deterministic local embedder (hashed bag of stemmed words, cosine). Absolute numbers therefore describe that embedder. Only the relative difference between variants is evidence.

## Variants

- V1, L0 index: index only the first sentence (an extractive L0 abstract) instead of full content.
- V2, generated-summary index: index `oracle_summary` instead of full content.
- V3, dual index: score each memory as the max of full-content and `oracle_summary` similarity.
- V4, generated-summary payload: B0 ranking, but return `oracle_summary` instead of the truncated summary.

## Hypotheses

- H1: V1 lowers index cost but loses recall@5 on long notes. Expect a regression.
- H2: V2 or V3 improves MRR by at least 0.05 over B0 without lowering recall@5.
- H3: V4 makes the search payload answer the query (decisive fact present in the returned summary) more often than B0 at no higher payload token cost.

## Metrics

Quality: hit@1, recall@5 and MRR using the existing `computeRetrievalEvalMetrics`. Answerability: share of cases where every positive memory's returned summary contains its decisive fact, judged by the fixture's `oracle_summary` keyword overlap with the returned text.

Cost: indexed tokens (characters/4) per memory, embedding calls per write, generation calls per write, search payload tokens per query at k=5, and local ranking latency.

## Regression and go/no-go criteria

- Regression: any variant with lower recall@5 than B0, or more than 10% higher search payload tokens.
- Go for a ranking variant (V2, V3): MRR at least B0 + 0.05, no regression, and the extra write cost (one generation call per write) estimated at under $1 per month at current volume.
- Go for the payload variant (V4): answerability at least 20 points above B0 with no regression.
- Otherwise no-go. Because `oracle_summary` is hand-written, a go is provisional until confirmed with real generated summaries and Gemini embeddings. A no-go stands, since real summaries can only be worse than the oracle.
