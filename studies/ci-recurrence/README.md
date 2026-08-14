# CI failure recurrence study

**Question.** Over 90 days on one repo, walk failure events chronologically. A
failure is a RECURRENCE if its fingerprint appeared earlier in the window.
`rate = recurrences / total_failures`.

**Decision rule.** Below roughly 30% at the most defensible fingerprinting, the
premise is dead.

## Status

Tier 0 and the collection/analysis path are built and tested. **No recurrence
rate has been computed yet** — the session this was written in cannot reach the
GitHub Actions API for `pytorch/pytorch` or `ankidroid/Anki-Android` (see
`findings.md`). Run the two commands below on the study machine and the numbers
drop out.

The Tier 1 clustering loop is deliberately **not built yet**. It should not be
written until the Tier 0 collapse rate says how many singletons it would have
to chew through — that number decides whether Tier 1 is a night of local
inference or a week of it.

## Run it

```bash
export GITHUB_TOKEN=<personal PAT, public_repo scope, read-only>

uv run fetch.py   --repo ankidroid/Anki-Android --since-days 90
uv run analyze.py --repo ankidroid/Anki-Android --top 50
```

`fetch.py` caches every API response under `cache/` keyed by URL hash, so a
re-run costs no API calls and the window can be rebuilt offline. `analyze.py`
touches no network and no model — rerun it freely.

For pytorch, scope the crawl or it will run for hours:

```bash
uv run fetch.py --repo pytorch/pytorch --since-days 90 \
  --workflow trunk --workflow pull --max-runs 5000
```

Tests (no network, no model, no tokens):

```bash
uv run test_pipeline.py
```

## The cascade

| Tier | Who | Handles | Cost |
|---|---|---|---|
| 0 | regex normalizer | everything with a matching fingerprint | free, reproducible, hashable |
| 1 | local model via Ollama | Tier 0 singletons only | electricity |
| 2 | Gemini Flash | low-confidence Tier 1, or when local is the bottleneck | metered |
| 3 | coordinator | audit of 20 sampled labels per batch | attention |

Tier 0 is the one that matters. An LLM label is not reproducible and not
hashable; a regex fingerprint is both. Every event Tier 0 places in a group of
2+ is an event no worker ever has to look at.

## Files

| File | What |
|---|---|
| `schema.sql` | SQLite: queue, cache, and checkpoint in one file |
| `normalize.py` | **Tier 0.** Normalization rules + fingerprint |
| `fetch.py` | GitHub Actions collector, disk-cached, read-only |
| `analyze.py` | Flake split, Tier 0 collapse stats, chronological walk |
| `prompts.py` | **Tier 1 worker prompt.** Version it on every edit |
| `dispatch.py` | The whole harness: one `ask()`, content-hash cache, retry, tokens |
| `test_pipeline.py` | Known-answer tests for the model-free parts |

## Three decisions worth arguing with

**Exit codes survive number-stripping.** `exit code 137` is an OOM kill and
`exit code 143` is a timeout; `exit code 1` is a test failing. Stripping them as
"bare ints" merges infrastructure failures into test failures and inflates the
rate. `KEEP_EXIT_CODES` in `normalize.py` toggles it so the collapse rate can be
reported both ways.

**Path basenames survive, directory prefixes don't.** `test_nn.py` and
`test_optim.py` are different failures; `/home/runner/work/...` vs
`/opt/actions-runner/_work/...` is the same failure on a different machine. So
absolute paths collapse to `<PATH>/test_nn.py`. Repo-relative paths from Check
Run annotations are left fully intact — they are identical on every runner, so
they are signal, not noise.

**The worker is told to answer "different" when torn.** Merging is the
destructive direction: every bad merge turns a first-seen failure into a
recurrence and pushes the rate up, toward the 30% line we are testing against.
The reported rate is therefore a lower bound, which is the only version worth
betting on.

## One correctness trap, documented so nobody re-introduces it

You cannot find flakes by listing `status=failure` runs. When a failed run is
re-run and passes, GitHub **rewrites the run's conclusion to `success`** — the
flaky run vanishes from the failure list, taking the fail-then-pass evidence
with it. So `fetch.py` lists all *completed* runs and pulls jobs for any run
that is non-success **or** has `run_attempt > 1`, and records every job outcome
including successes. Filtering on failure would silently drop the flakes and
leave a rate that cannot be corrected after the fact.
