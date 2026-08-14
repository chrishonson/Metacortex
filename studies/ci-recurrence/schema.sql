-- CI failure recurrence study. SQLite is the queue, the cache, and the checkpoint.
-- One file, no migrations. Blow it away and re-run; the HTTP disk cache makes that cheap.

PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------- failure events
-- The unit of analysis is a FAILED JOB, not a failed run. A run that fails in
-- 8 jobs is 8 failure events: they have independent causes and independent fixes.
CREATE TABLE IF NOT EXISTS failure_event (
  event_id      TEXT PRIMARY KEY,   -- {repo}:{run_id}:{job_id}  (job_id unique per attempt)
  repo          TEXT NOT NULL,
  run_id        INTEGER NOT NULL,
  run_attempt   INTEGER NOT NULL,
  job_id        INTEGER NOT NULL,
  workflow      TEXT,
  job_name      TEXT,
  head_sha      TEXT NOT NULL,
  head_branch   TEXT,
  trigger_event TEXT,               -- push / pull_request / schedule / ...
  started_at    TEXT NOT NULL,      -- ISO8601 Z. The chronological key for the walk.
  completed_at  TEXT,
  failed_step   TEXT,

  -- evidence: what text we actually fingerprint, and how good it is
  evidence_kind TEXT NOT NULL,      -- annotation | log_tail | step_name | none
  raw_message   TEXT,
  norm_message  TEXT,               -- Tier 0 output
  fingerprint   TEXT,               -- sha1(norm_message)[:16]

  -- flake classification (populated by flake.py, see FLAKE SPLIT)
  is_flake      INTEGER NOT NULL DEFAULT 0,
  flake_reason  TEXT,

  fetched_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fe_chrono  ON failure_event(repo, started_at);
CREATE INDEX IF NOT EXISTS ix_fe_fp      ON failure_event(repo, fingerprint);
CREATE INDEX IF NOT EXISTS ix_fe_sha     ON failure_event(repo, head_sha, job_name);

-- Outcome of EVERY job on the runs we pulled, successes included. Costs no
-- extra API calls (it is the same payload we already parse for failures) and
-- it is the only way to see a fail-then-pass on one head SHA -- i.e. a flake.
CREATE TABLE IF NOT EXISTS job_outcome (
  repo        TEXT NOT NULL,
  run_id      INTEGER NOT NULL,
  job_id      INTEGER PRIMARY KEY,
  run_attempt INTEGER NOT NULL,
  workflow    TEXT,
  job_name    TEXT,
  head_sha    TEXT NOT NULL,
  conclusion  TEXT,
  started_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_jo_key ON job_outcome(repo, head_sha, workflow, job_name);

-- ---------------------------------------------------------------- clustering
-- Tier 0 cluster == fingerprint identity. Tiers 1/2 only ever MERGE singletons
-- into an existing cluster; they never split. cluster_id starts as the
-- fingerprint itself and is rewritten to the canonical member on merge.
CREATE TABLE IF NOT EXISTS cluster_member (
  repo        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  cluster_id  TEXT NOT NULL,
  tier        INTEGER NOT NULL,     -- tier that assigned this membership
  PRIMARY KEY (repo, fingerprint)
);
CREATE INDEX IF NOT EXISTS ix_cm_cluster ON cluster_member(repo, cluster_id);

-- ---------------------------------------------------------------- worker cache
-- THE idempotency table. Every worker call is keyed by a content hash of
-- (prompt_version, tier, model, the two texts). Re-runs are free: we look here
-- first and never re-spend a token on a question already answered.
CREATE TABLE IF NOT EXISTS worker_call (
  cache_key      TEXT PRIMARY KEY,
  repo           TEXT,
  tier           INTEGER NOT NULL,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  fp_a           TEXT NOT NULL,     -- the singleton under test
  fp_b           TEXT NOT NULL,     -- the candidate cluster's exemplar
  same           INTEGER,           -- 1 = same underlying problem, 0 = not
  confidence     REAL,              -- 0.0..1.0 self-reported
  rationale      TEXT,
  prompt_tokens  INTEGER DEFAULT 0,
  output_tokens  INTEGER DEFAULT 0,
  latency_ms     INTEGER,
  error          TEXT,              -- non-null if the call failed after retries
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_wc_tier ON worker_call(tier, created_at);

-- ---------------------------------------------------------------- coordinator audit
-- 20 sampled labels per batch, graded by the coordinator. Agreement below 85%
-- stops the loop and forces a prompt revision.
CREATE TABLE IF NOT EXISTS audit (
  cache_key     TEXT NOT NULL,
  batch_id      INTEGER NOT NULL,
  worker_same   INTEGER,
  coordinator_same INTEGER,
  agreed        INTEGER,
  note          TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (cache_key, batch_id)
);

CREATE TABLE IF NOT EXISTS batch (
  batch_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  tier        INTEGER NOT NULL,
  n_items     INTEGER NOT NULL,
  n_cached    INTEGER NOT NULL DEFAULT 0,
  n_called    INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usd         REAL NOT NULL DEFAULT 0,
  agreement   REAL,                 -- audit agreement for this batch
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

-- ---------------------------------------------------------------- collection bookkeeping
-- log coverage: Actions logs and annotations age out (90d retention), so a run
-- inside the window may still yield no evidence. We must report what fraction
-- of failure events we actually got text for, or the recurrence rate is a lie.
CREATE TABLE IF NOT EXISTS fetch_log (
  repo        TEXT NOT NULL,
  kind        TEXT NOT NULL,        -- runs_page | jobs | annotations | log
  ref         TEXT NOT NULL,
  status      INTEGER,              -- HTTP status; 0 = served from disk cache
  ok          INTEGER NOT NULL,
  note        TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (repo, kind, ref)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
