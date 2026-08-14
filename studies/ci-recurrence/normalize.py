"""Tier 0: deterministic normalization + fingerprinting of CI failure text.

No model. Free, reproducible, and hashable -- which an LLM label is not.
Every failure event gets a Tier 0 fingerprint; tiers 1/2 only ever look at
what Tier 0 leaves as a singleton.

Rules apply in the order listed. Order matters: specific patterns (UUIDs, hex,
paths) must fire before the catch-all number rule, or the number rule eats
their internals and destroys the distinction.

Two judgment calls worth arguing about, both flagged and both measurable:

  KEEP_EXIT_CODES -- `exit code 137` (OOM-kill) and `exit code 143` (SIGTERM
    / timeout) are different failures from `exit code 1` (tests failed). The
    brief says strip bare ints; stripping these would merge an infra failure
    into a test failure and inflate the recurrence rate. Kept by default,
    switchable so we can report the collapse rate both ways.

  KEEP_BASENAME -- `/home/runner/work/pytorch/pytorch/test/test_nn.py` and
    `.../test_optim.py` are different failures. The directory prefix is pure
    noise (it encodes the runner, not the problem); the basename is signal.
    So paths collapse to `<PATH>/test_nn.py`, not `<PATH>`.
"""

from __future__ import annotations

import hashlib
import re

TIER0_VERSION = "t0-2026-08-14"

KEEP_EXIT_CODES = True
KEEP_BASENAME = True
MAX_LEN = 512

# Sentinel that shields exit-code digits from the catch-all int rule. Letters
# only: the int rule's lookbehind refuses to match a digit preceded by a word
# character, so EXITCODE137 survives intact and is unwrapped at the end.
_SENTINEL = "EXITCODE"

_R: list[tuple[str, re.Pattern[str], str]] = []


def _rule(name: str, pattern: str, repl: str, flags: int = 0) -> None:
    _R.append((name, re.compile(pattern, flags), repl))


