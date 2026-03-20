# MetaCortex

MetaCortex is a serverless MCP memory service backed by Firestore vector search and deployed through Firebase Cloud Functions 2nd Gen.

![System Architecture](docs/graphics/architecture.png)

> [!TIP]
> **Brain & Body**: The Open Brain resides in the cloud as the intelligence core, while Nanobot acts as its local manifest (body). See the full [Architecture & Use Cases](docs/ARCHITECTURE.md) for details.

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
- `MCP_ALLOWED_ORIGINS` applies only to the default admin endpoint
- browser CORS should be configured per client profile through `MCP_CLIENT_PROFILES_JSON[].allowedOrigins`
- leave `MCP_ALLOWED_ORIGINS` empty unless you intentionally want browser access to the admin endpoint

Recommended browser read/write toolset:

- `remember_context`
- `search_context`
- `fetch_context`

## Browser Client Setup

For browser-hosted MCP clients, register the scoped endpoint, not the admin endpoint:

- ChatGPT web URL: `https://https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/chatgpt-web/mcp?auth_token=<YOUR_CHATGPT_TOKEN>`
- Claude web URL: `https://https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/claude-web/mcp`
- bearer token: the `token` value from the matching client profile
- allowed browser origins: the matching profile's `allowedOrigins`

Do not register `https://https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/mcp` with ChatGPT web or Claude web. That endpoint is the admin surface and uses `MCP_AUTH_TOKEN`.

Use separate client profiles per browser client:

- `chatgpt-web` with `allowedOrigins=["https://chatgpt.com"]`
- `claude-web` with `allowedOrigins=["https://claude.ai"]`

### Connecting to ChatGPT

ChatGPT's current MCP UI does not support configuring custom `Authorization: Bearer` headers. To work around this security limitation, MetaCortex supports passing the token securely via the URL.

1. Open ChatGPT Web or Desktop.
2. Open Settings -> Connected Apps (or MCP Settings).
3. Click "Add new App" or "Connect MCP Server".
4. Set **Auth Type** to **No Authentication**.
5. Set the **MCP URL** to your tokenized endpoint:
   `https://https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/chatgpt-web/mcp?auth_token=<YOUR_CHATGPT_TOKEN>`

MetaCortex will validate the token from the URL and reject unauthenticated requests even though ChatGPT is configured for "No Auth".

### Connecting to Claude

Depending on your Claude client (e.g., experimental web extensions, custom UIs, or future Claude Desktop SSE support), you can configure the connection in two ways:

**Option 1: Standard Headers (Preferred)**
- **MCP URL**: `https://https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/claude-web/mcp`
- **Auth Type**: Bearer Token / Service Token
- **Token**: `Bearer <YOUR_CLAUDE_TOKEN>`

**Option 2: Tokenized URL (If headers are unsupported)**
- **Auth Type**: No Authentication
- **MCP URL**: `https://https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/claude-web/mcp?auth_token=<YOUR_CLAUDE_TOKEN>`


## Tool Contract

The v1 client-facing tools return one `TextContent` block whose `text` is a single JSON object.

### `remember_context`

Minimal text memory:

```json
{
  "content": "We use Ktor for shared Android and iOS networking.",
  "topic": "kmp-networking"
}
```

Typical result:

```json
{
  "item": {
    "id": "abc123",
    "content": "We use Ktor for shared Android and iOS networking.",
    "metadata": {
      "module_name": "kmp-networking",
      "memory_type": "decision",
      "branch_state": "active",
      "modality": "text",
      "created_at": "2026-03-14T12:00:00.000Z",
      "updated_at": "2026-03-14T12:00:00.000Z"
    }
  },
  "write_status": "created"
}
```

Supported `memory_type` values are:

```json
["decision", "requirement", "pattern", "spec", "preference", "general"]
```

Image-backed memory with an external asset reference:

```json
{
  "content": "Settings screen screenshot for the Compose UI.",
  "topic": "ui-settings",
  "artifact_refs": ["gs://your-bucket/settings-screen.png"],
  "image_base64": "<base64 image bytes>",
  "image_mime_type": "image/png"
}
```

### `search_context`

Example input:

```json
{
  "query": "shared networking for android and ios",
  "filter_module": "kmp-networking",
  "filter_state": "active"
}
```

Typical result:

```json
{
  "matches": [
    {
      "id": "abc123",
      "summary": "We use Ktor for shared Android and iOS networking.",
      "score": 0.92,
      "content_preview": "We use Ktor for shared Android and iOS networking.",
      "metadata": {
        "module_name": "kmp-networking",
        "memory_type": "decision",
        "branch_state": "active",
        "modality": "text",
        "created_at": "2026-03-14T12:00:00.000Z",
        "updated_at": "2026-03-14T12:00:00.000Z"
      }
    }
  ],
  "applied_filters": {
    "filter_module": "kmp-networking",
    "filter_state": "active"
  }
}
```

If an item has external refs, they appear in `metadata.artifact_refs`.

If nothing matches, the result is:

```json
{
  "matches": [],
  "applied_filters": {
    "filter_module": null,
    "filter_state": "active"
  }
}
```

### `fetch_context`

Example input:

```json
{
  "document_id": "abc123"
}
```

Typical result:

```json
{
  "item": {
    "id": "abc123",
    "content": "We use Ktor for shared Android and iOS networking.",
    "retrieval_text": "We use Ktor for shared Android and iOS networking.",
    "metadata": {
      "module_name": "kmp-networking",
      "memory_type": "decision",
      "branch_state": "active",
      "modality": "text",
      "created_at": "2026-03-14T12:00:00.000Z",
      "updated_at": "2026-03-14T12:00:00.000Z"
    }
  }
}
```

