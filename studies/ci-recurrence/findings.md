# Findings

## Verdict: not yet reached

No recurrence rate has been computed, so the 30% decision rule has **not** been
evaluated. The premise is neither supported nor dead. This file gets the verdict
once `analyze.py` runs against fetched data.

## Why no number yet

The session this was built in cannot reach the GitHub Actions API for either
target repo. Both access paths are closed:

| Path | Result |
|---|---|
| `curl api.github.com/repos/ankidroid/Anki-Android/actions/runs` | `403` — "GitHub access to this repository is not enabled for this session" |
| `curl .../repos/pytorch/pytorch/actions/runs` | `403`, same |
| `mcp__github__actions_list` on either target | `Access denied: not configured for this session. Allowed repositories: chrishonson/metacortex` |
| `add_repo` with API access for a third-party repo | denied by the permission classifier |

`api.github.com` itself is reachable — `/rate_limit` returns 200 with a
15000/hr budget — so this is per-repository authorization, not a network or
egress block.

The one repository this session *can* reach, `chrishonson/Metacortex`, has 24
workflow runs in its entire history and **zero failures** (18 success, 6
skipped, all from two Claude Code workflows). There is no failure corpus in it
to fingerprint, so it cannot stand in even as a smoke test of the real numbers.

Per the brief's own instruction — *"if you find yourself three files deep in
infrastructure without a fingerprint computed, stop and tell me"* — collection
stopped here rather than continuing to build the Tier 1 loop on top of an
unmeasured Tier 0.

## What is built and verified

Everything up to the API call, tested with known-answer fixtures
(`uv run test_pipeline.py`, 20/20 passing):

- **Tier 0 normalizer** — verified to collapse the same bug across differing
  paths, line numbers, and float values; verified to keep `test_nn.py` distinct
  from `test_optim.py`, and `exit code 1` distinct from `exit code 137`;
  verified idempotent on its own output.
- **Chronological recurrence walk** — verified against a hand-built sequence
  with a known rate, including that no-evidence events are excluded from the
  numerator/denominator but still counted in log coverage.
- **Flake split** — both shapes verified (later attempt of the same run passed;
  later run on the identical head SHA passed).
- **Ingest path** — verified end-to-end against canned API payloads: annotation
  evidence preferred, step-name fallback when a job has no annotations, and
  every job outcome recorded including successes.

Two real bugs were found and fixed by this testing, both of which would have
quietly corrupted the headline number:

1. A port rule (`:\d{4,5}`) fired on **four-digit line numbers** before the
   line/column rule could see them, so `test_nn.py:1234:5` and
   `test_nn.py:998:11` fingerprinted differently. In a repo the size of pytorch
   this shatters collapse across every large file — it would have understated
   the recurrence rate badly. The rule was removed; ports fall through to the
   generic int rule, which is equally stable.
2. The absolute-path rule matched the `/src/Foo.kt` tail inside a
   **repo-relative** `app/src/Foo.kt`, mangling it to `app<PATH>/Foo.kt`.
   Repo-relative paths are exactly what Check Run annotations carry, and they
   are identical on every runner — signal, not noise. Now only absolute paths
   collapse.

## To finish this

On a machine with a personal PAT:

```bash
export GITHUB_TOKEN=<read-only PAT>
uv run fetch.py   --repo ankidroid/Anki-Android --since-days 90
uv run analyze.py --repo ankidroid/Anki-Android --top 50
```

AnkiDroid first: it is small enough to complete in one sitting and gives a real
Tier 0 collapse rate to size Tier 1 against. pytorch needs a scoped crawl
(`--workflow trunk --workflow pull --max-runs 5000`); at ~1000+ completed runs
a day, a full 90-day walk of it is several hours of API calls even with the
15000/hr budget, and that projection should be re-checked against the actual
page-1 `total_count` before committing to it.

## Open items, in order

1. Tier 0 collapse rate and log coverage on AnkiDroid — no tokens required.
2. Singleton count from step 1 sizes Tier 1. If singletons run to six figures,
   a 20b-class model on one M1 Max will not finish overnight and the split has
   to push toward Flash; that call is not worth making before the number exists.
3. Only then build the Tier 1 batch loop and the audit sampler.
