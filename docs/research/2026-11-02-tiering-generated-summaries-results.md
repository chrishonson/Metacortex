# TIERING #128: results with generated summaries

Evaluation results for Card 128, extending the tiering study from [2026-10-30-tiering-evaluation-plan.md](2026-10-30-tiering-evaluation-plan.md) and [2026-10-30-tiering-evaluation-results.md](2026-10-30-tiering-evaluation-results.md). Reproduce with `npm --prefix functions run eval:tiering`. Pinned in `functions/test/tieringEvaluation.test.ts`.

Corpus: `tiering-frozen-v1`, sha256 `1547197f75825f18ec33c26955d0175e6d2e28f2b06f9a8d80fee92c08d132e9`, 24 memories, 18 synthetic queries.

## Generation Configuration

- Model: `gemini-3.5-flash`
- Provider and location: Vertex AI, `global`
- Temperature: 0
- Prompt constant:
  `Write a search-result summary of the memory content below that keeps the decisive fact, in at most 220 characters. Return only the summary text without preamble or quotes.`
- Generation run: Single offline batch run executed once on 2026-11-02 (`functions/eval/tiering/generated-summaries.json`). Summaries were kept from the first full run without regeneration or score cherry-picking.

## Results

| Variant | hit@1 | recall@5 | MRR | Answerability | Payload tokens/query |
|---|---|---|---|---|---|
| B0 baseline | 0.833 | 1.000 | 0.907 | 0.444 | 153.4 |
| V4 hand-written (oracle) | 0.833 | 1.000 | 0.907 | 1.000 | 68.8 |
| V4 generated | 0.833 | 1.000 | 0.907 | 1.000 | 121.6 |

Ranking metrics (hit@1, recall@5, MRR) are identical between B0 and both V4 variants because V4 only alters the returned payload text, leaving full-content indexing and cosine ranking untouched.

Local ranking latency remained under 1 ms across all variants.

## Measured Token Usage

Across all 24 memories:

| Metric | Prompt tokens | Output (candidate) tokens | Thought tokens | Total tokens |
|---|---|---|---|---|
| Total (24 memories) | 1,680 | 535 | 12,332 | 14,547 |
| Mean per memory | 70.00 | 22.29 | 513.83 | 606.13 |

Because `gemini-3.5-flash` is a reasoning model, thought tokens represent the majority of generated tokens (mean 513.8 thought tokens vs 22.3 candidate output tokens).

## Shortfall Analysis

Shortfall criteria: keys whose generated summary fails `isAnswerable` against the memory's `oracle_summary` terms (requiring at least 50% keyword overlap with the decisive fact).

Result: 0 shortfalls out of 24 memories (`v4_generated_shortfalls: []`). Every single generated summary preserved the decisive fact terms required by `isAnswerable`.

Below is the generated text alongside the oracle text for all 24 memories:

