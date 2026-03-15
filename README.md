# Firebase Open Brain

Firebase Open Brain is a serverless MCP memory service backed by Firestore vector search and deployed through Firebase Cloud Functions 2nd Gen.

The practical target is a remote MCP server that chat clients such as ChatGPT web or Claude web can use for:

- searching what the project already knows
- saving new durable memories from chat
- fetching the full stored memory behind a search result

## Important constraint

As of March 10, 2026, Cloud Functions production deployment requires the Firebase Blaze plan. The original Spark-only production target from the initial spec is not compatible with current Firebase Functions deployment rules, though low-traffic usage can still remain close to zero cost within Blaze no-cost quotas.

## Primary use cases

This project is set up for these workflows:

1. A chat client asks, "What do we already know about auth/session handling?"
   The model calls `search_context`.
2. The search results include document ids and external artifact refs when available.
   The model can call `fetch_context` for the one result it wants in full.
3. A user says, "Remember that we use Ktor for shared Android and iOS networking."
   The model calls `remember_context`.
4. A user shares a screenshot and says to save it for later retrieval.
   The model calls `remember_context` with image input plus `artifact_refs` if the real asset lives in storage.

## Tool strategy

There are two tool layers in this repo.

### Browser-friendly tools

These are the tools you should expose to read/write chat clients first:

- `remember_context`
  High-level write tool for normal chat use. The client supplies the memory text, optional topic, optional `draft=true`, optional image input, and optional `artifact_refs`. The server fills in backend metadata defaults.
- `search_context`
  Vector search over stored memories. Results include document ids and artifact refs when available.
- `fetch_context`
  Fetch one memory by document id after `search_context`.

### Admin and maintenance tools

These are still useful, but they are not the first tools to expose to browser-hosted chat clients:

- `store_context`
  Low-level write tool that requires explicit backend metadata such as `artifact_type` and `branch_state`.
- `deprecate_context`
  Soft-delete obsolete memories.
- `get_consolidation_queue`
  Read all draft (`wip`) memories that still need consolidation into canonical context.

## Why `remember_context` exists

`store_context` is too backend-shaped for normal web chat use.

If you ask a model to choose `artifact_type`, `branch_state`, and `module_name` correctly on every write, it will be inconsistent. `remember_context` is the practical front door:

- `topic` maps to the stored `module_name`
- `draft=false` stores canonical memory as `active`
- `draft=true` stores draft material as `wip`
- `memory_type` is optional and uses plain language
- if `memory_type` is omitted, the server applies a best-effort classification

## Metadata model

These fields still exist in stored records because they help maintenance and filtering.

### `artifact_type`

Backend category for the memory:

- `DECISION`
  Chosen approaches or settled project direction
- `REQUIREMENT`
  Rules, constraints, or must/should statements
- `PATTERN`
  Reusable workflows, screenshots, playbooks, or implementation patterns
- `SPEC`
  Canonical schema, interface, contract, or spec details

For browser clients, prefer `remember_context` and let the server infer this unless the type is obvious.

### `branch_state`

Lifecycle state for a stored memory:

- `active`
  Canonical memory that normal search should return
- `wip`
  Draft memory awaiting consolidation
- `merged`
  Incorporated memory that is no longer the main active record
- `deprecated`
  Obsolete memory kept only for history/audit

For browser clients, do not expose `branch_state` directly. Use `remember_context` and set `draft=true` only when the user is explicitly saving rough notes.

### `module_name`

Stored topic or subsystem label.

Examples:

- `auth`
- `billing`
- `kmp-networking`
- `ui-settings`

In `remember_context` this is exposed as `topic`. If omitted, the server defaults it to `general`.

## Images

This project supports image-backed memories, but it does not store raw image bytes for later download.

What happens today:

- the image is normalized into retrieval text by Gemini
- that text is embedded and stored
- optional `artifact_refs` can point to the real asset, for example `gs://bucket/path.png`
- search results and fetched records return those artifact refs when they exist

That means the practical image flow is:

1. save a screenshot with `remember_context`
2. store the real asset elsewhere
3. include its `artifact_refs`
4. let semantic search find the memory
5. let the client follow the returned artifact ref to the actual screenshot

## Endpoints

- Default Streamable HTTP MCP endpoint: `/openBrainMcp/mcp`
- Default legacy SSE MCP endpoint: `/openBrainMcp/mcp/sse`
- Default legacy SSE message endpoint: `/openBrainMcp/mcp/messages`
- Client-scoped Streamable HTTP MCP endpoint: `/openBrainMcp/clients/<clientId>/mcp`
- Client-scoped legacy SSE endpoint: `/openBrainMcp/clients/<clientId>/mcp/sse`
- Client-scoped legacy SSE message endpoint: `/openBrainMcp/clients/<clientId>/mcp/messages`

Security model:

- the default `/mcp` endpoint is the admin endpoint
- `clients/<clientId>` endpoints let you expose smaller toolsets to specific consumers
- browser CORS is deny-by-default unless a client profile explicitly allowlists origins

Recommended browser read/write toolset:

- `remember_context`
- `search_context`
- `fetch_context`

## Quick start

1. Install dependencies:

   ```bash
   npm --prefix functions install
   ```

2. Create local env vars:

   ```bash
   cp functions/.env.example functions/.env
   ```

3. Run verification:

   ```bash
   npm --prefix functions test
   npm --prefix functions run build
   ```

4. Start emulators:

   ```bash
   npm --prefix functions run serve
   ```

5. Optional MCP smoke test:

   ```bash
   cd functions
   MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/mcp" \
   MCP_AUTH_TOKEN="replace-me" \
   npm run smoke
   ```

## Deployment

Deployment playbook: [docs/DEPLOYMENT.md](/Users/nick/git/FirebaseOpenBrain/docs/DEPLOYMENT.md)

For the next production deployment session, start with:

```bash
cd /Users/nick/git/FirebaseOpenBrain
./scripts/deploy-session-preflight.sh
```
