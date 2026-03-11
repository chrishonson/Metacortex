# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Firebase Open Brain is a serverless MCP (Model Context Protocol) memory layer backed by Firestore vector search, deployed as a Firebase Cloud Functions 2nd Gen HTTP function. It exposes two MCP tools (`store_context` and `search_context`) for storing and retrieving vector-embedded memories, with optional multimodal support (text + images normalized via Gemini).

## Common Commands

All commands run from the repo root:

```bash
npm --prefix functions install          # Install dependencies
npm --prefix functions test             # Run all tests with coverage (vitest)
npm --prefix functions run test:watch   # Watch mode
npm --prefix functions run build        # TypeScript compile → lib/
npm --prefix functions run serve        # Start Firebase emulators (functions + firestore)
```

Run a single test file:
```bash
npx --prefix functions vitest run test/config.test.ts
```

Deploy:
```bash
firebase deploy --only firestore:indexes    # Deploy vector indexes first
firebase deploy --only functions            # Deploy the function
```

Smoke test (against local emulator or production):
```bash
cd functions
MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/mcp" \
MCP_AUTH_TOKEN="replace-me" \
npm run smoke
```

## Architecture

### Request Flow

```
HTTP → Express app (app.ts) → Bearer auth middleware → MCP server (mcpServer.ts)
                                                      → /healthz (public, no auth)
```

The Express app handles three MCP transport modes:
- `/mcp` — Streamable HTTP (primary)
- `/mcp/sse` + `/mcp/messages` — Legacy SSE

### Key Source Files (all under `functions/src/`)

- **index.ts** — Firebase Functions entry point, exports `openBrainMcp`
- **app.ts** — Express app with CORS, auth middleware, MCP session management
- **config.ts** — Environment variable loading with validation (`loadConfig`)
- **runtime.ts** — Dependency injection: lazily creates and caches all collaborators (`createRuntime`)
- **service.ts** — `OpenBrainService` with `store()` and `search()` business logic
- **embeddings.ts** — Gemini API clients: `GeminiEmbeddingClient` + `GeminiMultimodalPreparer`
- **memoryRepository.ts** — Firestore CRUD with vector similarity search
- **types.ts** — Shared types and enums (`ArtifactType`, `BranchState`, `MemoryModality`)
- **mcpServer.ts** — MCP tool registration with Zod input schemas

### Data Flow

**store_context**: Input text (+ optional image) → Gemini multimodal normalization (if image) → Gemini embedding (768-dim) → Firestore document with vector

**search_context**: Query text → Gemini embedding → Firestore vector similarity search (cosine distance, top-K) with metadata filters (`branch_state` required, `module_name` optional)

### Testing Approach

Four test layers, all using vitest with in-memory fakes (no real Gemini/Firestore calls):
- **config.test.ts** — Config validation
- **service.test.ts** — Business logic with `InMemoryMemoryRepository` + `KeywordEmbeddingClient`
- **app.test.ts** — HTTP auth/routing via supertest
- **mcp.integration.test.ts** — End-to-end MCP protocol via real MCP SDK client transports

Test fakes live in `functions/test/support/fakes.ts` — includes `KeywordEmbeddingClient` (keyword-based vectors), `FakeMemoryContentPreparer`, `InMemoryMemoryRepository`, and factory helpers `createTestConfig`/`createTestRuntime`.

## Critical Constraints

- **Embedding dimensions must match everywhere**: `GEMINI_EMBEDDING_DIMENSIONS` env var (default 768) must equal the dimension in `firestore.indexes.json`
- **Firestore must be Native mode**, not Datastore mode
- **Firebase Blaze plan required** for Cloud Functions deployment
- **Provider migration**: If switching embedding providers or dimensions, either clear the collection or use a new `MEMORY_COLLECTION` name — never mix vectors from different models/dimensions

## Environment Variables

Required: `GEMINI_API_KEY`, `MCP_AUTH_TOKEN`

Optional (with defaults): `GEMINI_EMBEDDING_MODEL` (gemini-embedding-001), `GEMINI_MULTIMODAL_MODEL` (gemini-2.5-flash), `GEMINI_EMBEDDING_DIMENSIONS` (768), `MEMORY_COLLECTION` (memory_vectors), `SEARCH_RESULT_LIMIT` (5), `DEFAULT_FILTER_STATE` (active), `SERVICE_NAME`, `SERVICE_VERSION`

Template: `functions/.env.example` → copy to `functions/.env`