## Search Behavior

`search_context` does one exact metadata filter step and one vector step:

- `filter_state` is always applied before nearest-neighbor search
- `filter_module`, when present, is an exact match on `module_name`
- vector search then runs Firestore `findNearest()` with cosine distance
- the result count is `limit` when provided, otherwise `SEARCH_RESULT_LIMIT`
- the default state is `active` unless the client profile allows and requests another state

`fetch_context` can still fail with `403` if the document exists but its `branch_state` is outside that client profile's `allowedFilterStates`.

## Write Constraints

Write behavior that matters in production:

- request bodies are limited to `1mb`, including base64 image data
- `content` or `image_base64` is required
- `image_mime_type` is required whenever `image_base64` is provided
- images are normalized into retrieval text and embedded as text; raw image bytes are not stored for download
- if you want the real asset later, store it elsewhere and include `artifact_refs`
- exact duplicate writes within the current idempotency window are replay-safe and reuse the existing document id
- duplicate suppression is intentionally light and based on the normalized write fingerprint, not semantic similarity

`remember_context` defaults:

- omitted `topic` becomes `general`
- omitted `draft` becomes `false`, which stores `branch_state=active`
- `draft=true` stores `branch_state=wip`
- omitted `memory_type` is inferred heuristically

Memory type inference is intentionally simple:

- keywords like `must`, `should`, `required`, `need to` map toward `REQUIREMENT`
- keywords like `prefer`, `preference`, `we like`, `default to` map toward `PREFERENCE`
- keywords like `pattern`, `workflow`, `playbook`, `screenshot` map toward `PATTERN`
- keywords like `spec`, `schema`, `contract`, `interface` map toward `SPEC`
- obvious `we use`, `we decided`, `choose`, `switched to` language maps toward `DECISION`
- otherwise text memories fall back to `GENERAL`
- image-only memories with no text fall back to `GENERAL`

If canonical classification matters, set `memory_type` explicitly instead of relying on inference.

## Lifecycle And Maintenance

Recommended usage:

1. Browser clients save durable memories with `remember_context`.
2. Use `draft=true` only for provisional notes that should not appear in normal active search.
3. Admin clients review WIP material with `get_consolidation_queue`.
4. After writing the canonical replacement, admins can mark obsolete records with `deprecate_context`.

Current lifecycle behavior:

- `remember_context` only creates `active` or `wip` records
- `deprecate_context` does not delete data; it sets `branch_state=deprecated` and records `superseded_by`
- `merged` exists as a searchable historical state, but browser writes do not assign it automatically

## Observability

After deployment, there are three places to look:

- `memory_vectors` in Firestore shows the current memory corpus
- `memory_events` in Firestore shows client-attributed tool usage over time
- Cloud Logging shows request failures and structured tool-event logs

`memory_events` records one document per tool call and one document per ingress rejection/degraded request. Events include:

- `client_id`
- `event_type`
- `status`
- `timestamp`
- `latency_ms`
- a compact `request` summary
- either a compact `response` summary, an `error`, or a request rejection reason

Examples:

- `remember_context` and `store_context` events record the written `document_id`, `module_name`, `branch_state`, and `modality`
- `search_context` events record the requested filters, `result_count`, and returned `result_ids`
- `fetch_context` events record which `document_id` was read
- `deprecate_context` events record `document_id`, `superseding_document_id`, and `previous_state`
- rejected browser/admin requests record `reason=origin_not_allowed` or `reason=unauthorized`
- degraded SSE requests record `reason=sse_capacity_exceeded`

Traceability is by client profile id, so:

- admin endpoint traffic is attributed to `client_id=default`
- ChatGPT web traffic is attributed to `client_id=chatgpt-web`
- Claude web traffic is attributed to `client_id=claude-web`

What is intentionally not stored in observability events:

- full memory bodies
- full image bytes
- raw image downloads

Search events do include a short `query_preview`, but the observability collection is designed to track behavior, not duplicate the corpus.

## Quick start

1. Install dependencies:

   ```bash
   npm --prefix functions install
   ```

2. Create local env vars:

   ```bash
   cp functions/.env.example functions/.env
   ```

   For browser-hosted clients, set a scoped client profile in `functions/.env` or `functions/.env.prod`:

   ```dotenv
   MCP_CLIENT_PROFILES_JSON=[{"id":"chatgpt-web","token":"replace-chatgpt-token","allowedTools":["remember_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://chatgpt.com"]},{"id":"claude-web","token":"replace-claude-token","allowedTools":["remember_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://claude.ai"]}]
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
   MCP_SMOKE_MODE="admin-read-write" \
   npm run smoke
   ```

   Browser-client flow:

   ```bash
   cd functions
   MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/clients/chatgpt-web/mcp" \
   MCP_AUTH_TOKEN="replace-chatgpt-token" \
   MCP_SMOKE_MODE="browser-read-write" \
   npm run smoke
   ```

   Repeat with `/clients/claude-web/mcp` and the Claude token to verify Claude separately.

## Deployment

Deployment playbook: [docs/DEPLOYMENT.md](/Users/nick/git/FirebaseOpenBrain/docs/DEPLOYMENT.md)

For the next production deployment session, start with:

```bash
cd /Users/nick/git/FirebaseOpenBrain
./scripts/deploy-session-preflight.sh
```
