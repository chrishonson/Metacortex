# MetaCortex: Strategic Plan

**Date:** 2026-06-11

---

## Scope Philosophy

MetaCortex is a **user memory** system — it stores what the user *knows*, not what the user *has access to*. Email, calendars, documents, and external data sources are for the agent to dig through on demand and advise the user on. MetaCortex persists the durable knowledge that results from those interactions: preferences, decisions made, context learned, facts established, things deprecated.

This means MetaCortex will never include connectors (GDrive, Gmail, Notion), ingestion pipelines, browser extensions, or document indexing. That's a different product (and it's what supermemory, Mem0, and others are building). MetaCortex's scope is: **durable memories that persist across agent sessions, with explicit lifecycle control.**

---

## Executive Summary

MetaCortex is a well-architected MCP memory server. The core — vector search, idempotent writes, client profile scoping, and multimodal pipeline — is solid. The tool surface has been simplified from 6 tools to 4. 

The remaining work focuses on Firestore collection scaling, payload optimization, model validation, and proposed advanced features (context tiering, temporal validity).

---

## Outstanding Tasks & Redesigns

### 1. Unbounded Firestore Collections (TTL Policies)
* **Status:** Not started
* **Problem:** Two collections grow without bound:
  * `memory_vectors_write_fingerprints` (deduplication fingerprints)
  * `memory_events` (observability/audit trail)
* **Recommendation:** 
  * Enable Firestore TTL policies on both collections. Fingerprints can expire after 30 days. Events can expire after 90 days.
  * In the codebase, ensure timestamps or expiration fields (e.g. `expires_at` in fingerprints, `timestamp` or a new `ttl` field in events) are stored as Firestore Timestamps or compatible fields so Firestore TTL policies can target them. Note that currently `expires_at` is stored as a number (epoch milliseconds), which Firestore TTL policies do not support natively (they require a Timestamp type). We should update the code to write `Timestamp` or a Firestore-compatible date format.

### 2. Search Result Redundancy
* **Status:** Not started
* **Problem:** Each search result includes both `summary` (220 chars) and `content_preview` (400 chars) — two truncations of the same content. Wastes tokens and confuses clients.
* **Recommendation:** Keep only `content_preview` (or rename to `preview`). If the agent wants the full content, it calls `fetch_context`.

### 3. Model Default Validation
* **Status:** Pending
* **Problem:** Verify the `gemini-3.1-flash-lite-preview` multimodal model default still exists and is the right choice.
* **Recommendation:** Test and confirm model availability.

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
* **Status:** Proposed
* **Goal:** Enable the agent to distinguish old facts from current ones beyond `branch_state`.
* **Proposal:** Add optional `valid_from` and `valid_until` fields to stored memories. Search results can filter by temporal validity. Update deprecation to set `valid_until` automatically.
* **Effort:** Low-medium.

---

## Competitive Positioning Summary

| Capability | Mem0 | Letta | Graphiti | OpenViking | Supermemory | MetaCortex |
|---|---|---|---|---|---|---|
| Vector search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multimodal memory | ❌ | ❌ | ❌ | ✅ (different) | ✅ (OCR/video) | ✅ (Gemini) |
| MCP native | ❌ | ❌ | ❌ | ❌ | ✅ (thin) | ✅ (full) |
| Client/tenant scoping | Basic | ❌ | ❌ | ❌ | Basic (Spaces) | ✅ (profiles) |
| Context tiering | ❌ | ❌ | ❌ | ✅ (L0/L1/L2) | ❌ | 🔜 (proposed) |
| Temporal validity | ❌ | ❌ | ✅ (bi-temporal) | ❌ | ❌ | 🔜 (proposed) |
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
7. **Pending:** verify the `gemini-3.1-flash-lite-preview` multimodal model default still exists and is the right choice.

---

## Current Tool Surface

| Tool | Purpose | Annotations |
|---|---|---|
| `remember_context` | Write memories (defaults: topic="general", branch_state="active") | idempotent |
| `search_context` | Semantic search with filters | read-only |
| `fetch_context` | Get full content by ID | read-only |
| `deprecate_context` | Soft-delete with supersession tracking | destructive |

---

## Completed Work (Archived)

* **SSE Transport Removal:** Streamable HTTP is now the only supported transport; stateful SSE endpoints removed. (Completed: 2026-03-22)
* **Response Normalization:** All remaining MCP tools normalized to return JSON payloads instead of flat key=value text. (Completed: 2026-03-22)
* **`store_context` Elimination:** Removed from MCP surface; `remember_context` is the unified write tool. (Completed: 2026-03-22)
* **`get_consolidation_queue` Removal:** Removed from MCP surface; WIP queue is now an internal workflow. (Completed: 2026-03-22)
* **`retrieval_text` Exposure Fix:** Removed `retrieval_text` from public `fetch_context` response to prevent leaking implementation details. (Completed: 2026-03-22)
* **Codebase Bugs Fixed:**
  * Fixed environment variable naming mismatch (`MCP_ADMIN_TOKEN` vs `MCP_AUTH_TOKEN`).
  * Updated references in `CLAUDE.md` from `openBrainMcp` to `metaCortexMcp`.
  * Standardized `WWW-Authenticate` realm and default `serviceName` to use the correct service name.
