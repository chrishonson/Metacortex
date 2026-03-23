# MetaCortex: Strategic Plan — Cut, Keep, Rethink

**Date:** 2026-03-22
**Context:** Codebase audit + competitive landscape analysis (Mem0, Letta, Zep/Graphiti, OpenViking, Cognee, Supermemory)

---

## Scope Philosophy

MetaCortex is a **user memory** system — it stores what the user *knows*, not what the user *has access to*. Email, calendars, documents, and external data sources are for the agent to dig through on demand and advise the user on. MetaCortex persists the durable knowledge that results from those interactions: decisions made, context learned, facts established, things deprecated.

This means MetaCortex will never include connectors (GDrive, Gmail, Notion), ingestion pipelines, browser extensions, or document indexing. That's a different product (and it's what supermemory, Mem0, and others are building). MetaCortex's scope is: **durable memories that persist across agent sessions, with explicit lifecycle control.**

---

## Executive Summary

MetaCortex is a well-architected MCP memory server in rapid early development. The core — vector search, idempotent writes, client profile scoping, multimodal pipeline — is solid. But the 6-tool surface has redundancy, some features won't scale on Firestore, and the competitive landscape reveals both gaps to close and differentiators to double down on.

Progress since this plan was drafted:

- SSE transport has been removed. Streamable HTTP is now the only supported transport.
- Response formats have been normalized to JSON across the remaining MCP tools.
- `store_context` has been removed from the MCP surface. `remember_context` is now the single write tool and supports optional explicit `branch_state` for advanced admin workflows.

Remaining near-term work:

- remove or admin-gate `get_consolidation_queue`
- add TTL policies for unbounded Firestore collections
- simplify fetch/search payloads before investing in tiering and temporal validity

---

## KEEP — What's Working

### 1. Core write/search/fetch loop
The `store → search → fetch` pipeline is clean, tested, and correct. Fingerprint-based idempotency prevents duplicates. Asymmetric embedding (RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY task types) is a smart use of Vertex AI. The integration tests using real MCP SDK transports are unusually thorough.

### 2. Client profile scoping
Per-client `allowedTools`, `allowedFilterStates`, and CORS origins is a genuinely useful multi-tenant model. None of the competitors do this well — Mem0 has basic user/agent separation, but nothing as granular as MetaCortex's profile system. This is a differentiator for enterprise-ish deployments.

### 3. Gemini multimodal pipeline
**This is your clearest competitive advantage.** Mem0, Letta, Graphiti, and Cognee are all text-only. OpenViking supports multimodal but through a different approach (binary storage with text summaries). MetaCortex's Gemini-powered image normalization into searchable text is a real capability gap in the market. Keep and improve.

### 4. MCP protocol compliance
Being a first-class MCP server is the right distribution strategy. Mem0 and Letta have their own SDKs and APIs. MetaCortex plugs into any MCP client (Claude, ChatGPT via custom GPT, etc.) without custom integration. This is a moat via ecosystem alignment.

### 5. Observability / audit trail
`memory_events` collection with tool call timing and request metadata is solid operational infrastructure. Needs TTL policies (see Rethink section) but the concept is right.

---

## CUT — Features to Eliminate

### 1. `store_context` — remove from MCP surface

**Status:** Completed on 2026-03-22.

**Why cut:** Two write tools with overlapping behavior create contract drift, duplicate testing, and needless client complexity. The public-facing schema should use terms clients understand (`topic`, `draft`, `remember`) while still allowing explicit lifecycle control for admin use cases.

- `remember_context` is the clearer public verb
- `topic` is easier for clients than `module_name`
- one write tool eliminates divergent schemas and examples
- advanced lifecycle control still matters, so the surviving write tool must support explicit `branch_state`

**What changed:** `store_context` was removed from the MCP tool surface. `remember_context` now handles both simple writes and advanced writes via optional `branch_state`. This reduced the tool surface from 6 to 5.

### 2. `get_consolidation_queue` — remove entirely

**Status:** Not started.

**Why cut:** This tool exposes an internal workflow concept ("consolidation") that doesn't match how any current agent memory system actually works in practice. The intended workflow is: agent stores rough notes as `wip` → later reviews the queue → consolidates into canonical `active` memories → deprecates the originals.

Problems:
- No agent today will spontaneously run a consolidation workflow. This requires complex multi-step reasoning about its own memory hygiene.
- The tool has no result limit — a large WIP backlog returns everything in one call
- The response format is pipe-delimited flat text (inconsistent with everything else)
- Neither Mem0, Letta, Zep, nor OpenViking expose a "consolidation queue" concept. They all handle memory evolution automatically or not at all.
- The `wip` branch state itself is fine to keep (useful for draft/scratch memories), but the explicit queue tool for reviewing them is over-engineering a workflow that won't happen organically

