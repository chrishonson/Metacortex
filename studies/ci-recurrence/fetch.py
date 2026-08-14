"""Collect CI failure events from the GitHub Actions API. Read-only, disk-cached.

Every API response is written to cache/ keyed by URL hash, so re-runs never
re-fetch and the 90-day window can be rebuilt offline.

ONE NON-OBVIOUS CORRECTNESS POINT, and it drives the whole fetch strategy:

  You cannot find flakes by listing `status=failure` runs. When a failed run is
  re-run and passes, GitHub REWRITES the run's conclusion to `success`. The
  flaky run then disappears from the failure list entirely -- taking with it
  exactly the fail-then-pass evidence the flake split depends on. Filtering on
  failure would silently drop the flakes and leave a recurrence rate that
  cannot be corrected afterwards.

  So we list ALL completed runs, then pull jobs only for runs that are either
  non-success or have run_attempt > 1. A first-attempt success has no failed
  jobs and is skipped, which keeps the extra cost small.

Usage:
  uv run fetch.py --repo pytorch/pytorch --since-days 90 --max-runs 5000
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import db
from normalize import fingerprint, normalize

API = "https://api.github.com"
CACHE = pathlib.Path(__file__).parent / "cache"
UA = "ci-recurrence-study"


# ------------------------------------------------------------------ HTTP layer
class Gh:
    def __init__(self, token: str, cache: pathlib.Path = CACHE) -> None:
        self.token = token
        self.cache = cache
        self.cache.mkdir(parents=True, exist_ok=True)
        self.calls = 0
        self.cache_hits = 0

    def _cache_path(self, url: str) -> pathlib.Path:
        h = hashlib.sha256(url.encode()).hexdigest()[:24]
        return self.cache / f"{h}.json"

    def get(self, url: str, *, allow_404: bool = False) -> tuple[dict | list | None, int]:
        """Returns (payload, status). status 0 means served from disk cache."""
        cp = self._cache_path(url)
        if cp.exists():
            self.cache_hits += 1
            try:
                return json.loads(cp.read_text()), 0
            except json.JSONDecodeError:
                cp.unlink()  # corrupt cache entry; refetch

        delay = 2.0
        for attempt in range(5):
            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": UA,
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    body = json.loads(r.read().decode())
                    self.calls += 1
                    remaining = int(r.headers.get("X-RateLimit-Remaining", "1000"))
                    if remaining < 50:
                        reset = int(r.headers.get("X-RateLimit-Reset", "0"))
                        nap = max(0, reset - int(time.time())) + 5
                        print(f"  [rate limit] {remaining} left, sleeping {nap}s", file=sys.stderr)
                        time.sleep(nap)
                    cp.write_text(json.dumps(body))
                    return body, 200
            except urllib.error.HTTPError as e:
                if e.code == 404 and allow_404:
                    cp.write_text(json.dumps(None))
                    return None, 404
                # 403/429 here are secondary rate limits, not policy denials.
                if e.code in (403, 429):
                    reset = e.headers.get("X-RateLimit-Reset")
                    nap = max(0, int(reset) - int(time.time())) + 5 if reset else delay
                    print(f"  [{e.code}] backing off {nap}s", file=sys.stderr)
                    time.sleep(min(nap, 900))
                    delay *= 2
                    continue
                if 500 <= e.code < 600:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise
            except (urllib.error.URLError, TimeoutError):
                time.sleep(delay)
                delay *= 2
        return None, -1


# ------------------------------------------------------------- evidence picking
def pick_evidence(gh: Gh, repo: str, job: dict) -> tuple[str, str]:
    """Return (evidence_kind, raw_message). Annotations preferred over logs."""
    job_id = job["id"]
    ann, status = gh.get(f"{API}/repos/{repo}/check-runs/{job_id}/annotations", allow_404=True)
    if isinstance(ann, list) and ann:
        # failure annotations first; a job often carries warnings too
        msgs = [a for a in ann if (a.get("annotation_level") or "").lower() == "failure"] or ann
        parts = []
        for a in msgs[:5]:
            loc = a.get("path") or ""
            line = a.get("start_line")
            title = (a.get("title") or "").strip()
            body = (a.get("message") or "").strip()
            parts.append(f"{loc}:{line}: {title} {body}".strip())
        return "annotation", "\n".join(parts)

    # Fallback: the failed step's name. Weak evidence, but it is evidence, and
    # marking it as such is what keeps the coverage fraction honest.
    for step in job.get("steps") or []:
        if step.get("conclusion") == "failure":
            return "step_name", f"step failed: {step.get('name')}"
    return "none", ""


# ------------------------------------------------------------------ collection
def collect(repo: str, since_days: int, max_runs: int, token: str, workflows: set[str] | None) -> None:
    con = db.connect()
    gh = Gh(token)
    since = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%Y-%m-%d")
    db.meta_set(con, f"window_start:{repo}", since)
    db.meta_set(con, f"since_days:{repo}", str(since_days))

    seen_runs = 0
    page = 1
    events = 0
    while seen_runs < max_runs:
        url = (
            f"{API}/repos/{repo}/actions/runs"
            f"?status=completed&created=%3E%3D{since}&per_page=100&page={page}"
        )
        payload, status = gh.get(url)
        if not payload or not payload.get("workflow_runs"):
            break
        runs = payload["workflow_runs"]
        con.execute(
            "INSERT OR REPLACE INTO fetch_log(repo,kind,ref,status,ok,note,fetched_at) VALUES(?,?,?,?,?,?,?)",
            (repo, "runs_page", str(page), status, 1, f"{len(runs)} runs", db.now()),
        )

        for run in runs:
            seen_runs += 1
            if workflows and run.get("name") not in workflows:
                continue
            # See module docstring: a first-attempt success cannot contain a
            # failed job, but a re-run success can (that is the flake).
            if run.get("conclusion") == "success" and run.get("run_attempt", 1) <= 1:
                continue
            events += ingest_run(gh, con, repo, run)

        con.commit()
        print(f"  page {page}: {seen_runs} runs scanned, {events} failure events, "
              f"{gh.calls} api calls, {gh.cache_hits} cached", file=sys.stderr)
        page += 1
        if len(runs) < 100:
            break

    db.meta_set(con, f"runs_scanned:{repo}", str(seen_runs))
    con.commit()
    print(f"[{repo}] {seen_runs} runs scanned -> {events} failure events "
          f"({gh.calls} api calls, {gh.cache_hits} cache hits)")


def ingest_run(gh: Gh, con, repo: str, run: dict) -> int:
    run_id = run["id"]
    # filter=all returns every ATTEMPT's jobs, which is what makes the
    # fail-then-pass flake visible.
    jobs_payload, status = gh.get(
        f"{API}/repos/{repo}/actions/runs/{run_id}/jobs?filter=all&per_page=100"
    )
    con.execute(
        "INSERT OR REPLACE INTO fetch_log(repo,kind,ref,status,ok,note,fetched_at) VALUES(?,?,?,?,?,?,?)",
        (repo, "jobs", str(run_id), status, 1 if jobs_payload else 0, None, db.now()),
    )
    if not jobs_payload:
        return 0

    n = 0
    for job in jobs_payload.get("jobs", []):
        # Record every job outcome, not just failures: the successes are what
        # make a fail-then-pass on one head SHA detectable as a flake.
        con.execute(
            """INSERT OR REPLACE INTO job_outcome
               (repo,run_id,job_id,run_attempt,workflow,job_name,head_sha,conclusion,started_at)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (
                repo, run_id, job["id"], job.get("run_attempt", run.get("run_attempt", 1)),
                run.get("name"), job.get("name"), run.get("head_sha", ""),
                job.get("conclusion"), job.get("started_at") or run.get("created_at"),
            ),
        )
        if job.get("conclusion") != "failure":
            continue
        kind, raw = pick_evidence(gh, repo, job)
        norm = normalize(raw)
        fp = fingerprint(raw)
        con.execute(
            """INSERT OR REPLACE INTO failure_event
               (event_id,repo,run_id,run_attempt,job_id,workflow,job_name,head_sha,head_branch,
                trigger_event,started_at,completed_at,failed_step,evidence_kind,raw_message,
                norm_message,fingerprint,fetched_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                f"{repo}:{run_id}:{job['id']}", repo, run_id,
                job.get("run_attempt", run.get("run_attempt", 1)), job["id"],
                run.get("name"), job.get("name"), run.get("head_sha", ""),
                run.get("head_branch"), run.get("event"),
                job.get("started_at") or run.get("created_at"), job.get("completed_at"),
                next((s.get("name") for s in job.get("steps") or []
                      if s.get("conclusion") == "failure"), None),
                kind, raw, norm, fp, db.now(),
            ),
        )
        n += 1
    return n


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True, help="owner/name")
    p.add_argument("--since-days", type=int, default=90)
    p.add_argument("--max-runs", type=int, default=100000)
    p.add_argument("--workflow", action="append", default=None,
                   help="restrict to these workflow names (repeatable); useful for pytorch")
    a = p.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    if not token:
        print("set GITHUB_TOKEN (a classic or fine-grained PAT with public_repo)", file=sys.stderr)
        return 2
    collect(a.repo, a.since_days, a.max_runs, token, set(a.workflow) if a.workflow else None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
