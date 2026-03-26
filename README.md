# MetaCortex

MetaCortex is a serverless MCP memory service backed by Firestore vector search and deployed through Firebase Cloud Functions 2nd Gen.

![System Architecture](docs/graphics/architecture.png)

> [!TIP]
> **Brain & Body**: MetaCortex resides in the cloud as the memory core, while Autonomous agents such as OpenClaw act as its local manifest (body). See the full [Architecture & Use Cases](docs/ARCHITECTURE.md) for details.

The practical target is a remote MCP server that chat clients such as ChatGPT web or Claude web can use for:

- searching what the project already knows
- saving new durable memories from chat
- fetching the full stored memory behind a search result

## Usage in ChatGPT web
https://github.com/user-attachments/assets/23db7dff-7946-405c-8a47-29f438684f32

## Using and exporting memories from Claude web
<img width="919" height="467" alt="Screenshot 2026-03-20 at 4 53 53 PM" src="https://github.com/user-attachments/assets/61d10918-2731-47fe-b8de-a7e339c92313" />


## Important constraint

As of March 10, 2026, Cloud Functions production deployment requires the Firebase Blaze plan. The original Spark-only production target from the initial spec is not compatible with current Firebase Functions deployment rules, though low-traffic usage can still remain close to zero cost within Blaze no-cost quotas.

## Primary use cases

This project is set up for these workflows:

1. A chat client asks, "What do we already know about auth/session handling?"
   The model calls `search_context`.
2. The search results include stable `id` values and external artifact refs when available.
   The model can call `fetch_context` with that same `id` for the one result it wants in full.
3. A user says, "Remember that we use Ktor for shared Android and iOS networking."
   The model calls `remember_context`.
4. A user shares a screenshot and says to save it for later retrieval.
   The model calls `remember_context` with image input plus `artifact_refs` if the real asset lives in storage.

## Tool strategy

The current MCP surface is intentionally split between:

- a 3-tool client-facing contract for browser-hosted chat clients
- a 1-tool admin-only maintenance surface for operators

That means the server currently exposes 4 MCP tools total, but normal browser clients should only see 3 of them.

### Client-facing tools

This is the public/browser contract:

- `remember_context`
  The single write tool for normal chat use and advanced admin writes. The client supplies the memory text, optional topic, optional `draft=true` or explicit `branch_state`, optional image input, and optional `artifact_refs`. The server fills in sensible defaults.
- `search_context`
  Vector search over stored memories. Results include stable `id` values and artifact refs when available.
- `fetch_context`
  Fetch one memory by `id` after `remember_context` or `search_context`.

### Admin and maintenance tools

This remains on the server, but it should stay off browser-hosted client profiles:

- `deprecate_context`
  Soft-delete obsolete memories.

WIP consolidation is currently an internal maintenance workflow, not a public MCP tool.

## Why `remember_context` Is The Write Tool

`remember_context` keeps the public write surface simple while still supporting advanced lifecycle control when needed:

- `topic` is the public label and maps to the stored `module_name` internally
- omitted `branch_state` stores canonical memory as `active`
- `draft=true` stores draft material as `wip`
- explicit `branch_state` is available for advanced admin workflows such as `merged`

## Metadata model

These fields exist in stored records because they help maintenance and filtering.

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

For browser clients, prefer `remember_context` with its defaults and use `draft=true` only when the user is explicitly saving rough notes. Admin flows can set `branch_state` explicitly when needed.

### `topic`

Public topic or subsystem label for MCP clients. Internally this is stored as `module_name`.

Examples:

- `auth`
- `billing`
- `kmp-networking`
- `ui-settings`

If omitted, the server defaults it to `general`.

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

- Default Streamable HTTP MCP endpoint: `/metaCortexMcp/mcp`
- Client-scoped Streamable HTTP MCP endpoint: `/metaCortexMcp/clients/<clientId>/mcp`

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

This 3-tool browser contract is the intended v1 public surface.

## Browser Client Setup

For browser-hosted MCP clients, register the scoped endpoint, not the admin endpoint:

- ChatGPT web URL: `https://<FUNCTION_BASE_URL>/clients/chatgpt-web/mcp?auth_token=<YOUR_CHATGPT_TOKEN>`
- Claude web URL: `https://<FUNCTION_BASE_URL>/clients/claude-web/mcp`
- bearer token: the `token` value from the matching client profile
- allowed browser origins: the matching profile's `allowedOrigins`

Do not register `https://<FUNCTION_BASE_URL>/mcp` with ChatGPT web or Claude web. That endpoint is the admin surface and uses `MCP_ADMIN_TOKEN`.

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
   `https://<FUNCTION_BASE_URL>/clients/chatgpt-web/mcp?auth_token=<YOUR_CHATGPT_TOKEN>`