**What to do:** Remove the tool. Keep `wip` as a valid `branch_state`. If consolidation matters later, build it as an automated server-side process (like Mem0's automatic memory evolution), not a client-facing tool. **This reduces the tool surface from 5 to 4.**

---

## RETHINK — Features That Need Redesign

### 1. SSE transport on Cloud Functions

**Status:** Completed on 2026-03-22.

**Problem:** SSE sessions are stored in a module-level `Map`. Cloud Functions runs multiple instances. An SSE connection on instance A won't be found when a subsequent POST lands on instance B. This is a fundamental mismatch between stateful SSE and stateless serverless.

**Competitors' approach:** Most competitor servers either run on persistent processes (not serverless) or use only stateless transports.

**What changed:** SSE transport and its message endpoints were removed. Streamable HTTP is now the only supported transport.

### 2. Unbounded Firestore collections

**Status:** Not started.

Two collections grow without bound:
- `memory_vectors_write_fingerprints` — deduplication fingerprints with `expires_at` set but nothing deleting them
- `memory_events` — observability/audit trail with no TTL

**Recommendation:**
- Enable Firestore TTL policies on both collections. Fingerprints can expire after 30 days (if you're going to store a duplicate, it'll happen within hours, not months). Events can expire after 90 days.
- Add a `limit` parameter to `getConsolidationQueue` (if you keep it) or any future list operations.

### 3. Response format inconsistency

**Status:** Completed on 2026-03-22.

`store_context` and `deprecate_context` return flat key=value text. Everything else returns JSON. This is a tax on every client.

**What changed:** All remaining MCP tools now return JSON payloads.

### 4. `retrieval_text` exposure in fetch responses

**Status:** Not started.

For text memories, `retrieval_text` duplicates `content`. For multimodal memories, it's a Gemini-generated artifact the client can't meaningfully use. Exposing it leaks implementation detail.

**Recommendation:** Remove `retrieval_text` from `fetch_context` responses. If debugging is needed, add a `debug: true` query parameter or a separate admin tool.

### 5. Search result redundancy

**Status:** Not started.

Each search result includes both `summary` (220 chars) and `content_preview` (400 chars) — two truncations of the same content. Wastes tokens and confuses clients about which to use.

**Recommendation:** Keep only `content_preview` (or rename to `preview`). If the agent wants the full content, it calls `fetch_context`. Two levels of truncation serve no purpose.

---

## INVEST — New Capabilities Worth Building

### 1. Context tiering (inspired by OpenViking's L0/L1/L2)

**Why:** OpenViking's most compelling idea is that not all context needs to be loaded at full fidelity. Their L0/L1/L2 system (100-token abstract → 2k-token overview → full content) claims 95% token cost reduction.

MetaCortex already has a primitive version of this: `search_context` returns truncated previews, and `fetch_context` returns full content. But it's not designed as a tiered system — it's an accident of truncation.

**Proposal:** When storing a memory, use Gemini to generate:
- A `summary` field (~100 tokens) stored alongside the full content
- The existing `content` (full fidelity) remains for fetch

Search results return the summary. Agents call `fetch_context` only when they need the full thing. This is achievable with one additional Gemini call at write time and gives you OpenViking's core token-efficiency benefit without their filesystem complexity.

**Effort:** Medium. One new field in the Firestore schema, one Gemini call in the write path, update search response format.

### 2. Temporal validity / fact versioning (inspired by Graphiti)

**Why:** Graphiti's bi-temporal tracking (when a fact was recorded vs. when it was true) is the most sophisticated approach in the market. MetaCortex has `created_at` and `updated_at` timestamps but no concept of "this fact was true from X to Y."

Without this, an agent searching for "what's our auth strategy?" might get both the old strategy and the new one, with no way to know which is current beyond `branch_state`.

**Proposal:** Add optional `valid_from` and `valid_until` fields to stored memories. Search results can filter by temporal validity. The `deprecate_context` tool already captures "superseded by" — extending this with temporal bounds is a natural fit.

**Effort:** Low-medium. Two optional fields, one new filter in search, update deprecation to set `valid_until` automatically.

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
5. **Fixed:** `WWW-Authenticate` realm no longer says `"firebase-open-brain"`.
6. **Fixed:** default `serviceName` no longer says `"firebase-open-brain"`.
7. **Pending:** verify the `gemini-3.1-flash-lite-preview` multimodal model default still exists and is the right choice.

---

## Current Tool Surface

| Tool | Purpose | Annotations |
|---|---|---|
| `remember_context` | Write memories (defaults: topic="general", branch_state="active") | idempotent |
| `search_context` | Semantic search with filters | read-only |
| `fetch_context` | Get full content by ID | read-only |
| `deprecate_context` | Soft-delete with supersession tracking | destructive |
| `get_consolidation_queue` | Read WIP backlog | likely next cut |

The current surface is down from 6 tools to 5. The next likely reduction is removing `get_consolidation_queue`, which would leave a 4-tool surface.
