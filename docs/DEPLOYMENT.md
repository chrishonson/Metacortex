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
OPENAI_API_KEY=...
MCP_AUTH_TOKEN=...
```

Recommended layout:

- `functions/.env`
  Common non-secret defaults
- `functions/.env.dev`
  Development project values
- `functions/.env.prod`
  Production project values

Supported variables in this codebase:

- `OPENAI_API_KEY`
- `MCP_AUTH_TOKEN`
- `OPENAI_EMBEDDING_MODEL`
- `OPENAI_EMBEDDING_DIMENSIONS`
- `MEMORY_COLLECTION`
- `SEARCH_RESULT_LIMIT`
- `DEFAULT_FILTER_STATE`
- `SERVICE_NAME`
- `SERVICE_VERSION`
- `OPENAI_BASE_URL`

Important implementation detail:

- `OPENAI_EMBEDDING_DIMENSIONS` must match the vector index dimension in [firestore.indexes.json](/Users/nick/git/FirebaseOpenBrain/firestore.indexes.json).
- The repo is currently configured for `text-embedding-3-small` with dimension `1536`.

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

Auth requirement:

- Every MCP request must include `Authorization: Bearer <MCP_AUTH_TOKEN>`

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

- `listTools` returns `store_context` and `search_context`
- `store_context` stores a sample Ktor networking decision
- `search_context` returns that stored document

## Failure modes to check first

If deploy succeeds but search fails:

- confirm Firestore vector indexes finished building
- confirm `OPENAI_EMBEDDING_DIMENSIONS=1536`
- confirm the deployed model is still `text-embedding-3-small`
- confirm the Firestore database is in Native mode

If requests return `401`:

- verify the caller is sending `Authorization: Bearer <MCP_AUTH_TOKEN>`
- verify the deployed `.env` alias loaded the token you expect

If deploy fails before upload:

- verify `firebase --version`
- verify project is on Blaze
- verify `npm --prefix functions run build` passes locally

If the function deploys but cannot store documents:

- verify the runtime service account has Firestore access
- verify the Firestore API is enabled in the backing Google Cloud project
