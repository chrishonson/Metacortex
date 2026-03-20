# Deployment Playbook

This is the single deploy guide for MetaCortex.

Use it for:

- local verification before release
- the first production deployment
- the first production smoke test
- the first weeks of rollout after launch

## Current release contract

The deploy path in this repo currently assumes:

- Firebase Cloud Functions 2nd Gen in `us-central1`
- Firestore in Native mode
- Firebase Blaze plan for production deploys
- Firestore collection `memory_vectors`
- Firestore collection `memory_events` for audit and observability
- embedding output pinned to `768` dimensions
- embedding model pinned to `text-multimodal-embedding-002`
- multimodal normalization model pinned to `gemini-3.1-flash-lite-preview`

For the first production release, if `memory_vectors` is empty, no embedding migration is required.

## Before you start

Install and verify:

```bash
node -v
npm -v
firebase --version
java -version
```

You need:

- Firebase CLI authenticated with `firebase login`
- a Firebase project with Blaze enabled
- Firestore created in Native mode
- access to the correct Firebase project alias
- a valid `GEMINI_API_KEY`
- a production `MCP_AUTH_TOKEN`

If the repo is not bound to the right Firebase project yet:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase use --add
```

## Runtime config

Firebase Functions loads dotenv files from `functions/`.

Recommended layout:

- `functions/.env`: local development values
- `functions/.env.dev`: development project values
- `functions/.env.prod`: production project values

`functions/.env.prod` is local deployment config and should stay out of Git.

Start from the template:

```bash
cp /Users/nick/git/FirebaseOpenBrain/functions/.env.example /Users/nick/git/FirebaseOpenBrain/functions/.env
```

Minimum required production values:

```dotenv
GEMINI_API_KEY=...
MCP_AUTH_TOKEN=...
GEMINI_EMBEDDING_MODEL=text-multimodal-embedding-002
GEMINI_MULTIMODAL_MODEL=gemini-3.1-flash-lite-preview
GEMINI_EMBEDDING_DIMENSIONS=768
MEMORY_COLLECTION=memory_vectors
```

Recommended security and access defaults for the first release:

```dotenv
MCP_ALLOWED_TOOLS=remember_context,store_context,search_context,fetch_context,deprecate_context,get_consolidation_queue
MCP_ALLOWED_ORIGINS=
MCP_ALLOWED_FILTER_STATES=active,merged,deprecated,wip
MAX_SSE_SESSIONS=25
SEARCH_RESULT_LIMIT=5
DEFAULT_FILTER_STATE=active
```

Origin config split:

- `MCP_ALLOWED_ORIGINS` applies only to the default admin `/mcp` endpoint
- browser-hosted clients should use `MCP_CLIENT_PROFILES_JSON[].allowedOrigins`
- leave `MCP_ALLOWED_ORIGINS` empty unless you intentionally want browser access to the admin endpoint

Important constraints:

- `GEMINI_EMBEDDING_DIMENSIONS` must match the vector index dimension in [firestore.indexes.json](/Users/nick/git/FirebaseOpenBrain/firestore.indexes.json)
- if you change embedding models or dimensions after seeding data, do not mix vector spaces in the same collection
- this codebase embeds text; image-backed memories are normalized into text before embedding

Use the default `/mcp` endpoint as the admin surface only. For ChatGPT web and Claude web, deploy separate scoped client profiles from day one:

- admin: `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/mcp`
- admin SSE: `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/mcp/sse`
- ChatGPT web: `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/chatgpt-web/mcp`
- Claude web: `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/claude-web/mcp`

Recommended browser read/write toolset:

- `remember_context`
- `search_context`
- `fetch_context`

Recommended web client profile shape:

```dotenv
MCP_CLIENT_PROFILES_JSON=[{"id":"chatgpt-web","token":"replace-chatgpt-token","allowedTools":["remember_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://chatgpt.com"]},{"id":"claude-web","token":"replace-claude-token","allowedTools":["remember_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://claude.ai"]}]
```

Keep each web-client token distinct from `MCP_AUTH_TOKEN`. The admin token should stay reserved for maintenance and ops-only clients.

## Local verification

Run the preflight first:

```bash
cd /Users/nick/git/FirebaseOpenBrain
./scripts/deploy-session-preflight.sh
```

That script checks:

- git status
- expected env file presence
- effective production embedding config versus Firestore index dimensions
- current Firebase project selection
- full test suite
- TypeScript build

If you want a manual local round-trip before production:

```bash
cd /Users/nick/git/FirebaseOpenBrain
npm --prefix functions run serve
```

Then in another shell:

```bash
curl -i "http://127.0.0.1:5001/demo-open-brain/us-central1/metaCortexMcp/healthz"
```

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/metaCortexMcp/mcp" \
MCP_AUTH_TOKEN="replace-me" \
npm run smoke -- --mode admin-read-write
```

