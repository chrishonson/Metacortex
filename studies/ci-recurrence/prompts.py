"""The Tier 1 / Tier 2 worker prompt. One question, one JSON answer.

Bump PROMPT_VERSION on ANY edit. It is part of the worker cache key, so a
revision correctly invalidates prior labels instead of silently mixing two
prompt regimes into one dataset.

DELIBERATE BIAS -- worth arguing with before you accept it:

  The worker is told to answer "no" when torn. Merging two clusters is the
  destructive direction: every bad merge converts a first-seen failure into a
  recurrence and pushes the headline rate UP. Since the decision rule kills the
  premise below ~30%, a prompt that merges eagerly would manufacture exactly
  the result we are trying to test honestly.

  So the reported rate is a LOWER BOUND. If the conservative number clears 30%,
  the premise survives on the least favourable reading, which is the only
  reading worth acting on.
"""

from __future__ import annotations

PROMPT_VERSION = "t1-v1-2026-08-14"

SYSTEM = (
    "You classify continuous-integration failure messages. "
    "You answer only with one line of JSON. No prose, no markdown, no code fences."
)

_TEMPLATE = """Two CI failure messages from the same repository. Variable data \
(numbers, file paths, memory addresses, durations, machine names) has already been \
replaced with placeholders like <N>, <F>, <PATH>, <SHA>, <DUR>.

Decide: do these describe THE SAME UNDERLYING PROBLEM -- one bug or one broken \
condition that a single fix would resolve?

Answer SAME only when both hold:
  1. the same kind of error (same exception, same failing assertion, same tool error)
  2. the same failing thing (same test, same file, same build target, same service)

Answer DIFFERENT when any of these hold:
  - different error type, even in the same file
  - different test, file, module, or build target, even with the same error type
  - one is infrastructure (network, disk full, OOM, timeout, runner lost) and the
    other is a code or test failure
  - you cannot tell

If you are torn, answer DIFFERENT. A wrong SAME corrupts the study; a wrong
DIFFERENT only leaves two clusters that should have been one.

A:
{a}

B:
{b}

Reply with exactly this JSON and nothing else:
{{"same": true or false, "confidence": 0.0 to 1.0}}"""


def build(a: str, b: str, max_chars: int = 700) -> str:
    """Render the worker prompt for normalized messages a and b."""
    return _TEMPLATE.format(a=a[:max_chars].strip(), b=b[:max_chars].strip())


# Few-shot block. Small local models drift toward "same" without it; append it
# only for the local tier, where it measurably helps, and skip it for Flash,
# where it is wasted input tokens.
FEWSHOT = """Examples:

A: <PATH>/test_nn.py:<N>:<N>: AssertionError: Tensor-likes are not close!
B: <PATH>/test_nn.py:<N>:<N>: AssertionError: Tensor-likes are not close!
{"same": true, "confidence": 0.95}

A: <PATH>/test_nn.py:<N>:<N>: AssertionError: Tensor-likes are not close!
B: <PATH>/test_optim.py:<N>:<N>: AssertionError: Tensor-likes are not close!
{"same": false, "confidence": 0.85}

A: Process completed with exit code 137
B: curl: (<N>) failed to connect to <URL> after <DUR>
{"same": false, "confidence": 0.9}

"""


def build_local(a: str, b: str) -> str:
    return FEWSHOT + build(a, b)
