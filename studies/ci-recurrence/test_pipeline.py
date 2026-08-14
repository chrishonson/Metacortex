"""Known-answer tests for the parts that have no model in them.

These verify MY code (the normalizer's discriminations, the flake SQL, the
chronological walk). They are not, and must not be read as, a result of the
study: the fixtures are hand-built, so any "rate" in here is a property of the
fixture. The study's numbers come only from analyze.py over fetched data.

  uv run test_pipeline.py
"""

from __future__ import annotations

import pathlib
import sys
import tempfile

import db
from analyze import mark_flakes, tier0_stats, walk
from normalize import fingerprint, normalize

FAILS: list[str] = []


def check(name: str, got, want) -> None:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")
    if not ok:
        FAILS.append(name)


# ------------------------------------------------------------------ normalizer
def test_normalizer() -> None:
    print("normalizer")
    same = [
        "/home/runner/work/pytorch/pytorch/test/test_nn.py:1234:5: AssertionError: not close! diff: 0.001 at index (3, 7)",
        "/home/runner/work/pytorch/pytorch/test/test_nn.py:998:11: AssertionError: not close! diff: 0.09 at index (11, 2)",
        "/opt/actions-runner/_work/pytorch/pytorch/test/test_nn.py:7:1: AssertionError: not close! diff: 1.5 at index (0, 0)",
    ]
    fps = {fingerprint(s) for s in same}
    check("same bug across paths/lines/values collapses to 1", len(fps), 1)

    check("different test file stays distinct",
          fingerprint(same[0]) == fingerprint(same[0].replace("test_nn", "test_optim")), False)
    check("exit 1 != exit 137",
          fingerprint("Process completed with exit code 1") == fingerprint("Process completed with exit code 137"),
          False)
    check("GHA timestamp+marker stripped",
          fingerprint("2026-07-02T11:22:33.4455667Z ##[error]Process completed with exit code 137"),
          fingerprint("Process completed with exit code 137"))
    check("uuid/sha/duration normalized",
          normalize("job 8f14e45f-ceea-467a-9f2a-1c0b6b0d1111 failed at deadbe1 after 4m 12s"),
          "job <UUID> failed at <SHA> after <DUR>")
    check("empty input -> empty fingerprint", fingerprint(""), "")
    check("normalize is idempotent on its own output",
          normalize(normalize(same[0])), normalize(same[0]))


# ------------------------------------------------------------------- fixtures
def seed(con, rows: list[tuple], outcomes: list[tuple] = ()) -> None:
    """rows: (event_id, started_at, fingerprint, run_id, attempt, job_name, sha)"""
    for eid, ts, fp, run_id, att, job, sha in rows:
        con.execute(
            """INSERT OR REPLACE INTO failure_event
               (event_id,repo,run_id,run_attempt,job_id,workflow,job_name,head_sha,
                started_at,evidence_kind,raw_message,norm_message,fingerprint,fetched_at)
               VALUES(?,'r/r',?,?,?,'wf',?,?,?,'annotation','raw',?,?,'t')""",
            (eid, run_id, att, abs(hash(eid)) % 10**9, job, sha, ts, f"norm-{fp}", fp),
        )
    for run_id, att, job, sha, concl, ts in outcomes:
        con.execute(
            """INSERT OR REPLACE INTO job_outcome
               (repo,run_id,job_id,run_attempt,workflow,job_name,head_sha,conclusion,started_at)
               VALUES('r/r',?,?,?,'wf',?,?,?,?)""",
            (run_id, abs(hash((run_id, att, job, concl))) % 10**9, att, job, sha, concl, ts),
        )
    con.commit()


def test_walk() -> None:
    print("recurrence walk")
    with tempfile.TemporaryDirectory() as d:
        con = db.connect(pathlib.Path(d) / "t.db")
        # chronological fingerprints: A B A C A B -> 3 distinct, 3 recurrences
        seq = ["A", "B", "A", "C", "A", "B"]
        seed(con, [(f"e{i}", f"2026-01-0{i+1}T00:00:00Z", fp, 100 + i, 1, "job", f"sha{i}")
                   for i, fp in enumerate(seq)])
        r = walk(con, "r/r")
        check("total", r["total_failures"], 6)
        check("distinct", r["distinct"], 3)
        check("recurrences", r["recurrences"], 3)
        check("rate", round(r["rate"], 4), 0.5)

        # an event with no evidence must be excluded, not counted as a failure
        seed(con, [("e9", "2026-01-09T00:00:00Z", "", 200, 1, "job", "sha9")])
        check("no-evidence event excluded from walk", walk(con, "r/r")["total_failures"], 6)
        s = tier0_stats(con, "r/r")
        check("coverage counts it in the denominator", s["failure_events"], 7)
        check("log coverage", round(s["log_coverage"], 4), round(6 / 7, 4))
        con.close()


def test_flakes() -> None:
    print("flake split")
    with tempfile.TemporaryDirectory() as d:
        con = db.connect(pathlib.Path(d) / "t.db")
        seed(
            con,
            [
                # A: run 100 attempt 1 failed, attempt 2 passed -> flake
                ("f1", "2026-02-01T00:00:00Z", "A", 100, 1, "build", "sha1"),
                # B: run 101 failed and never passed -> real failure
                ("f2", "2026-02-02T00:00:00Z", "B", 101, 1, "build", "sha2"),
                # C: same sha as a later successful run -> flake
                ("f3", "2026-02-03T00:00:00Z", "C", 102, 1, "test", "sha3"),
            ],
            outcomes=[
                (100, 2, "build", "sha1", "success", "2026-02-01T01:00:00Z"),
                (101, 1, "build", "sha2", "failure", "2026-02-02T00:00:00Z"),
                (103, 1, "test", "sha3", "success", "2026-02-03T05:00:00Z"),
            ],
        )
        got = mark_flakes(con, "r/r")
        check("rerun-passed marked flake", got.get("rerun_attempt_passed"), 1)
        check("same-sha-later-pass marked flake", got.get("same_sha_later_pass"), 1)
        check("genuine failure not marked", got.get("not_flake"), 1)
        check("walk with flakes", walk(con, "r/r")["total_failures"], 3)
        check("walk without flakes", walk(con, "r/r", exclude_flakes=True)["total_failures"], 1)
        con.close()


if __name__ == "__main__":
    test_normalizer()
    test_walk()
    test_flakes()
    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
        sys.exit(1)
    print("all passed")