Browser-client flow:

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/metaCortexMcp/clients/chatgpt-web/mcp" \
MCP_AUTH_TOKEN="replace-chatgpt-token" \
MCP_SMOKE_MODE="browser-read-write" \
npm run smoke
```

Repeat with `/clients/claude-web/mcp` and the Claude token to validate Claude separately.

The automated tests and build can also be run directly:

```bash
cd /Users/nick/git/FirebaseOpenBrain
npm --prefix functions test
npm --prefix functions run build
```

## Deploy

### 1. Confirm the target project

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase use
firebase projects:list
```

Do not deploy while unsure which alias is active.

### 2. Confirm production env values

Verify that `functions/.env.prod` or the dotenv file you plan to deploy with includes the intended values, especially:

- `GEMINI_API_KEY`
- `MCP_AUTH_TOKEN`
- `MCP_ALLOWED_ORIGINS` only if you intentionally want browser access to the admin endpoint
- `MCP_CLIENT_PROFILES_JSON` with both `chatgpt-web` and `claude-web` profiles
- `GEMINI_EMBEDDING_MODEL=text-multimodal-embedding-002`
- `GEMINI_EMBEDDING_DIMENSIONS=768`
- `MEMORY_COLLECTION=memory_vectors`

For the first release, an empty production collection means there is no migration work to do.

If you later switch embedding models or dimensions and want to keep old memories, re-embed them or start with a fresh collection.

Also confirm the actual web-client registration values you will use:

- ChatGPT URL: `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/chatgpt-web/mcp`
- Claude URL: `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/claude-web/mcp`
- each bearer token comes from the matching client profile, not `MCP_AUTH_TOKEN`
- each web origin must match the profile's `allowedOrigins`

### 3. Deploy Firestore indexes

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only firestore:indexes
```

Required vector indexes:

- `metadata.module_name ASC + embedding VECTOR`
- `metadata.branch_state ASC + embedding VECTOR`
- `metadata.branch_state ASC + metadata.module_name ASC + embedding VECTOR`

Wait until those indexes are fully built before trusting search results.

### 4. Deploy the function

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only functions
```

Or deploy both together:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only firestore:indexes,functions
```

Capture the deployed base URL for `metaCortexMcp`.

The useful production routes are:

- `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/healthz`
- `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/mcp`
- `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/mcp/sse`
- `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/mcp/messages`
- `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/<CLIENT_ID>/mcp`
- `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/<CLIENT_ID>/mcp/sse`
- `https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/<CLIENT_ID>/mcp/messages`

## Post-deploy verification

### 1. Health check

```bash
curl -i "https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/healthz"
```

Expected:

- HTTP `200`
- response includes `ok: true`

### 2. Unauthorized request check

```bash
curl -i \
  -X POST "https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
```

Expected:

- HTTP `401`

### 3. Browser CORS preflight

```bash
curl -i \
  -X OPTIONS "https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/chatgpt-web/mcp" \
  -H "Origin: https://chatgpt.com"
```

Expected:

- HTTP `204`
- `Access-Control-Allow-Origin: https://chatgpt.com`

Repeat with:

```bash
curl -i \
  -X OPTIONS "https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/claude-web/mcp" \
  -H "Origin: https://claude.ai"
```

### 4. Authenticated admin MCP smoke test

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/mcp" \
MCP_AUTH_TOKEN="<ADMIN_MCP_TOKEN>" \
MCP_SMOKE_MODE="admin-read-write" \
npm run smoke
```

Expected:

- tool listing succeeds
- `store_context` succeeds
- `search_context` returns the stored sample

This is the first proof that:

- auth works
- the live Gemini call works
- Firestore writes work
- Firestore vector search works

### 5. Authenticated browser MCP smoke test

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/chatgpt-web/mcp" \
MCP_AUTH_TOKEN="<CHATGPT_WEB_TOKEN>" \
MCP_SMOKE_MODE="browser-read-write" \
npm run smoke -- --content "Remember that we use Ktor for shared Android and iOS networking." --query "shared networking for android and ios"
```

Expected:

- `remember_context` succeeds
- `search_context` returns a result with `id=...`
- `fetch_context` returns the full stored record, including both `content` and `retrieval_text`

Repeat the same smoke test against `/clients/claude-web/mcp` with `<CLAUDE_WEB_TOKEN>`.

This is the first proof that each web-facing toolset is usable end to end.

### 6. Verify observability events

Open Firestore and inspect `memory_events`.

Confirm:

