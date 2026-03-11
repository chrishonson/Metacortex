# Testing Guide

## Test layers in this repo

This project has three useful testing layers:

1. Fast local unit and integration tests with mocked embeddings and in-memory storage
2. Manual local HTTP testing through the Firebase Emulator Suite
3. Production smoke testing against the deployed MCP endpoint

## Automated tests

Run the full local suite:

```bash
cd /Users/nick/git/FirebaseOpenBrain
npm --prefix functions test
```

What this covers:

- config loading and validation
- bearer auth behavior
- per-client tool scoping
- browser-origin allowlisting
- service-layer store/search behavior
- MCP transport wiring over Streamable HTTP
- MCP transport wiring over legacy SSE

The end-to-end MCP tests use real MCP client transports against a local in-process HTTP server. They do not hit Firestore or the live Gemini APIs.
The multimodal path is covered with a mocked image-backed `store_context` call, but it still does not hit the live Gemini APIs.

## Build verification

Compile the function bundle:

```bash
cd /Users/nick/git/FirebaseOpenBrain
npm --prefix functions run build
```

This should always pass before any emulator run or deploy.

## Local emulator testing

### Prerequisites

- Firebase CLI installed
- Java 11+ installed for the Firestore emulator
- local env configured in `functions/.env`

Example:

```bash
cp /Users/nick/git/FirebaseOpenBrain/functions/.env.example /Users/nick/git/FirebaseOpenBrain/functions/.env
```

Fill in at least:

```dotenv
GEMINI_API_KEY=...
MCP_AUTH_TOKEN=...
```

If you want to test scoped clients locally, also set:

```dotenv
MCP_CLIENT_PROFILES_JSON=[{"id":"nanobot","token":"nano-token","allowedTools":["search_context"]},{"id":"browser","token":"browser-token","allowedTools":["search_context"],"allowedOrigins":["https://claude.ai"]}]
```

### Start emulators

```bash
cd /Users/nick/git/FirebaseOpenBrain
npm --prefix functions run serve
```

The Functions emulator and Firestore emulator ports are defined in [firebase.json](/Users/nick/git/FirebaseOpenBrain/firebase.json):

- Functions: `5001`
- Firestore: `8080`
- Emulator UI: `4000` by default unless Firebase assigns another port

### Local function base URL

For an HTTP function named `openBrainMcp` in `us-central1`, the emulator URL pattern is:

```text
http://127.0.0.1:5001/<PROJECT_ID>/us-central1/openBrainMcp
```

If you want a predictable local project ID, start the emulator with an explicit project:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase emulators:start --project demo-open-brain --only functions,firestore
```

Then the local base URL is:

```text
http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp
```

## Manual local checks

### Health endpoint

```bash
curl -i "http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/healthz"
```

Expected result:

- HTTP `200`
- JSON body containing `ok: true`

### Unauthorized request check

```bash
curl -i \
  -X POST "http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
```

Expected result:

- HTTP `401`

### Streamable HTTP MCP smoke test

Use the included script:

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/mcp" \
MCP_AUTH_TOKEN="replace-me" \
npm run smoke
```

Expected result:

- tool listing succeeds
- `store_context` succeeds
- `search_context` returns the stored Ktor document

### Scoped client smoke test

For a search-only client profile:

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/clients/nanobot/mcp" \
MCP_AUTH_TOKEN="nano-token" \
MCP_SMOKE_MODE="search-only" \
npm run smoke
```

Expected result:

- tool listing only shows `search_context`
- the smoke script does not attempt a write
- `search_context` returns results if the corpus already contains matching data

### Browser origin check

For a browser client profile, verify preflight manually:

```bash
curl -i \
  -X OPTIONS "http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/clients/browser/mcp" \
  -H "Origin: https://claude.ai"
```

Expected result:

- HTTP `204`
- `Access-Control-Allow-Origin: https://claude.ai`

Optional multimodal smoke test:

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/mcp" \
MCP_AUTH_TOKEN="replace-me" \
MCP_IMAGE_BASE64="$(base64 < path/to/image.png | tr -d '\n')" \
MCP_IMAGE_MIME_TYPE="image/png" \
npm run smoke -- --content "Settings screen screenshot for the Compose UI"
```

Expected result:

- `store_context` accepts the image-backed memory
- the returned metadata includes `modality=text_image`
- `search_context` returns the normalized memory text

## Production smoke testing

After deployment, re-run the same script against the real endpoint:

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="<FUNCTION_BASE_URL>/mcp" \
MCP_AUTH_TOKEN="<YOUR_BEARER_TOKEN>" \
npm run smoke
```

Also run:

```bash
curl -i "<FUNCTION_BASE_URL>/healthz"
```

## What the automated tests do not prove

The local test suite does not prove:

- real Gemini embedding API connectivity
- real Gemini multimodal normalization output quality
- real Firestore write permissions in your deployed project
- vector index build completion in Firestore
- production latency or cold-start behavior

That is why you should always do a post-deploy smoke test.

## Recommended release checklist

Before deploy:

- `npm --prefix functions test`
- `npm --prefix functions run build`
- confirm `functions/.env.<alias>` values are correct
- confirm [firestore.indexes.json](/Users/nick/git/FirebaseOpenBrain/firestore.indexes.json) still matches embedding dimensions
- if migrating from OpenAI, confirm the target Firestore collection is clean or re-embedded
- if migrating from the earlier `1536`-dimension Gemini config, confirm all stored vectors were re-embedded to `768`

After deploy:

- `curl <FUNCTION_BASE_URL>/healthz`
- `npm --prefix functions run smoke` with production URL/token
- `npm --prefix functions run smoke` with `MCP_SMOKE_MODE=search-only` for restricted clients
- confirm one document appears in Firestore collection `memory_vectors`
- confirm a subsequent `search_context` request returns it

## Logging and debugging

Local debugging:

- watch terminal output from `firebase emulators:start`
- inspect Emulator UI logs

Production debugging:

- `firebase functions:list`
- Firebase console logs for `openBrainMcp`
- Cloud Logging entries for failed requests
