# MetaCortex: Strategic Plan

**Date:** 2026-06-11

---

## Scope Philosophy

MetaCortex is a **user memory** system — it stores what the user *knows*, not what the user *has access to*. Email, calendars, documents, and external data sources are for the agent to dig through on demand and advise the user on. MetaCortex persists the durable knowledge that results from those interactions: preferences, decisions made, context learned, facts established, things deprecated.

This means MetaCortex will never include connectors (GDrive, Gmail, Notion), ingestion pipelines, browser extensions, or document indexing. That's a different product (and it's what supermemory, Mem0, and others are building). MetaCortex's scope is: **durable memories that persist across agent sessions, with explicit lifecycle control.**

---

## Executive Summary

MetaCortex is a well-architected MCP memory server. The core — vector search, idempotent writes, client profile scoping, and multimodal pipeline — is solid. The tool surface has been simplified from 6 tools to 4.

The first hardening release addressed Firestore collection scaling, payload optimization, and model validation. The remaining strategic work is focused on proposed advanced features (context tiering, temporal validity).

---

## Outstanding Tasks & Redesigns

### 1. Unbounded Firestore Collections (TTL Policies)
* **Status:** Implemented 2026-06-11
* **Problem:** Two collections grow without bound:
  * `memory_vectors_write_fingerprints` (deduplication fingerprints)
  * `memory_events` (observability/audit trail)
* **Resolution:**
  * New fingerprint writes store numeric `dedupe_expires_at` for the 15-minute duplicate window and Date-valued `expires_at` for 30-day Firestore TTL.
  * New `memory_events` writes preserve numeric `timestamp` and add Date-valued `expires_at` for 90-day Firestore TTL.
  * Added dry-run/write TTL backfill and `gcloud` TTL deployment scripts.

### 2. Search Result Redundancy
* **Status:** Implemented 2026-06-11
* **Problem:** Each search result includes both `summary` (220 chars) and `content_preview` (400 chars) — two truncations of the same content. Wastes tokens and confuses clients.
* **Resolution:** `search_context` now returns `summary` only. If the agent wants full content, it calls `fetch_context`.

### 3. Model Default Validation
* **Status:** Implemented 2026-06-11
* **Problem:** Verify the `gemini-3.1-flash-lite-preview` multimodal model default still exists and is the right choice.
* **Resolution:** Google shut down `gemini-3.1-flash-lite-preview` on 2026-05-25. The default is now stable `gemini-3.1-flash-lite`, with a live validation script.

---

## Proposed New Capabilities (Invest)

### 1. Context Tiering (L0/L1/L2 equivalent)
* **Status:** Proposed
* **Goal:** Reduce token costs by returning a summary first, fetching full details only when needed.
* **Proposal:** When storing a memory, use Gemini to generate:
  * A `summary` field (~100 tokens) stored alongside the full content.
  * The existing `content` (full fidelity) remains for fetch.
  * Search results return the summary. Agents call `fetch_context` only when they need the full thing.
* **Effort:** Medium.

### 2. Temporal Validity / Fact Versioning
* **Status:** Implemented 2026-07-11
* **Goal:** Enable the agent to distinguish old facts from current ones beyond `branch_state`.
* **Proposal:** Add optional `valid_from` and `valid_until` fields to stored memories. Search results can filter by temporal validity. Update deprecation to set `valid_until` automatically.

  *Added 2026-06 following a design review:*
  Extend `deprecate_context` with temporal bounds. This splits supersession into two semantically distinct reasons:
  * **Change** — the world changed (e.g., a job switch). The prior fact was TRUE OF ITS ERA. Set `valid_until` on the prior record; it remains true-of-period and should still surface in valid-time slices for that window. May be initiated by agent or user.
  * **Correction** — the prior record was NEVER TRUE (e.g., a mistyped date). Mark the prior record retracted on the belief axis — NOT a valid-time close — so it is excluded from valid-time truth while remaining in the audit trail. The corrective record carries the valid interval the prior should have had.

  *Implementation:* Introduce a `supersession_reason` field (`"changed"` | `"corrected"`) on the supersession path; `valid_until` handling differs by reason. State projection rule is LATEST BELIEF WINS, since a correction can itself later be corrected. Cross-reference INVEST #4.
* **Effort:** Low-medium.

