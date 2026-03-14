# Deployment Guide

## Reality check

This project is implemented as a Firebase Cloud Functions 2nd Gen HTTP function plus Firestore vector indexes.

As of March 10, 2026, Cloud Functions production deployment requires the Firebase Blaze plan. That means the original Spark-only constraint in the initial spec is no longer achievable for production deployment with this architecture, even if your monthly usage stays inside the no-cost quotas.

What still keeps costs low:

- Firestore still has no-cost usage quotas on Blaze.
- Cloud Functions still has no-cost usage quotas on Blaze.
- A low-traffic MCP server like this one can often stay near zero cost if usage is modest.

## Prerequisites

Install and verify:

```bash
node -v
npm -v
firebase --version
java -version
```

Expected project/runtime assumptions:

- Firebase CLI installed and authenticated with `firebase login`
- Node.js 20 available for Firebase Functions deployment
- Java 11+ available for the local Firestore emulator
- A Firebase project already created
- Firestore database created in Native mode
- Billing upgraded to Blaze for production deployment

## One-time Firebase project setup

1. Select or create the Firebase project in the console.
2. Enable Firestore in Native mode.
3. Upgrade the project to Blaze before attempting production deploys.
4. Bind this repo to the project:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase use --add
```

That command creates `.firebaserc` locally and lets you assign an alias such as `dev` or `prod`.

## Runtime configuration

This code reads runtime configuration from environment variables. For Firebase Functions, the CLI loads values from dotenv files in `functions/`.

Start from the template:

```bash
cp /Users/nick/git/FirebaseOpenBrain/functions/.env.example /Users/nick/git/FirebaseOpenBrain/functions/.env
```

Minimum required values:

```dotenv
GEMINI_API_KEY=...
MCP_AUTH_TOKEN=...
```

Security-related values you will usually want to set explicitly:

```dotenv
MCP_ALLOWED_TOOLS=store_context,search_context,deprecate_context,get_consolidation_queue
MCP_ALLOWED_ORIGINS=
MCP_ALLOWED_FILTER_STATES=active,merged,deprecated,wip
MAX_SSE_SESSIONS=25
```

Recommended layout:

- `functions/.env`
  Common non-secret defaults
- `functions/.env.dev`
  Development project values
- `functions/.env.prod`
  Production project values

Supported variables in this codebase:

- `GEMINI_API_KEY`
- `MCP_AUTH_TOKEN`
- `MCP_ALLOWED_TOOLS`
- `MCP_ALLOWED_ORIGINS`
- `MCP_ALLOWED_FILTER_STATES`
- `MCP_CLIENT_PROFILES_JSON`
- `MAX_SSE_SESSIONS`
- `GEMINI_EMBEDDING_MODEL`
- `GEMINI_MULTIMODAL_MODEL`
- `GEMINI_EMBEDDING_DIMENSIONS`
- `MEMORY_COLLECTION`
- `SEARCH_RESULT_LIMIT`
- `DEFAULT_FILTER_STATE`
- `SERVICE_NAME`
- `SERVICE_VERSION`

Important implementation detail:

- `GEMINI_EMBEDDING_DIMENSIONS` must match the vector index dimension in [firestore.indexes.json](/Users/nick/git/FirebaseOpenBrain/firestore.indexes.json).
- The repo currently defaults to `gemini-embedding-001` and pins embedding output to `768` dimensions.
- `gemini-embedding-2-preview` can also run at `768` dimensions, but changing embedding models still requires a corpus migration.
- Image-backed memories are converted into retrieval text with `gemini-2.5-flash` before they are embedded.

## Endpoint scoping

The function now supports both a default endpoint and client-scoped endpoints.

Default admin endpoint:

- `<FUNCTION_BASE_URL>/mcp`
- `<FUNCTION_BASE_URL>/mcp/sse`
- `<FUNCTION_BASE_URL>/mcp/messages`

Client-scoped endpoints:

- `<FUNCTION_BASE_URL>/clients/<CLIENT_ID>/mcp`
- `<FUNCTION_BASE_URL>/clients/<CLIENT_ID>/mcp/sse`
- `<FUNCTION_BASE_URL>/clients/<CLIENT_ID>/mcp/messages`

Use client-scoped endpoints when different consumers should get different capabilities.

Typical pattern:

- default `/mcp`: full admin tools
- `/clients/nanobot/mcp`: `search_context` only
- `/clients/browser/mcp`: `search_context` only plus explicit browser origins

Example `MCP_CLIENT_PROFILES_JSON`:

```dotenv
MCP_CLIENT_PROFILES_JSON=[{"id":"nanobot","token":"replace-nanobot","allowedTools":["search_context"],"allowedFilterStates":["active"]},{"id":"browser","token":"replace-browser","allowedTools":["search_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://claude.ai","https://gemini.google.com"]}]
```

Notes:

- `MCP_ALLOWED_TOOLS` and `MCP_ALLOWED_ORIGINS` apply to the default `/mcp` endpoint.
- `MCP_ALLOWED_FILTER_STATES` applies to the default `/mcp` endpoint.
- client profiles must declare `allowedTools` explicitly; they no longer default to full access.
- if a client profile omits `allowedFilterStates`, it defaults to the app's `DEFAULT_FILTER_STATE`, which is usually `active`.
- browser access is deny-by-default unless `allowedOrigins` is populated for that profile.
- `MAX_SSE_SESSIONS` caps concurrent SSE sessions per instance.

## Embedding migration note

If this is the first production release and the target Firestore collection is empty, no embedding migration is required. Pick one embedding model, deploy it consistently, and seed the new corpus after release.

This repo previously used OpenAI embeddings. If your deployed Firestore collection already contains OpenAI vectors, do not mix them with the new Gemini vectors in the same search corpus.

Use one of these approaches before switching production traffic:

- delete and repopulate the existing `memory_vectors` collection
- or point `MEMORY_COLLECTION` at a fresh collection name and deploy new indexes for that collection

Treat a switch from `gemini-embedding-001` to `gemini-embedding-2-preview` the same way, even if `GEMINI_EMBEDDING_DIMENSIONS` stays at `768`.

Different embedding models produce different vector spaces. Reusing the same collection without re-embedding will silently degrade or break retrieval quality.

Because this repo also changed its default embedding dimension from `1536` to `768`, any existing `1536`-dimension vectors must be re-embedded before they can participate in the new index.

## Firestore indexes

This app depends on vector indexes in [firestore.indexes.json](/Users/nick/git/FirebaseOpenBrain/firestore.indexes.json).

The important indexes are:

- `metadata.module_name ASC + embedding VECTOR`
- `metadata.branch_state ASC + embedding VECTOR`

Deploy indexes first:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only firestore:indexes
```