# --- 1. transport noise: escapes, log decoration, GH Actions framing ----------
_rule("ansi", r"\x1b\[[0-9;?]*[a-zA-Z]", "")
_rule("cr", r"\r", "")
# GH Actions prefixes every raw-log line with an RFC3339 nano timestamp.
_rule("gha_ts", r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*", "", re.M)
_rule("gha_grp", r"##\[(?:group|endgroup|debug|command|section)\][^\n]*", "")
_rule("gha_err", r"##\[(?:error|warning)\]", "")

# --- 2. identifiers that are unique per run ----------------------------------
_rule("url", r"https?://[^\s'\"<>)\]]+", "<URL>")
_rule("uuid", r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b", "<UUID>")
_rule("hexlit", r"\b0[xX][0-9a-fA-F]+\b", "<HEX>")
# Bare hex blobs (git shas, content hashes): >=7 chars, must mix digit+letter
# so ordinary lowercase words don't get swallowed.
_rule("sha", r"\b(?=[0-9a-f]{7,64}\b)(?=[a-f]*[0-9])(?=[0-9]*[a-f])[0-9a-f]{7,64}\b", "<SHA>")
_rule("ipv4", r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "<IP>")
_rule("email", r"\b[\w.+-]+@[\w-]+\.[\w.]+\b", "<EMAIL>")

# --- 3. runner / container / temp identity -----------------------------------
_rule("pytest_tmp", r"pytest-of-\w+/pytest-\d+(?:/[\w.-]+)?", "<TMP>")
_rule("tmpdir", r"/tmp/[^\s:'\"]*", "<TMP>")
_rule("runner", r"\b(?:i-[0-9a-f]{8,}|ip-\d+-\d+-\d+-\d+|runner-[\w-]+|gh-ci-[\w-]+)\b", "<RUNNER>")
# No port rule on purpose. A `:\d{4,5}` rule fires on 4-digit LINE NUMBERS
# (`test_nn.py:1234:5`) before the linecol rule can see them, which shatters
# collapse across every large file in the repo. Ports fall through to the int
# rule and become `:<N>`, which is equally stable -- `<PORT>` only ever bought
# readability, never a distinct fingerprint.

# --- 4. time, duration, size --------------------------------------------------
_rule("iso", r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?", "<TS>")
_rule("date", r"\b\d{4}-\d{2}-\d{2}\b", "<DATE>")
_rule("clock", r"\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b", "<TIME>")
_rule("dur_hms", r"\b\d+m\s*\d+(?:\.\d+)?s\b", "<DUR>")
_rule("dur", r"\b\d+(?:\.\d+)?\s?(?:ns|us|ms|sec|secs|seconds|mins|minutes|hours|s|h)\b", "<DUR>")
_rule("size", r"\b\d+(?:\.\d+)?\s?(?:[KMGT]i?B|bytes)\b", "<SIZE>", re.I)

# --- 5. source locations ------------------------------------------------------
# Absolute paths only. The leading (?<![\w.]) is load-bearing: without it this
# matches the `/src/Foo.kt` tail inside a repo-relative `app/src/Foo.kt` and
# mangles it to `app<PATH>/Foo.kt`. Repo-relative paths (what Check Run
# annotations actually carry) are identical on every runner, so they are signal
# and must survive intact; only the absolute /home/runner/... prefix is noise.
_PATH = r"(?<![\w.])(?:/[\w.+-]+){2,}"
_rule("path", _PATH, "<PATH>")  # KEEP_BASENAME swaps in _shorten_paths at apply time
_rule("winpath", r"[A-Za-z]:\\(?:[\w.+-]+\\)+[\w.+-]+", "<PATH>")
_rule("linecol", r":(\d+):(\d+)\b", ":<N>:<N>")
_rule("lineno", r"(?<=[\w>)])[: ]line \d+", " line <N>", re.I)

# --- 6. numbers (last) --------------------------------------------------------
_rule("float", r"(?<![\w<])[-+]?\d+\.\d+(?:[eE][-+]?\d+)?(?![\w>])", "<F>")
_rule("int", r"(?<![\w<>/-])\d+(?![\w>])", "<N>")

# --- 7. whitespace ------------------------------------------------------------
_rule("ws", r"[ \t]+", " ")
_rule("nl", r"\s*\n\s*", " | ")

_EXIT = re.compile(
    r"\b(exit(?:ed)?(?: with)?(?: code| status)?|signal|returncode|return code)\s*[:=]?\s*(\d{1,3})\b",
    re.I,
)
_EXIT_TOK = re.compile(_SENTINEL + r"(\d{1,3})")
_PATH_RE = re.compile(_PATH)


def _shorten_paths(text: str) -> str:
    """Collapse the directory prefix, keep the final component."""

    def sub(m: re.Match[str]) -> str:
        base = m.group(0).rsplit("/", 1)[-1]
        return f"<PATH>/{base}" if base else "<PATH>"

    return _PATH_RE.sub(sub, text)


def _apply(name: str, pat: re.Pattern[str], repl: str, s: str) -> str:
    if name == "path" and KEEP_BASENAME:
        return _shorten_paths(s)
    return pat.sub(repl, s)


def normalize(text: str | None) -> str:
    """Apply Tier 0 rules. Returns a stable, hashable string."""
    if not text:
        return ""
    s = text
    if KEEP_EXIT_CODES:
        s = _EXIT.sub(lambda m: f"{m.group(1)} {_SENTINEL}{m.group(2)}", s)
    for name, pat, repl in _R:
        s = _apply(name, pat, repl, s)
    if KEEP_EXIT_CODES:
        s = _EXIT_TOK.sub(lambda m: m.group(1), s)
    s = s.strip()
    if len(s) > MAX_LEN:
        s = s[:MAX_LEN] + "..."
    return s


def fingerprint(text: str | None) -> str:
    """sha1 of the normalized text, truncated. Stable across runs and machines."""
    n = normalize(text)
    return hashlib.sha1(n.encode("utf-8")).hexdigest()[:16] if n else ""


def explain(text: str) -> list[tuple[str, str]]:
    """Debug aid: show the string after each rule that changed it."""
    out: list[tuple[str, str]] = [("input", text)]
    s = text
    if KEEP_EXIT_CODES:
        s = _EXIT.sub(lambda m: f"{m.group(1)} {_SENTINEL}{m.group(2)}", s)
    for name, pat, repl in _R:
        before = s
        s = _apply(name, pat, repl, s)
        if s != before:
            out.append((name, s))
    if KEEP_EXIT_CODES:
        s2 = _EXIT_TOK.sub(lambda m: m.group(1), s)
        if s2 != s:
            out.append(("unexit", s2))
    return out
