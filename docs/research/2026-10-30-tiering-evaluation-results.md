# TIERING #83: results

Plan and criteria: [2026-10-30-tiering-evaluation-plan.md](2026-10-30-tiering-evaluation-plan.md), committed in `fe05c41` before any run. Reproduce with `npm --prefix functions run eval:tiering`. `functions/test/tieringEvaluation.test.ts` pins the corpus hash and these decisions.

Corpus `tiering-frozen-v1`, sha256 `1547197f…08d132e9`, 24 memories, 18 queries. Local deterministic hashed embedder, no network.

## Results

| Variant | hit@1 | recall@5 | MRR | Answerability | Index tokens/memory | Embed calls/write | Generation calls/write | Payload tokens/query |
|---|---|---|---|---|---|---|---|---|
| B0 baseline | 0.833 | 1.000 | 0.907 | 0.444 | 45.4 | 1 | 0 | 153.4 |
| V1 L0 first sentence | 0.667 | 0.722 | 0.722 | 0.444 | 18.3 | 1 | 0 | 82.7 |
| V2 summary index | 1.000 | 1.000 | 1.000 | 0.444 | 16.7 | 1 | 1 | 130.3 |
| V3 dual index | 0.944 | 1.000 | 0.972 | 0.444 | 62.1 | 2 | 1 | 160.8 |
| V4 summary payload | 0.833 | 1.000 | 0.907 | 1.000 | 45.4 | 1 | 1 | 68.8 |

Ranking latency is under 10 ms for all variants locally and is not a differentiator.

## Hypotheses

- H1 confirmed. V1 cuts index tokens by 60% but drops recall@5 to 0.722, a regression.
- H2 supported only against an oracle. V2 gains 0.093 MRR and V3 0.065, with recall@5 unchanged. B0 recall@5 is already 1.0, so the gain is ordering only.
- H3 supported. V4 lifts answerability from 0.444 to 1.000 while cutting payload tokens 55%. The 220-character truncation hides the decisive fact in all 8 long notes and 2 of the paired cases.

## Write cost estimate

Analytical, not measured. One flash-lite generation call per write of about 300 input and 40 output tokens costs roughly $0.00005 at list prices near $0.10 per million input and $0.40 per million output tokens. At 1,000 writes per month that is about $0.05, under the $1 criterion. Pricing and write volume were not verified against billing.

## Decision

- V1: **no-go**. Regression on recall@5.
- V4, generated summary as the search payload: **provisional go**. It is the only variant that changes what an agent can do without a fetch, and it lowers payload cost. Before implementation, confirm with real generated summaries on the same frozen corpus and keep the answerability gain at 20 points or more.
- V2 and V3: **no-go for now**. They pass the numeric criteria only on hand-written summaries with recall already at ceiling. V2 would replace the embedded text and require a re-embedding migration, which the gain does not justify. Revisit only if a real-summary run of V4 is adopted and a recall gap appears on observed production cases.

Overall: no tiering ships from this card. The single follow-up worth a card is a V4 confirmation run with real generated summaries.

## Limitations

- Hashed bag-of-words embedder, not Gemini embeddings. Absolute numbers do not transfer. The relative V1 result (losing content loses recall) and the V4 payload result (truncation hides late facts) do not depend on the embedder.
- `oracle_summary` is hand-written, an upper bound for generated summaries. No model was called.
- 18 synthetic queries. One rank change moves MRR by about 0.03.
- Answerability is a term-overlap proxy against the oracle, which favors V4 by construction for payload text. The B0 failures are real truncations, checked by the test on `deploy-region`.
- No live Firestore, production data, observed cases or deployment were used.