Notes:

- Index creation can take time after the deploy command returns.
- `search_context` will fail until the required vector indexes are fully built.
- If you change embedding dimension or metadata filters, update both the code and the index file together.
- If you change embedding models while keeping `768` dimensions, the indexes can stay the same, but the stored corpus still must be re-embedded or moved to a fresh collection.

## Functions deployment

Build locally first:

```bash
cd /Users/nick/git/FirebaseOpenBrain
npm --prefix functions test
npm --prefix functions run build
```

Deploy:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only functions
```

Or deploy both functions and indexes together:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only firestore:indexes,functions
```

## What gets deployed

The deployed function is exported from [functions/src/index.ts](/Users/nick/git/FirebaseOpenBrain/functions/src/index.ts) as `openBrainMcp`.

Runtime options currently set in code:

- Region: `us-central1`
- Timeout: `300` seconds
- Memory: `512MiB`

If you need a different region, change [functions/src/index.ts](/Users/nick/git/FirebaseOpenBrain/functions/src/index.ts) and redeploy.

## Production endpoints

After deploy, get the live HTTPS base URL from:

- the `firebase deploy` output
- or `firebase functions:list`
- or the Firebase console

Once you have the base URL for `openBrainMcp`, the useful routes are:

- `<FUNCTION_BASE_URL>/healthz`
- `<FUNCTION_BASE_URL>/mcp`
- `<FUNCTION_BASE_URL>/mcp/sse`
- `<FUNCTION_BASE_URL>/mcp/messages`
- `<FUNCTION_BASE_URL>/clients/<CLIENT_ID>/mcp`
- `<FUNCTION_BASE_URL>/clients/<CLIENT_ID>/mcp/sse`
- `<FUNCTION_BASE_URL>/clients/<CLIENT_ID>/mcp/messages`

Auth requirement:

- The default `/mcp` endpoint requires `Authorization: Bearer <MCP_AUTH_TOKEN>`
- Each client-scoped endpoint requires that client profile's own bearer token

## Post-deploy smoke test

Health check:

```bash
curl -i "<FUNCTION_BASE_URL>/healthz"
```

MCP smoke test with the included script:

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="<FUNCTION_BASE_URL>/mcp" \
MCP_AUTH_TOKEN="<YOUR_BEARER_TOKEN>" \
npm run smoke
```

Expected result:

- `listTools` returns the tools exposed by that endpoint
- `store_context` stores a sample Ktor networking decision
- `search_context` returns that stored document
- if you pass `--image-base64`, the stored memory is first normalized from image+text into searchable text

Search-only smoke test for a scoped client:

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="<FUNCTION_BASE_URL>/clients/nanobot/mcp" \
MCP_AUTH_TOKEN="<NANOBOT_TOKEN>" \
MCP_SMOKE_MODE="search-only" \
npm run smoke
```

## Failure modes to check first

If deploy succeeds but search fails:

- confirm Firestore vector indexes finished building
- confirm `GEMINI_EMBEDDING_DIMENSIONS=768`
- confirm the deployed embedding model matches the vectors already stored in Firestore
- confirm the Firestore database is in Native mode
- confirm old OpenAI vectors were not left mixed into the same collection

If requests return `401`:

- verify the caller is sending `Authorization: Bearer <MCP_AUTH_TOKEN>`
- verify the deployed `.env` alias loaded the token you expect
- verify you are using the correct token for the correct endpoint

If deploy fails before upload:

- verify `firebase --version`
- verify project is on Blaze
- verify `npm --prefix functions run build` passes locally

If the function deploys but cannot store documents:

- verify the runtime service account has Firestore access
- verify the Firestore API is enabled in the backing Google Cloud project

If browser clients get `403 Origin not allowed`:

- verify the request origin is listed in that client profile's `allowedOrigins`
- verify you are calling the client-scoped endpoint, not the default admin endpoint