### 3. Provenance (Memory + Action Lineage)
* **Status:** Proposed (*Added 2026-06 following a design review*)
* **Goal:** Audit memory origin and protect chronology against agent drift (unintended rewrite/reinterpretation of historical priorities).
* **Proposal:** Add a `provenance` object to `MemoryMetadata`:
  * `origin` (`"user_asserted"` | `"agent_inferred"` | `"legacy_import"`)
  * `source_session` (optional string)
  * `derived_from` (optional array of memory document IDs that an inference drew upon)
  * `confidence` (optional number)
  
  The agent self-reports `origin` on every write. Add an `origin` filter to `search_context`. For action provenance (which principal initiated a lifecycle mutation and the operation's semantics), extend the existing `memory_events` collection rather than introducing new infrastructure, turning it into an authorization-aware audit log. Backfill existing legacy memories with `origin: "legacy_import"`.
* **Effort:** Medium.

### 4. Correction as a User-Initiated Action
* **Status:** Implemented 2026-07-11
* **Goal:** Prevent "agent drift" during error corrections by ensuring only the user can initiate corrections (retracting assertions that were never true).
* **Proposal:** Enforce the user-only constraint structurally by exposing corrections as an MCP Prompt (user-controlled), NOT an MCP Tool (model-controlled). This prevents the agent from invoking corrections autonomously.
  
  A correction is implemented as a thin composition over existing tools: a `remember_context` call (for the corrected memory) + a `deprecate_context` call (for the old superseded memory) carrying `supersession_reason: "corrected"` and `initiator: "user"`. The agent can identify and surface correction candidates in a review queue, but it can never commit them without user action.
* **Effort:** Low (no new storage primitive; a prompt plus `supersession_reason`/`initiator` fields, reusing deprecate+remember).

---

## Competitive Positioning Summary

| Capability | Mem0 | Letta | Graphiti | OpenViking | Supermemory | MetaCortex |
|---|---|---|---|---|---|---|
| Vector search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multimodal memory | ❌ | ❌ | ❌ | ✅ (different) | ✅ (OCR/video) | ✅ (Gemini) |
| MCP native | ❌ | ❌ | ❌ | ❌ | ✅ (thin) | ✅ (full) |
| Client/tenant scoping | Basic | ❌ | ❌ | ❌ | Basic (Spaces) | ✅ (profiles) |
| Context tiering | ❌ | ❌ | ❌ | ✅ (L0/L1/L2) | ❌ | 🔜 (proposed) |
| Temporal validity | ❌ | ❌ | ✅ (bi-temporal) | ❌ | ❌ | ✅ (bi-temporal-lite) |
| Graph relationships | ✅ (hybrid) | ❌ | ✅ (core) | ❌ | ❌ | ❌ |
| Auto memory evolution | ✅ | ✅ (self-edit) | ✅ | ✅ | ✅ | ❌ |
| Serverless-native | ❌ | ❌ | ❌ | ❌ | ✅ (CF Workers) | ✅ (Firebase) |
| Connectors/ingestion | ❌ | ❌ | ❌ | ❌ | ✅ (GDrive etc.) | ❌ (by design) |
| Idempotent writes | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (fingerprint) |
| Explicit lifecycle | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (4-state) |
| Benchmark-validated | ❌ | ❌ | ❌ | ❌ | ✅ (LongMemEval) | ❌ |

**MetaCortex's defensible niche:** MCP-native, multimodal, serverless *user memory* server with client-scoped access control and explicit lifecycle management. Intentionally does NOT do connectors or data ingestion — that's the agent's job, not the memory system's.

The closest competitor in philosophy is supermemory (also serverless, also MCP-capable), but supermemory is memory-as-a-product (automated, consumer-friendly, implicit lifecycle) while MetaCortex is memory-as-infrastructure (explicit lifecycle control, deterministic behavior for agentic systems). Supermemory also has a reported fundamental reliability bug (issue #792: writes succeed but recall returns empty).

---

## Bugs to Fix (from codebase audit)

These should be addressed regardless of strategic direction:

1. **Fixed:** `runtime.test.ts` used `MCP_AUTH_TOKEN` while code read `MCP_ADMIN_TOKEN`.
2. **Fixed:** `CLAUDE.md` used `MCP_AUTH_TOKEN` in the env var table.
3. **Fixed:** `CLAUDE.md` referred to `openBrainMcp` instead of `metaCortexMcp`.
4. **Partially fixed:** stale `CLAUDE.md` descriptions were refreshed where touched by the contract cleanup.
5. **Fixed:** `WWW-Authenticate` realm no longer uses the old placeholder service name.
6. **Fixed:** default `serviceName` no longer uses the old placeholder service name.
7. **Fixed:** replaced the shut-down `gemini-3.1-flash-lite-preview` multimodal model default with stable `gemini-3.1-flash-lite` and added live model validation.

---

## Current Tool Surface

| Tool | Purpose | Annotations |
|---|---|---|
| `remember_context` | Write memories (defaults: topic="general", branch_state="active") | idempotent |
| `search_context` | Semantic search with filters | read-only |
| `fetch_context` | Get full content by ID | read-only |
| `deprecate_context` | Soft-delete with supersession tracking | destructive |
| `consolidate_context` | LLM-merge related memories into one canonical record and deprecate the sources | destructive / admin |

---

## Completed Work (Archived)

* **SSE Transport Removal:** Streamable HTTP is now the only supported transport; stateful SSE endpoints removed. (Completed: 2026-03-22)
* **Response Normalization:** All remaining MCP tools normalized to return JSON payloads instead of flat key=value text. (Completed: 2026-03-22)
* **`store_context` Elimination:** Removed from MCP surface; `remember_context` is the unified write tool. (Completed: 2026-03-22)
* **`get_consolidation_queue` Removal:** Removed from MCP surface; WIP queue is now an internal workflow. (Completed: 2026-03-22)
* **`retrieval_text` Exposure Fix:** Removed `retrieval_text` from public `fetch_context` response to prevent leaking implementation details. (Completed: 2026-03-22)
* **Roadmap Hardening Release:** Added Firestore TTL-ready fields and scripts, removed `content_preview` from search payloads, added `document_id` fetch compatibility, updated Gemini multimodal defaults, deployed production TTL policies, and verified production smoke tests. (Completed: 2026-06-11)
* **Codebase Bugs Fixed:**
  * Fixed environment variable naming mismatch (`MCP_ADMIN_TOKEN` vs `MCP_AUTH_TOKEN`).
  * Updated references in `CLAUDE.md` from `openBrainMcp` to `metaCortexMcp`.
  * Standardized `WWW-Authenticate` realm and default `serviceName` to use the correct service name.
