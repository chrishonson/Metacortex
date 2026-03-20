# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Firebase Open Brain is a serverless MCP (Model Context Protocol) memory layer backed by Firestore vector search, deployed as a Firebase Cloud Functions 2nd Gen HTTP function. It exposes browser-friendly and admin MCP tools for remembering, searching, fetching, deprecating, and consolidating vector-embedded memories, with optional multimodal support (text + images normalized via Gemini).

## Common Commands

All commands run from the repo root:

```bash
npm --prefix functions install          # Install dependencies
npm --prefix functions test             # Run all tests with coverage (vitest)
npm --prefix functions run test:watch   # Watch mode
npm --prefix functions run build        # TypeScript compile → lib/
npm --prefix functions run clean        # Remove lib/ and coverage/
npm --prefix functions run serve        # Start Firebase emulators (functions + firestore)
```

Run a single test file:
```bash
npx --prefix functions vitest run test/config.test.ts
```

Deploy:
```bash
./scripts/deploy-session-preflight.sh       # Pre-deploy checks (git, env, dims, tests, build)
firebase deploy --only firestore:indexes    # Deploy vector indexes first
firebase deploy --only functions            # Deploy the function
```

Smoke test (against local emulator or production):
```bash
cd functions
MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/mcp" \
MCP_ADMIN_TOKEN="replace-me" \
npm run smoke
```

The smoke test supports `--mode read-write` (default, stores then searches) and `--mode search-only` (read-only client validation). It also accepts `--image-base64` and `--image-mime-type` for multimodal testing.

## Architecture

### Request Flow

```
HTTP → Express app (app.ts) → CORS check → Bearer auth → MCP server (mcpServer.ts)
                                                         → /healthz (public, no auth)
```

### MCP Transport Modes

Three transports, all available at both the default and per-client mount points:
- `/mcp` (POST) — Streamable HTTP (primary, single request-reply)
- `/mcp/sse` (GET) + `/mcp/messages` (POST) — Legacy SSE with session management

### Client Profile Scoping

Each client gets scoped access via bearer token + allowlists:
- **Default client**: `/mcp` endpoint, configured via `MCP_ADMIN_TOKEN` + `MCP_ALLOWED_TOOLS` + `MCP_ALLOWED_ORIGINS` + `MCP_ALLOWED_FILTER_STATES`; `MCP_ALLOWED_ORIGINS` applies only to this admin endpoint
- **Custom clients**: `/clients/<clientId>/mcp` endpoints, configured via `MCP_CLIENT_PROFILES_JSON` (array of `{id, token, allowedOrigins[], allowedTools[], allowedFilterStates[]}`)

Auth uses timing-safe token comparison. Origin allowlisting supports `"*"` wildcard; default is deny-all.

### MCP Tools

| Tool | Purpose |
|------|---------|
| `remember_context` | High-level write tool for chat clients: save durable memory with optional topic, draft flag, image input, and artifact refs |
| `store_context` | Store text (+ optional image) → Gemini multimodal normalization → embedding → Firestore |
| `search_context` | Query → embedding → Firestore vector similarity search (cosine, top-K) with metadata filters |
| `fetch_context` | Retrieve one stored memory by document ID after search |
| `deprecate_context` | Soft-delete: mark document as deprecated, record superseding document ID |
| `get_consolidation_queue` | Fetch WIP-state memories for synthesis into official specs |

### Key Source Files (all under `functions/src/`)

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | ~17 | Firebase Functions entry point, exports `openBrainMcp` (us-central1, 300s timeout, 512MiB) |
| `app.ts` | ~344 | Express app: CORS, bearer auth, SSE session management, router for default + client-scoped endpoints |
| `config.ts` | ~287 | `loadConfig()` with env validation, `ClientProfile` parsing from JSON, `MissingConfigurationError` |
| `errors.ts` | ~9 | `HttpError` exception with `statusCode` field |
| `runtime.ts` | ~83 | Dependency injection: `createRuntime()` lazily creates and caches Gemini clients, Firestore repo, service |
| `service.ts` | ~161 | `OpenBrainService` — remember/store/search/fetch/deprecate/consolidation flows |
| `observability.ts` | ~150 | Structured tool-event and request-event logging plus Firestore-backed `memory_events` audit trail |
| `embeddings.ts` | ~191 | `GeminiEmbeddingClient` + `GeminiMultimodalPreparer` (image→text normalization for retrieval) |
| `memoryRepository.ts` | ~137 | Firestore CRUD: `store()`, `search()` (findNearest + cosine), `deprecate()`, `getConsolidationQueue()` |
| `types.ts` | ~111 | Enums (`ARTIFACT_TYPES`, `BRANCH_STATES`, `MEMORY_MODALITIES`, `MCP_TOOL_NAMES`) and interfaces |
| `mcpServer.ts` | ~245 | MCP tool registration with Zod schemas, filtered by client's `allowedTools` and `allowedFilterStates` |

### Data Flow

**remember_context**: Chat-friendly input → server defaults/inference for metadata → `store_context` pipeline

**store_context**: Input text (+ optional image) → Gemini multimodal normalization (if image) → canonical `content` + internal `retrieval_text` → Gemini embedding (deployment currently pinned to 768-dim) → Firestore document with vector + metadata

