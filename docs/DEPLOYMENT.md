# Deployment Playbook

This is the single deploy guide for Firebase Open Brain.

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

Important constraints:

- `GEMINI_EMBEDDING_DIMENSIONS` must match the vector index dimension in [firestore.indexes.json](/Users/nick/git/FirebaseOpenBrain/firestore.indexes.json)
- if you change embedding models or dimensions after seeding data, do not mix vector spaces in the same collection
- this codebase embeds text; image-backed memories are normalized into text before embedding

Client-scoped endpoints are available, but for the first production release keep it simple and start with the default admin endpoint:

- `<FUNCTION_BASE_URL>/mcp`
- `<FUNCTION_BASE_URL>/mcp/sse`
- `<FUNCTION_BASE_URL>/mcp/messages`

Add client profiles later through `MCP_CLIENT_PROFILES_JSON` when you are ready to expose search-only clients such as Nanobot or browser-hosted consumers.

Recommended browser read/write toolset:

- `remember_context`
- `search_context`
- `fetch_context`

Recommended browser client profile shape:

```dotenv
MCP_CLIENT_PROFILES_JSON=[{"id":"browser","token":"replace-browser","allowedTools":["remember_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://chatgpt.com","https://claude.ai"]}]
```

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
curl -i "http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/healthz"
```

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/mcp" \
MCP_AUTH_TOKEN="replace-me" \
npm run smoke
```

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
- `GEMINI_EMBEDDING_MODEL=text-multimodal-embedding-002`
- `GEMINI_EMBEDDING_DIMENSIONS=768`
- `MEMORY_COLLECTION=memory_vectors`

For the first release, an empty production collection means there is no migration work to do.

If you later switch embedding models or dimensions and want to keep old memories, re-embed them or start with a fresh collection.

### 3. Deploy Firestore indexes

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only firestore:indexes
```

Required vector indexes:

- `metadata.module_name ASC + embedding VECTOR`
- `metadata.branch_state ASC + embedding VECTOR`

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

Capture the deployed base URL for `openBrainMcp`.

The useful production routes are:

- `<FUNCTION_BASE_URL>/healthz`
- `<FUNCTION_BASE_URL>/mcp`
- `<FUNCTION_BASE_URL>/mcp/sse`
- `<FUNCTION_BASE_URL>/mcp/messages`
- `<FUNCTION_BASE_URL>/clients/<CLIENT_ID>/mcp`
- `<FUNCTION_BASE_URL>/clients/<CLIENT_ID>/mcp/sse`
- `<FUNCTION_BASE_URL>/clients/<CLIENT_ID>/mcp/messages`

## Post-deploy verification

### 1. Health check

```bash
curl -i "<FUNCTION_BASE_URL>/healthz"
```

Expected:

- HTTP `200`
- response includes `ok: true`

### 2. Unauthorized request check

```bash
curl -i \
  -X POST "<FUNCTION_BASE_URL>/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
```

Expected:

- HTTP `401`

### 3. Authenticated MCP smoke test

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="<FUNCTION_BASE_URL>/mcp" \
MCP_AUTH_TOKEN="<YOUR_PRODUCTION_TOKEN>" \
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

### 4. Verify the written document

Open Firestore and inspect `memory_vectors`.

Confirm:

- one document was written
- `metadata.branch_state` is `active`
- the stored content is searchable through `search_context`

### 5. Optional multimodal smoke test

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="<FUNCTION_BASE_URL>/mcp" \
MCP_AUTH_TOKEN="<YOUR_PRODUCTION_TOKEN>" \
MCP_IMAGE_BASE64="$(base64 < path/to/image.png | tr -d '\n')" \
MCP_IMAGE_MIME_TYPE="image/png" \
npm run smoke -- --content "Settings screen screenshot for the Compose UI"
```

Expected:

- `store_context` accepts the image-backed memory
- returned metadata includes `modality=text_image`
- `search_context` returns the normalized memory

### 6. Optional scoped-client smoke test

Do this after the admin endpoint is working.

Search-only client example:

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="<FUNCTION_BASE_URL>/clients/nanobot/mcp" \
MCP_AUTH_TOKEN="<NANOBOT_TOKEN>" \
MCP_SMOKE_MODE="search-only" \
npm run smoke
```

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

1. Manual admin use only
2. Nanobot or other clients in `search_context`-only mode
3. Controlled writes for clearly durable events
4. Later use of `deprecate_context` and `get_consolidation_queue`

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
- do not use the admin endpoint for browser-hosted clients

## Debugging

Useful commands:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase functions:list
```

Use Firebase console logs or Cloud Logging for failed production requests.