- at least one event exists for each successful smoke-test tool call
- admin calls are recorded with `client_id=default`
- ChatGPT web calls are recorded with `client_id=chatgpt-web`
- Claude web calls are recorded with `client_id=claude-web`
- tool events include `tool_name`, `status`, `timestamp`, `latency_ms`, and a compact `request` / `response` or `error`
- request rejections and degraded events use `event_type=request` with a `reason` such as `unauthorized`, `origin_not_allowed`, or `sse_capacity_exceeded`

Cloud Logging should also contain structured `openBrainMcp tool event` and `openBrainMcp request event` entries for the same calls.

### 7. Verify the written document

Open Firestore and inspect `memory_vectors`.

Confirm:

- one document was written
- `metadata.branch_state` is `active`
- the record stores both canonical `content` and internal `retrieval_text`
- `metadata.created_at` and `metadata.updated_at` are present
- the stored content is searchable through `search_context`

### 8. Optional multimodal browser smoke test

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="https://us-central1-my-brain-88870.cloudfunctions.net/metaCortexMcp/clients/chatgpt-web/mcp" \
MCP_AUTH_TOKEN="<CHATGPT_WEB_TOKEN>" \
MCP_SMOKE_MODE="browser-read-write" \
MCP_IMAGE_BASE64="$(base64 < path/to/image.png | tr -d '\n')" \
MCP_IMAGE_MIME_TYPE="image/png" \
MCP_ARTIFACT_REF="gs://your-bucket/path/to/image.png" \
npm run smoke -- --content "Settings screen screenshot for the Compose UI" --query "compose settings screenshot"
```

Repeat with `/clients/claude-web/mcp` and `<CLAUDE_WEB_TOKEN>` if Claude web will ingest images.

Expected:

- `remember_context` accepts the image-backed memory
- returned JSON metadata includes `modality=mixed` when both text and image are present
- `search_context` returns a summary with the same `id=...`
- `fetch_context` returns the same `artifact_refs`

## Token Management

Use separate tokens for separate trust boundaries:

- `MCP_AUTH_TOKEN` is the admin token for `/mcp`
- `MCP_CLIENT_PROFILES_JSON[].token` is the scoped token for each client endpoint

Rotation and revocation rules:

- rotate a web client token by changing that profile's `token` and redeploying functions
- revoke a client by removing the profile or replacing its token and redeploying functions
- do not reuse `MCP_AUTH_TOKEN` for browser-hosted clients
- if ChatGPT web and Claude web should be revoked independently, give them separate client profiles

## Observability

After deployment, use these views together:

- `memory_vectors` for the current corpus
- `memory_events` for client-attributed usage and audit history
- Cloud Logging for request failures and structured tool-event logs

`memory_events` is populated automatically by successful and failed tool calls plus ingress-level auth/CORS/degraded events. It is the easiest way to answer:

- which client is writing memories
- which client is searching or fetching most often
- which memory ids are being returned or fetched repeatedly
- how many searches return zero results
- whether a specific client is generating repeated tool errors
- whether a specific client is hitting repeated `401`, `403`, or SSE-capacity failures

The event payload is intentionally compact. It records ids, filters, counts, states, reasons, and latency rather than duplicating full memory bodies.

## First-release rollout

Do not bulk-seed the corpus before launch.

For the first release:

- deploy the hosted MCP server
- prove the hosted round trip works
- let the first memories come from real work
- watch retrieval quality before expanding automation

Early target:

- 5 to 20 durable memories

Good early memories:

- stable architecture decisions
- durable project constraints
- reusable workflows
- canonical requirements
- meaningful screenshots with lasting retrieval value

Recommended rollout order:

1. Admin endpoint reserved for maintenance and smoke tests
2. Browser client rollout on `remember_context`, `search_context`, and `fetch_context`
3. Controlled writes only for clearly durable events
4. Search-only downstream clients such as Nanobot
5. Later use of `deprecate_context` and `get_consolidation_queue`

## Failure checks

If deploy succeeds but search fails:

- confirm vector indexes finished building
- confirm `GEMINI_EMBEDDING_MODEL` and `GEMINI_EMBEDDING_DIMENSIONS` match what you deployed
- confirm Firestore is in Native mode
- confirm the production collection does not mix vectors from different models or dimensions

If requests return `401`:

- verify `Authorization: Bearer <TOKEN>`
- verify the token belongs to the endpoint you are calling
- verify the deployed dotenv alias loaded the values you expect

If the function deploys but cannot store documents:

- verify the runtime service account has Firestore access
- verify the Firestore API is enabled in the backing Google Cloud project

If browser clients get `403 Origin not allowed`:

- verify the request is using a client-scoped endpoint
- verify that client profile has the expected `allowedOrigins`
- verify the browser token matches the scoped client endpoint
- do not use the admin endpoint for browser-hosted clients

## Debugging

Useful commands:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase functions:list
```

Use Firebase console logs or Cloud Logging for failed production requests.
