"""The whole harness: one dispatch function, a content-hash cache, retry, tokens.

Deliberately dumb. No framework, no provider abstraction beyond the two
providers actually in use, no config file. If this file starts growing a
plugin system, delete the plugin system.

  ask(con, tier, fp_a, text_a, fp_b, text_b) -> (same, confidence)

Cache first, always. The cache key is a content hash over
(prompt_version, tier, model, text_a, text_b), so re-runs after a crash cost
nothing and a prompt revision correctly invalidates the old labels.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.request

import db
import prompts

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/generate")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:30b")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")

# USD per 1M tokens. VERIFY against current pricing before quoting a total --
# these are the numbers the cost estimate multiplies, and stale rates make the
# dollar figure confidently wrong. Local inference is metered at zero: the M1
# is already paid for, and electricity is not what this study is measuring.
PRICING = {
    "local": (0.0, 0.0),
    GEMINI_MODEL: (0.30, 2.50),
}


def cache_key(tier: int, model: str, a: str, b: str) -> str:
    h = hashlib.sha256()
    for part in (prompts.PROMPT_VERSION, str(tier), model, a, b):
        h.update(part.encode("utf-8"))
        h.update(b"\x1f")
    return h.hexdigest()[:32]


def _parse(text: str) -> tuple[bool | None, float]:
    """Pull the JSON verdict out of a worker reply. Models add fences and prose."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.strip("`")
        t = t.split("\n", 1)[1] if "\n" in t else t
    i, j = t.find("{"), t.rfind("}")
    if i == -1 or j == -1:
        return None, 0.0
    try:
        d = json.loads(t[i : j + 1])
    except json.JSONDecodeError:
        return None, 0.0
    same = d.get("same")
    if isinstance(same, str):
        same = same.strip().lower() in ("true", "yes", "same")
    if not isinstance(same, bool):
        return None, 0.0
    try:
        conf = float(d.get("confidence", 0.0))
    except (TypeError, ValueError):
        conf = 0.0
    return same, max(0.0, min(1.0, conf))


def _post(url: str, payload: dict, headers: dict, timeout: int) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", **headers}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _call_ollama(prompt: str) -> tuple[str, int, int]:
    body = _post(
        OLLAMA_URL,
        {
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "system": prompts.SYSTEM,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0, "num_predict": 64},
        },
        {},
        timeout=180,  # Ollama stalls; the retry loop above handles the rest.
    )
    return body.get("response", ""), body.get("prompt_eval_count", 0), body.get("eval_count", 0)


def _call_gemini(prompt: str) -> tuple[str, int, int]:
    if not GEMINI_KEY:
        raise RuntimeError("GEMINI_API_KEY not set")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    body = _post(
        f"{url}?key={GEMINI_KEY}",
        {
            "systemInstruction": {"parts": [{"text": prompts.SYSTEM}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0, "maxOutputTokens": 64, "responseMimeType": "application/json"},
        },
        {},
        timeout=120,
    )
    cand = (body.get("candidates") or [{}])[0]
    text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []))
    u = body.get("usageMetadata", {})
    return text, u.get("promptTokenCount", 0), u.get("candidatesTokenCount", 0)


def ask(con, tier: int, fp_a: str, text_a: str, fp_b: str, text_b: str, repo: str = "") -> tuple[bool | None, float]:
    """Cache-first worker call. tier 1 = local via Ollama, tier 2 = Gemini Flash."""
    model = "local" if tier == 1 else GEMINI_MODEL
    key = cache_key(tier, model, text_a, text_b)

    row = con.execute("SELECT same, confidence FROM worker_call WHERE cache_key=?", (key,)).fetchone()
    if row is not None:
        return (None if row["same"] is None else bool(row["same"])), (row["confidence"] or 0.0)

    prompt = prompts.build_local(text_a, text_b) if tier == 1 else prompts.build(text_a, text_b)
    caller = _call_ollama if tier == 1 else _call_gemini

    same, conf, ptok, otok, err = None, 0.0, 0, 0, None
    t0 = time.time()
    delay = 2.0
    for attempt in range(4):
        try:
            raw, ptok, otok = caller(prompt)
            same, conf = _parse(raw)
            if same is None:
                err = f"unparseable: {raw[:120]}"
            else:
                err = None
            break
        except urllib.error.HTTPError as e:
            err = f"http {e.code}"
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(delay)
                delay *= 2
                continue
            break
        except Exception as e:  # timeouts, connection resets, Ollama stalls
            err = f"{type(e).__name__}: {e}"
            time.sleep(delay)
            delay *= 2

    con.execute(
        """INSERT OR REPLACE INTO worker_call
           (cache_key,repo,tier,model,prompt_version,fp_a,fp_b,same,confidence,rationale,
            prompt_tokens,output_tokens,latency_ms,error,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (key, repo, tier, model, prompts.PROMPT_VERSION, fp_a, fp_b,
         None if same is None else int(same), conf, None,
         ptok, otok, int((time.time() - t0) * 1000), err, db.now()),
    )
    return same, conf


def spend(con) -> dict:
    """Running token + dollar totals, by tier. Printed after every batch."""
    out: dict[str, dict] = {}
    total = 0.0
    for r in con.execute(
        """SELECT tier, model, SUM(prompt_tokens) p, SUM(output_tokens) o,
                  COUNT(*) n, SUM(error IS NOT NULL) errs
             FROM worker_call GROUP BY tier, model"""
    ):
        pin, pout = PRICING.get(r["model"], (0.0, 0.0))
        usd = (r["p"] or 0) / 1e6 * pin + (r["o"] or 0) / 1e6 * pout
        total += usd
        out[f"tier{r['tier']}:{r['model']}"] = {
            "calls": r["n"], "errors": r["errs"],
            "prompt_tokens": r["p"] or 0, "output_tokens": r["o"] or 0,
            "usd": round(usd, 4),
        }
    out["total_usd"] = round(total, 4)
    return out
