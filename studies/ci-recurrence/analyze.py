"""Flake split, Tier 0 collapse stats, and the chronological recurrence walk.

THE DEFINITION, verbatim from the brief:
  Walk failure events chronologically over the window. A failure is a
  RECURRENCE if its fingerprint appeared earlier in the window.
  rate = recurrences / total_failures.

Nothing here calls a model. Tier 0 numbers come out of this file alone, which
is the point: they are reproducible and cost nothing.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter

import db


# ----------------------------------------------------------------- flake split
def mark_flakes(con, repo: str) -> dict[str, int]:
    """Same head SHA, re-run, fail then pass => flake, not recurrence.

    Two shapes, both requiring an empty diff (identical head SHA, so nothing
    changed between the fail and the pass):
      A. same run_id + job_name, a LATER attempt succeeded  (the classic re-run)
      B. same head_sha + workflow + job_name, a later run succeeded
    """
    con.execute("UPDATE failure_event SET is_flake=0, flake_reason=NULL WHERE repo=?", (repo,))

    # A: later successful attempt of the same job in the same run
    con.execute(
        """UPDATE failure_event SET is_flake=1, flake_reason='rerun_attempt_passed'
           WHERE repo=?1 AND EXISTS (
             SELECT 1 FROM job_outcome jo
              WHERE jo.repo=?1 AND jo.run_id=failure_event.run_id
                AND jo.job_name=failure_event.job_name
                AND jo.conclusion='success'
                AND jo.run_attempt > failure_event.run_attempt)""",
        (repo,),
    )
    # B: later successful run on the identical head SHA
    con.execute(
        """UPDATE failure_event SET is_flake=1, flake_reason='same_sha_later_pass'
           WHERE repo=?1 AND is_flake=0 AND EXISTS (
             SELECT 1 FROM job_outcome jo
              WHERE jo.repo=?1 AND jo.head_sha=failure_event.head_sha
                AND jo.job_name=failure_event.job_name
                AND IFNULL(jo.workflow,'')=IFNULL(failure_event.workflow,'')
                AND jo.conclusion='success'
                AND jo.started_at > failure_event.started_at)""",
        (repo,),
    )
    con.commit()
    rows = con.execute(
        "SELECT IFNULL(flake_reason,'not_flake') r, COUNT(*) c FROM failure_event WHERE repo=? GROUP BY r",
        (repo,),
    ).fetchall()
    return {r["r"]: r["c"] for r in rows}


# ------------------------------------------------------------- recurrence walk
def walk(con, repo: str, *, key: str = "fingerprint", exclude_flakes: bool = False) -> dict:
    """Chronological walk. Returns totals and the recurrence rate."""
    sql = (
        f"SELECT {key} AS k, started_at FROM failure_event "
        "WHERE repo=? AND fingerprint != '' "
        + ("AND is_flake=0 " if exclude_flakes else "")
        + "ORDER BY started_at ASC, job_id ASC"
    )
    seen: set[str] = set()
    total = recurrences = 0
    for row in con.execute(sql, (repo,)):
        k = row["k"]
        if not k:
            continue
        total += 1
        if k in seen:
            recurrences += 1
        else:
            seen.add(k)
    return {
        "total_failures": total,
        "recurrences": recurrences,
        "distinct": len(seen),
        "rate": (recurrences / total) if total else 0.0,
    }


# -------------------------------------------------------------- tier 0 metrics
def tier0_stats(con, repo: str) -> dict:
    total = con.execute("SELECT COUNT(*) c FROM failure_event WHERE repo=?", (repo,)).fetchone()["c"]
    with_ev = con.execute(
        "SELECT COUNT(*) c FROM failure_event WHERE repo=? AND fingerprint != ''", (repo,)
    ).fetchone()["c"]
    by_kind = {
        r["evidence_kind"]: r["c"]
        for r in con.execute(
            "SELECT evidence_kind, COUNT(*) c FROM failure_event WHERE repo=? GROUP BY evidence_kind",
            (repo,),
        )
    }
    fps = [
        r["c"]
        for r in con.execute(
            "SELECT fingerprint, COUNT(*) c FROM failure_event "
            "WHERE repo=? AND fingerprint != '' GROUP BY fingerprint",
            (repo,),
        )
    ]
    distinct = len(fps)
    singletons = sum(1 for c in fps if c == 1)
    clustered_events = sum(c for c in fps if c > 1)
    return {
        "failure_events": total,
        "events_with_evidence": with_ev,
        "log_coverage": (with_ev / total) if total else 0.0,
        "evidence_kinds": by_kind,
        "distinct_fingerprints": distinct,
        # Fraction of events that Tier 0 placed in a group of 2+. This is the
        # "Tier 0 handled it" number: those events never need a worker token.
        "tier0_collapse": (clustered_events / with_ev) if with_ev else 0.0,
        "singleton_fingerprints": singletons,
        # What Tier 1 would actually have to chew through.
        "tier1_candidates": singletons,
    }


def top_fingerprints(con, repo: str, n: int = 50) -> list[dict]:
    rows = con.execute(
        """SELECT fingerprint, COUNT(*) c,
                  MIN(started_at) first_seen, MAX(started_at) last_seen,
                  MIN(norm_message) exemplar, MIN(evidence_kind) kind
             FROM failure_event WHERE repo=? AND fingerprint != ''
            GROUP BY fingerprint ORDER BY c DESC, first_seen ASC LIMIT ?""",
        (repo, n),
    ).fetchall()
    return [dict(r) for r in rows]


def report(repo: str, out_json: str | None = None) -> dict:
    con = db.connect()
    flakes = mark_flakes(con, repo)
    stats = tier0_stats(con, repo)
    result = {
        "repo": repo,
        "window_start": db.meta_get(con, f"window_start:{repo}"),
        "since_days": db.meta_get(con, f"since_days:{repo}", "90"),
        "runs_scanned": db.meta_get(con, f"runs_scanned:{repo}", "0"),
        "tier0": stats,
        "flake_breakdown": flakes,
        "recurrence": {
            "tier0_with_flakes": walk(con, repo, key="fingerprint", exclude_flakes=False),
            "tier0_without_flakes": walk(con, repo, key="fingerprint", exclude_flakes=True),
        },
        "top_fingerprints": top_fingerprints(con, repo, 50),
    }
    if out_json:
        with open(out_json, "w") as f:
            json.dump(result, f, indent=2)
    return result


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--json", default=None)
    p.add_argument("--top", type=int, default=50)
    a = p.parse_args()
    r = report(a.repo, a.json)
    t, rec = r["tier0"], r["recurrence"]
    print(f"repo                  {r['repo']}   window {r['since_days']}d from {r['window_start']}")
    print(f"runs scanned          {r['runs_scanned']}")
    print(f"failure events        {t['failure_events']}")
    print(f"log coverage          {t['log_coverage']:.1%}  ({t['evidence_kinds']})")
    print(f"distinct fingerprints {t['distinct_fingerprints']}")
    print(f"TIER 0 COLLAPSE       {t['tier0_collapse']:.1%}")
    print(f"tier 1 candidates     {t['tier1_candidates']} singletons")
    print(f"flakes                {r['flake_breakdown']}")
    print(f"RECURRENCE with flakes    {rec['tier0_with_flakes']['rate']:.1%} "
          f"({rec['tier0_with_flakes']['recurrences']}/{rec['tier0_with_flakes']['total_failures']})")
    print(f"RECURRENCE without flakes {rec['tier0_without_flakes']['rate']:.1%} "
          f"({rec['tier0_without_flakes']['recurrences']}/{rec['tier0_without_flakes']['total_failures']})")
    print()
    print(f"--- top {a.top} Tier 0 fingerprints ---")
    for i, fp in enumerate(r["top_fingerprints"][: a.top], 1):
        print(f"{i:3}. {fp['fingerprint']}  n={fp['c']:<5} {fp['kind']:<10} {fp['exemplar'][:110]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