| Key | Oracle summary | Generated summary | Answerable |
|---|---|---|---|
| ktor-darwin | Shared Kotlin client: Ktor with Darwin engine on iOS, OkHttp on Android. | The shared Kotlin networking layer uses Ktor HttpClient with the Darwin engine on iOS and the OkHttp engine on Android. | Yes |
| retrofit-legacy | Retired Android client used Retrofit and Gson, no iOS. | The retired Android-only client used Retrofit with Gson and had no iOS implementation. | Yes |
| vector-dimensions | Vector index and GEMINI_EMBEDDING_DIMENSIONS both 768, cosine distance. | Firestore vector indexes and GEMINI_EMBEDDING_DIMENSIONS must both use 768 dimensions with cosine distance. | Yes |
| firestore-mode | Database must be Firestore Native mode, not Datastore mode. | The MetaCortex database must be configured to use Firestore Native mode instead of Datastore mode. | Yes |
| client-scoping | MCP client profiles are restricted by token, tool allowlist, branch-state allowlist and origin allowlist. | Each custom MCP client profile has its own unique bearer token, tool allowlist, branch-state allowlist, and browser origin allowlist. | Yes |
| cors-default | MCP_ALLOWED_ORIGINS covers only the admin endpoint and denies browser origins by default. | MCP_ALLOWED_ORIGINS applies only to the default admin endpoint and defaults to denying browser origins. | Yes |
| write-fingerprint | Duplicate writes are deduplicated for fifteen minutes; fingerprints kept thirty days. | Write fingerprints suppress duplicate memory writes for 15 minutes, while the fingerprint document is retained for 30 days. | Yes |
| consolidation | Consolidation deprecates source records and sets superseded_by to the merged id. | Consolidation merges 2+ source memories into one active record, deprecating sources with superseded_by pointing to the merged ID. | Yes |
| deploy-region | Functions deploy to us-central1 to stay near the nam5 Firestore database. | Cloud Functions are deployed to us-central1 because the Firestore database lives in nam5 and cross-region calls added latency. | Yes |
| backup-schedule | Full backups run nightly at 03:00 UTC and archives are pushed weekly on Sundays. | Full Firestore backups run nightly at 03:00 UTC, and portable archives are pushed weekly on Sundays. | Yes |
| restore-prune | Restores prune destination documents not present in the archive. | When restoring an archive, documents in the destination collection that are not present in the archive are pruned. | Yes |
| ttl-policy | Write fingerprints expire after thirty days while event logs expire after ninety days. | Write fingerprints expire after thirty days via TTL, whereas event log records are retained for ninety days. | Yes |
| oauth-transition | Direct API key authentication retired on November 15 in favor of OAuth. | MetaCortex authentication migrated exclusively to OAuth; direct API key authentication was retired on November 15. | Yes |
| embedding-model | Production uses text-embedding-004 with 768 dimensions. | Production embeddings use text-embedding-004 pinned to 768 dimensions. | Yes |
| merge-model | Consolidation merge pipeline uses gemini-3.5-flash with temperature zero. | The consolidation merge pipeline uses gemini-3.5-flash at temperature zero. | Yes |
| search-payload | Search results return the first 220 characters of each matched memory. | Search responses return the first 220 characters of each matched memory as the summary payload. | Yes |
| compose-ui | Android UI uses Jetpack Compose with Material 3. | The Android app UI is built with Jetpack Compose and Material 3 theming. | Yes |
| swiftui-ios | iOS shell uses SwiftUI and links the shared Kotlin module. | The iOS shell uses SwiftUI and embeds the shared Kotlin module as an XCFramework. | Yes |
| ci-node | CI verification gates run on Node 22. | CI runs verification gates on Node 22 to match the Cloud Functions engine. | Yes |
| rate-limit | Clients are rate limited to sixty requests per minute. | Each client is rate limited to 60 search requests per minute. | Yes |
| datastore-history | Early prototype used Datastore mode before vector search was added. | An early prototype stored memories in Datastore mode before migrating to vector search. | Yes |
| cost-cap | Monthly Gemini spend is capped at twenty dollars. | Monthly Gemini spend is capped at $20 by a budget alert. | Yes |
| archive-format | Portable archives are newline-delimited JSON grouped by topic. | Portable archives are newline-delimited JSON files grouped by topic. | Yes |
| fetch-audit | Fetch calls write retrieval events for implicit relevance feedback. | Every fetch_context call writes a retrieval event used for implicit relevance labels. | Yes |

## Cost Per Write

List prices for `gemini-3.5-flash` are not documented in repository documentation (which only references `gemini-3.1-flash-lite` in earlier research docs).

Assumptions and source:
- Billed input tokens: $0.15 per 1,000,000 tokens ($0.00015 per 1,000 tokens).
- Billed output tokens (including candidates output and thoughts/reasoning tokens billed at output rates): $0.60 per 1,000,000 tokens ($0.00060 per 1,000 tokens).
- Source: Standard Vertex AI / Google Gen AI list pricing for Gemini Flash models (context length <= 128k).

Formula:
```
cost_per_write = (prompt_tokens * input_price + (output_tokens + thought_tokens) * output_price) / 1,000,000
```

Using measured mean tokens per write:
- Prompt tokens: 70.00
- Output candidate tokens: 22.29
- Thought tokens: 513.83
- Total output tokens (candidate + thought): 536.125

Calculation:
- Input cost: 70.00 * ($0.15 / 1,000,000) = $0.00001050
- Output cost: 536.125 * ($0.60 / 1,000,000) = $0.000321675
- Cost per write: $0.000332175 (approx $0.000332, or 0.033 cents per write)
- Cost per 1,000 writes: $0.332175 (approx $0.33 per 1,000 writes)

Context comparison:
At 1,000 writes per month, $0.332 per month is well within the $1.00-per-month threshold described in the plan doc (noted as context only, as that threshold was defined for ranking variants V2 and V3).

## Go/No-Go Decision

Criterion from the plan doc:
Answerability at least 20 points above B0 (+0.2000) and no regression, where regression is defined as lower recall@5 than B0 or more than 10% higher payload tokens.

Observed:
- Answerability: 1.0000 vs B0's 0.4444 (gain of +0.5556, or +55.56 percentage points).
- Recall@5: 1.0000 vs B0's 1.0000 (no drop).
- Payload tokens per query: 121.6111 vs B0's 153.3889 (down 20.7%, no growth).
- Regression: false.

Outcome: **GO**.

Offline generated summaries using `gemini-3.5-flash` at temperature 0 reliably extract and preserve decisive facts across both short notes and long notes with filler, raising answerability to 1.0000 while reducing payload token consumption by 20.7% relative to B0 truncation.

## Limitations

1. Ranking uses the deterministic local hashed bag-of-words embedder, not Gemini embeddings. Only the payload answerability and token consumption effects of V4 are tested here.
2. A generated summary can drop decisive facts in unconstrained domains or with more complex source documents; here on the 24-memory frozen corpus, 0 dropped facts occurred.
3. Only a single run at temperature 0 was evaluated on 24 synthetic memories and 18 synthetic queries.
4. Token pricing uses standard Vertex AI list price assumptions rather than direct billing records.