**search_context**: Query text → Gemini embedding → Firestore `findNearest()` (cosine distance, top-K) with required `branch_state` and optional `module_name` filters

**fetch_context**: Document ID → direct Firestore read of one stored memory

**deprecate_context**: Document ID + superseding ID → update `branch_state` to "deprecated", set `superseded_by`

**get_consolidation_queue**: Query documents where `branch_state == "wip"`, optionally filtered by `module_name`

### Testing Approach

Four test layers, all using vitest with in-memory fakes (no real Gemini/Firestore calls):

| Test | Scope |
|------|-------|
| `config.test.ts` | Config validation, env parsing, client profile JSON |
| `service.test.ts` | Business logic with `InMemoryMemoryRepository` + `KeywordEmbeddingClient` |
| `app.test.ts` | HTTP auth, CORS, bearer tokens, client profile routing (supertest) |
| `mcp.integration.test.ts` | End-to-end MCP protocol via real MCP SDK client transports (StreamableHTTP + SSE) |

Test fakes in `functions/test/support/fakes.ts`:
- `KeywordEmbeddingClient` — 6-dimensional vectors keyed on keywords (ktor, compose, android, ios, firebase, architecture), enables deterministic cosine similarity
- `FakeMemoryContentPreparer` — Mimics multimodal prep without Gemini
- `InMemoryMemoryRepository` — In-memory storage with cosine distance search
- `createTestConfig()` / `createTestRuntime()` — Factory helpers for test fixtures

## Critical Constraints

- **Embedding dimensions must match everywhere**: `GEMINI_EMBEDDING_DIMENSIONS` env var (default 768) must equal the dimension in all Firestore vector indexes in `firestore.indexes.json`
- **Firestore must be Native mode**, not Datastore mode
- **Firebase Blaze plan required** for Cloud Functions deployment
- **Embedding migration**: If switching embedding providers, embedding models, or dimensions, either clear the collection or use a new `MEMORY_COLLECTION` name — never mix vectors from different vector spaces
- **Firestore rules deny all client access** to `memory_vectors` — access is server-only via the Cloud Function
- **Config and runtime are cached** in `runtime.ts` — they initialize once per cold start, not per request

## Environment Variables

**Required:**
- `GEMINI_API_KEY` — Gemini API key for embeddings and multimodal
- `MCP_AUTH_TOKEN` — Bearer token for default client auth

**Optional (with defaults):**

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_EMBEDDING_MODEL` | `text-embedding-004` | Embedding model name |
| `GEMINI_MULTIMODAL_MODEL` | `gemini-3.1-flash-lite-preview` | Multimodal normalization model |
| `GEMINI_EMBEDDING_DIMENSIONS` | `768` | Embedding vector dimensions |
| `MEMORY_COLLECTION` | `memory_vectors` | Firestore collection name |
| `SEARCH_RESULT_LIMIT` | `5` | Max search results returned |
| `DEFAULT_FILTER_STATE` | `active` | Default branch_state filter for search |
| `MCP_ALLOWED_TOOLS` | all six tools | Comma-separated tool allowlist for default client |
| `MCP_ALLOWED_ORIGINS` | _(empty = deny all)_ | Comma-separated CORS origin allowlist for the default admin `/mcp` endpoint only |
| `MCP_ALLOWED_FILTER_STATES` | all four states | Comma-separated branch_state allowlist |
| `MCP_CLIENT_PROFILES_JSON` | _(empty)_ | JSON array of custom client profiles; browser origins belong in each profile's `allowedOrigins[]` |
| `MAX_SSE_SESSIONS` | `25` | Max concurrent SSE sessions |
| `SERVICE_NAME` | `firebase-open-brain` | Service identifier in responses |
| `SERVICE_VERSION` | `0.1.0` | Service version in responses |

Template: `functions/.env.example` → copy to `functions/.env`

## Deployment Workflow

1. Run preflight: `./scripts/deploy-session-preflight.sh` (checks git status, env vars, dimension alignment, tests, build)
2. Deploy indexes: `firebase deploy --only firestore:indexes`
3. Deploy function: `firebase deploy --only functions`
4. Smoke test: `npm --prefix functions run smoke` with production URL and token

See `docs/DEPLOYMENT.md` for the deployment playbook.

## Firebase Configuration

- **Project**: `my-brain-88870` (alias: prod) in `.firebaserc`
- **Emulators**: Functions on port 5001, Firestore on port 8080 (UI enabled)
- **Firestore indexes**: Three composite indexes on `memory_vectors` — `metadata.module_name` + `embedding`, `metadata.branch_state` + `embedding`, and `metadata.branch_state` + `metadata.module_name` + `embedding` (all 768-dim FLAT)
- **Observability collection**: `memory_events` stores one audit record per tool call and one per ingress rejection/degraded request, including `client_id`, `event_type`, `status`, `latency_ms`, and compact request/response or reason metadata
- **Predeploy hook**: `npm --prefix "$RESOURCE_DIR" run build`

## TypeScript Configuration

- Target: ES2022, Module: NodeNext
- Strict mode, no unused locals/parameters
- Output: `functions/lib/`, source: `functions/src/`
