# Firebase Open Brain

Serverless MCP memory layer backed by Firestore vector search and deployed through Firebase Cloud Functions 2nd Gen.

## Important constraint

As of March 10, 2026, Cloud Functions production deployment requires the Firebase Blaze plan. The original Spark-only production target from the initial spec is not compatible with current Firebase Functions deployment rules, though low-traffic usage can still remain close to zero cost within Blaze no-cost quotas.

## What it exposes

- Streamable HTTP MCP endpoint: `/openBrainMcp/mcp`
- Legacy SSE MCP endpoint: `/openBrainMcp/mcp/sse`
- Legacy SSE message endpoint: `/openBrainMcp/mcp/messages`

The MCP server registers two tools:

- `store_context`
- `search_context`

## Docs

- Deployment runbook: [docs/DEPLOYMENT.md](/Users/nick/git/FirebaseOpenBrain/docs/DEPLOYMENT.md)
- Testing runbook: [docs/TESTING.md](/Users/nick/git/FirebaseOpenBrain/docs/TESTING.md)

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

## Firebase configuration

- Firestore vector indexes live in `firestore.indexes.json`
- Firestore rules live in `firestore.rules`
- The embedding index is configured for `1536` dimensions to match `text-embedding-3-small`

Deploy indexes and functions with:

```bash
firebase deploy --only firestore:indexes,functions
```

If you want Firebase project selection in the repo, add your own `.firebaserc` or run:

```bash
firebase use --add
```