MetaCortex will validate the token from the URL and reject unauthenticated requests even though ChatGPT is configured for "No Auth".

### Connecting to Claude

Depending on your Claude client (e.g., experimental web extensions or custom UIs), you can configure the connection in two ways:

**Option 1: Standard Headers (Preferred)**
- **MCP URL**: `https://<FUNCTION_BASE_URL>/clients/claude-web/mcp`
- **Auth Type**: Bearer Token / Service Token
- **Token**: `Bearer <YOUR_CLAUDE_TOKEN>`

**Option 2: Tokenized URL (If headers are unsupported)**
- **Auth Type**: No Authentication
- **MCP URL**: `https://<FUNCTION_BASE_URL>/clients/claude-web/mcp?auth_token=<YOUR_CLAUDE_TOKEN>`


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
      "topic": "kmp-networking",
      "branch_state": "active",
      "modality": "text",
      "created_at": "2026-03-14T12:00:00.000Z",
      "updated_at": "2026-03-14T12:00:00.000Z"
    }
  },
  "write_status": "created"
}
```

Use `item.id` directly with `fetch_context`.

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
  "filter_topic": "kmp-networking",
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
        "topic": "kmp-networking",
        "branch_state": "active",
        "modality": "text",
        "created_at": "2026-03-14T12:00:00.000Z",
        "updated_at": "2026-03-14T12:00:00.000Z"
      }
    }
  ],
  "applied_filters": {
    "filter_topic": "kmp-networking",
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
    "filter_topic": null,
    "filter_state": "active"
  }
}
```

### `fetch_context`

Preferred input: pass the same `id` returned by `remember_context` or `search_context`.

Example input:

```json
{
  "id": "abc123"
}
```

Typical result:

```json
{
  "item": {
    "id": "abc123",
    "content": "We use Ktor for shared Android and iOS networking.",
    "metadata": {
      "topic": "kmp-networking",
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
- `filter_topic`, when present, is an exact match on the stored topic label
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
- exact duplicate writes within the current idempotency window are replay-safe and reuse the existing memory `id`
- duplicate suppression is intentionally light and based on the normalized write fingerprint, not semantic similarity

`remember_context` defaults:

- omitted `topic` becomes `general`
- omitted `draft` and omitted `branch_state` store `branch_state=active`
- `draft=true` stores `branch_state=wip`
- explicit `branch_state` overrides the default lifecycle state
- `draft` and `branch_state` are mutually exclusive

## Lifecycle And Maintenance

Recommended usage:

1. Browser clients save durable memories with `remember_context`.
2. Use `draft=true` only for provisional notes that should not appear in normal active search.
3. WIP review and consolidation stay in internal maintenance workflows.
4. After writing the canonical replacement, admins can mark obsolete records with the admin-only `deprecate_context` tool.

Current lifecycle behavior:

- `remember_context` defaults to `active`, supports `draft=true` for `wip`, and also accepts explicit `branch_state` for advanced writes
- `deprecate_context` does not delete data; it sets `branch_state=deprecated` and records `superseded_by`
- `merged` exists as a searchable historical state for explicit admin writes

## Observability

After deployment, there are three places to look:

- `memory_vectors` in Firestore shows the current memory corpus
- `memory_events` in Firestore shows client-attributed tool usage over time
- Cloud Logging shows request failures and structured tool-event logs

`memory_events` records one document per tool call and one document per ingress rejection. Events include:

- `client_id`
- `event_type`
- `status`
- `timestamp`
- `latency_ms`
- a compact `request` summary
- either a compact `response` summary, an `error`, or a request rejection reason

Examples:

- public tool payloads use `id` for fetchable memory identifiers
- `remember_context` events record the written `id`, `topic`, `branch_state`, and `modality`
- `search_context` events record the requested filters, `result_count`, and returned `result_ids`
- `fetch_context` events record which `id` was read
- `deprecate_context` events record `id`, `superseding_id`, and `previous_state`
- rejected browser/admin requests record `reason=origin_not_allowed` or `reason=unauthorized`
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
   MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/metaCortexMcp/mcp" \
   MCP_ADMIN_TOKEN="replace-me" \
   MCP_SMOKE_MODE="admin-read-write" \
   npm run smoke
   ```

   Browser-client flow:

   ```bash
   cd functions
   MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/metaCortexMcp/clients/chatgpt-web/mcp" \
   MCP_ADMIN_TOKEN="replace-chatgpt-token" \
   MCP_SMOKE_MODE="browser-read-write" \
   npm run smoke
   ```

   Repeat with `/clients/claude-web/mcp` and the Claude token to verify Claude separately.

## Deployment

Deployment playbook: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

For the next production deployment session, start with:

```bash
cd /Users/nick/git/metacortex
./scripts/deploy-session-preflight.sh
```
