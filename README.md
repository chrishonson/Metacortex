# Firebase Open Brain

Serverless MCP memory layer backed by Firestore vector search and deployed through Firebase Cloud Functions 2nd Gen.

## Important constraint

As of March 10, 2026, Cloud Functions production deployment requires the Firebase Blaze plan. The original Spark-only production target from the initial spec is not compatible with current Firebase Functions deployment rules, though low-traffic usage can still remain close to zero cost within Blaze no-cost quotas.

## What it exposes

- Default Streamable HTTP MCP endpoint: `/openBrainMcp/mcp`
- Default legacy SSE MCP endpoint: `/openBrainMcp/mcp/sse`
- Default legacy SSE message endpoint: `/openBrainMcp/mcp/messages`
- Client-scoped Streamable HTTP MCP endpoint: `/openBrainMcp/clients/<clientId>/mcp`
- Client-scoped legacy SSE endpoint: `/openBrainMcp/clients/<clientId>/mcp/sse`
- Client-scoped legacy SSE message endpoint: `/openBrainMcp/clients/<clientId>/mcp/messages`

The server can register four tools, but each endpoint can expose a different subset:

- `store_context`
- `search_context`
- `deprecate_context`
- `get_consolidation_queue`

`store_context` now supports multimodal memories by accepting text plus an optional inline image. Image-backed memories are normalized into retrieval text with Gemini before they are embedded and stored.

Security model:

- the default `/mcp` endpoint is your general-purpose admin endpoint
- `clients/<clientId>` endpoints let you assign different bearer tokens, origin allowlists, and tool allowlists to Nanobot, browser clients, or other consumers
- browser CORS is deny-by-default unless a client profile explicitly allowlists origins

## Docs

- Deployment runbook: [docs/DEPLOYMENT.md](/Users/nick/git/FirebaseOpenBrain/docs/DEPLOYMENT.md)
- Testing runbook: [docs/TESTING.md](/Users/nick/git/FirebaseOpenBrain/docs/TESTING.md)
- Deployment session runbook: [docs/DEPLOYMENT-SESSION-RUNBOOK.md](/Users/nick/git/FirebaseOpenBrain/docs/DEPLOYMENT-SESSION-RUNBOOK.md)
- Prod rollout and seeding plan: [docs/PROD-ROLLOUT-AND-SEEDING.md](/Users/nick/git/FirebaseOpenBrain/docs/PROD-ROLLOUT-AND-SEEDING.md)

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

6. Optional search-only smoke test for a scoped client endpoint:

   ```bash
   cd functions
   MCP_BASE_URL="http://127.0.0.1:5001/demo-open-brain/us-central1/openBrainMcp/clients/nanobot/mcp" \
   MCP_AUTH_TOKEN="replace-me" \
   MCP_SMOKE_MODE="search-only" \
   npm run smoke
   ```

## Firebase configuration

- Firestore vector indexes live in `firestore.indexes.json`
- Firestore rules live in `firestore.rules`
- The embedding index is configured for `768` dimensions to match the natural output size of `gemini-embedding-001`
- Client profiles are configured with `MCP_ALLOWED_TOOLS`, `MCP_ALLOWED_ORIGINS`, and `MCP_CLIENT_PROFILES_JSON`

Deploy indexes and functions with:

```bash
firebase deploy --only firestore:indexes,functions
```

For the next production deployment session, start with:

```bash
./scripts/deploy-session-preflight.sh
```

If you want Firebase project selection in the repo, add your own `.firebaserc` or run:

```bash
firebase use --add
```
