# S4 provider evaluation — first implementation slice

Status: implemented local evaluation tooling, 2026-09-10. The first S4 milestone
compares current MetaCortex with self-hosted open-source Onyx before expanding
custom retrieval. Unblocked and paid SaaS are excluded. Control-plane dispatch,
leases and canonical memory writes stay unchanged during the comparison.

## What works now

The existing `functions/scripts/retrieval-eval.ts` entry point now supports local
bundles and comparison files. It reuses `computeRetrievalEvalMetrics`; there is no
second ranking metric implementation. File commands do not load deployment env
files or initialize Firebase. The existing Firestore commands remain available
through the legacy implementation. Synthetic generated cases now correctly use
`synthetic_definition`, while observed fetch labels remain `implicit_fetch`.

The checked-in `functions/eval/s4/bundle.json` freezes nine synthetic source
records, eight behavior specifications and five retrieval queries. It contains
no private corpus export or real credentials. All eight labels remain marked
`needs_review`. The three scenarios without retrieval queries are shared worker
checks, not missing retrieval cases. None of the behavior specifications has yet
been executed against a real worker/model.

Each bundle validates source hashes and scope, unique case/source IDs, required
source references and incident grouping across splits. Its hash includes the
scenario, expected behavior, sources, labels and limits. Changing a label or
input creates a different comparison bundle. Output files use exclusive creation
and cannot overwrite prior results. Hashes establish consistency, not authorship
or tamper-proof storage. Files imported as recorded data cannot certify live runs.

`ContextEvalProvider` and `runProvider` define the retrieval boundary for adapters.
The runner preserves all case/repetition rows, including errors. Result normalizers
cover MetaCortex's `matches[].id` and the pinned Onyx release's `results[].url`.
Canonical IDs come from an explicit ingestion mapping, never document titles.
Multiple chunks of one source are deduplicated in first-occurrence order. Any
unmapped source, including beyond the result cap, makes ranking unknown. A caller
must retain native payloads separately as restricted evidence before normalization.

The report distinguishes errors, unknown ranks, successful empty results and
unmeasured latency. Ranking metrics apply only to observable ranked results and
state their denominator. The comparator examines every case/repetition for rank
and required-source recall losses. A better average cannot hide a per-case loss.
It requires matching bundle/corpus hashes, protocol and observation mode. Provider
versions and config hashes may differ because they describe the intervention.
The corpus hash is an adapter assertion; an ingestion reconciliation must verify
it against each actual index before live comparisons.

## Run locally

From `functions/` after installing dependencies:

```sh
npm run eval:files -- validate-bundle --bundle eval/s4/bundle.json
npm run eval:files -- freeze-bundle --input eval/s4/definition.json --out /tmp/s4-new-bundle.json
npm run eval:files -- compare-files --bundle eval/s4/bundle.json --baseline eval/s4/examples/scripted-baseline.json --candidate eval/s4/examples/scripted-candidate.json --out /tmp/s4-comparison.json
```

Use a new output path on subsequent runs. The scripted example intentionally
returns exit code **2**: one case improves while another regresses in each of
three repetitions. Both providers are explicitly named `scripted-*`. These files
exercise the comparator and are not MetaCortex or Onyx performance measurements.
No latency was measured for them. A clean observable retrieval comparison returns
0, a regression returns 2, an incomplete comparison returns 3, and invalid inputs
fail with 1. Every report keeps `adoption_eligible: false` because retrieval rank
alone cannot establish task success or provider suitability.

`import-recorded --bundle <bundle> --input <run> --out <new-run>` validates a
recorded run against the complete case/repetition matrix. A missing or duplicate
observation is an error, not a silently removed case. Native provider text and
credentials must not be embedded in diagnostic error strings; runner exceptions
produce a fixed diagnostic code.

## Verify the implementation

The new `verification.json` declares the existing build/test commands plus eval
CLI typechecking. `scripts/run-gate.py` follows the existing program executor
contract, copied from control-plane without creating a cross-repository runtime
dependency:

```sh
python3 scripts/run-gate.py metacortex_typecheck
python3 scripts/run-gate.py metacortex_test
```

Tests exercise source tampering, split leakage, label provenance, protocol drift,
failed/empty/unknown observations, repeated-case completeness, and the misleading
aggregate-score scenario. CLI tests execute the existing entry point with no
Firebase credentials. Existing HTTP integration tests need local socket access.

## Onyx preflight findings

Pinned candidate: **v4.7.1**, commit
`4316ec0706894e4a9751ac032f6d7816aca66142`, published 2026-09-08. This is a source
pin, not an installed or runtime-tested deployment. Record container image digests
when the deployment is created.

The pinned implementation disagrees with the current website example. Its
`search_indexed_documents` accepts query, source types, document set names,
time cutoff and a query-expansion switch. It has **no limit argument** and returns
`results` with title, URL, source type, content and update time. It does not expose
numeric scores or stable document IDs in this response. Use an ingestion manifest
mapping URLs to canonical source IDs. Client-side source caps must be reported
explicitly; they do not constrain Onyx's internal retrieval or generation budget.
Its search pipeline includes LLM selection/expansion, so this is a provider-system
comparison rather than an isolated ranker comparison.

Relevant source: [pinned MCP search implementation](https://github.com/onyx-dot-app/onyx/blob/4316ec0706894e4a9751ac032f6d7816aca66142/backend/onyx/mcp_server/tools/search.py).

Use Standard for indexed retrieval. Lite omits those services. The open-source
edition remains the only candidate; verify paid-edition restrictions against the
pinned deployment. Begin with a single authorized principal and synthetic corpus.
This does not establish multi-user access-control parity.
[Deployment modes](https://docs.onyx.app/deployment/overview),
[permission restriction](https://docs.onyx.app/overview/core_features/internal_search).

Local check on 2026-09-10: Docker CLI exists but the daemon was not running at the
default socket. No Onyx services, images, ingestion or paid resources were created.

## Next card: capture real work and establish the baseline

1. Connect one existing worker's observable model-input/tool boundary to the
   frozen cases. Keep user instructions such as no rotation as direct inputs in
   every provider arm. Capture supplied context and exact verification separately.
2. Implement the eight scenario assertions with reviewed evidence. Exercise both
   intended behavior and fault fixtures. Preserve all terminal outcomes. Do not
   treat model self-report as acceptance or relevance ground truth.
3. Reconcile a disposable MetaCortex corpus and Onyx corpus to the same source
   manifest, verify live schemas/auth, and retain native responses. No production
   collection resets or broad migrations.
4. Record a real MetaCortex baseline, then run Onyx using the same worker/model,
   sources and task constraints. Freeze cost/latency limits before candidate
   tuning and measure indexing/operational burden separately.
5. Produce per-case behavior and retrieval evidence plus a keep/adopt/gap decision.
   Expand custom graphs/ranking only if the evidence justifies them.

Real provider transport, ingestion, worker context capture, real-agent behavior
runs, independent label review and the Onyx comparison are still outstanding.
The earlier eight-query live retrieval pilot is a separate source-selected
experiment; it is not this five-query synthetic bundle or an end-to-end baseline.
