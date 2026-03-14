# Deployment Session Runbook

Use this runbook for the next session when the goal is to deploy the Firebase Open Brain to production and complete the first real smoke test.

This is intentionally narrow. It assumes the code is already in good shape and the job is to:

1. verify local state
2. deploy indexes and functions
3. run the first production checks
4. store and retrieve one real memory

If anything fails, stop at the first broken layer and fix that before moving on.

## Session goal

By the end of the session, all of this should be true:

- Firestore indexes are deployed and built
- `openBrainMcp` is deployed
- `/healthz` returns `200`
- unauthorized MCP requests return `401`
- the production smoke script succeeds
- one document exists in Firestore `memory_vectors`
- `search_context` retrieves that document

## Known current assumptions

This repo is currently set up for:

- Gemini embeddings
- `gemini-embedding-001`
- `768` dimensions
- Firestore collection `memory_vectors`
- Firebase Functions 2nd Gen in `us-central1`

You also do not have a real legacy OpenAI corpus to migrate. Treat production as a clean Gemini deployment.

Because this has not been released yet, no production embedding migration is required for the first deploy.

If you intentionally switch to `gemini-embedding-2-preview`, keep the index dimension aligned and start with a fresh production corpus. Only treat it as a re-embedding exercise if you decide to preserve pre-release data from an older embedding model.

## Before starting

Have these ready before you begin:

- Firebase CLI authenticated
- access to the correct Firebase project
- Blaze enabled on that project
- Firestore created in Native mode
- a valid `GEMINI_API_KEY`
- a production `MCP_AUTH_TOKEN`
- Node.js, npm, Java, and Firebase CLI installed

If the repo is not bound to the right Firebase project yet, be ready to run:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase use --add
```

Optional shortcut before working through the runbook:

```bash
cd /Users/nick/git/FirebaseOpenBrain
./scripts/deploy-session-preflight.sh
```

That script checks:

- git status
- expected env file presence
- effective deployment embedding dimension alignment between `functions/.env.prod`, code defaults, and Firestore indexes
- current Firebase project selection
- local tests
- local build

## Step 1: Reconfirm the repo state

Run:

```bash
cd /Users/nick/git/FirebaseOpenBrain
git status --short
npm --prefix functions test
npm --prefix functions run build
```

Expected:

- you understand any local uncommitted changes before deploying
- tests pass
- build passes

Stop here if tests or build fail.

## Step 2: Verify production env inputs

Check that production env values exist in `functions/.env.prod` or the dotenv file you plan to use for the production alias.

Minimum required values:

```dotenv
GEMINI_API_KEY=...
MCP_AUTH_TOKEN=...
GEMINI_EMBEDDING_DIMENSIONS=768
```

Also verify:

- `GEMINI_EMBEDDING_MODEL` is explicitly pinned in `functions/.env.prod`
- `GEMINI_EMBEDDING_MODEL=gemini-embedding-001` unless intentionally changed
- `MEMORY_COLLECTION=memory_vectors` unless intentionally changed
- `MCP_ALLOWED_TOOLS` matches what you want on the default admin endpoint
- `MCP_ALLOWED_ORIGINS` is empty unless you intentionally want browser access on the default endpoint

Stop here if env values are missing or inconsistent.

If `GEMINI_EMBEDDING_MODEL` is intentionally changed to `gemini-embedding-2-preview`, that is fine for the first release as long as the target production collection is empty. If you intend to preserve pre-release data, stop here unless the collection is re-embedded or replaced with a fresh `MEMORY_COLLECTION`.

For the first production deploy session, keep it simple:

- deploy and test the default `/mcp` admin endpoint first
- add `MCP_CLIENT_PROFILES_JSON` later when you are ready to expose Nanobot and browser-specific endpoints

## Step 3: Verify index and code alignment

Open and confirm:

- [firestore.indexes.json](/Users/nick/git/FirebaseOpenBrain/firestore.indexes.json)
- [functions/src/config.ts](/Users/nick/git/FirebaseOpenBrain/functions/src/config.ts)

What must agree:

- effective deployment vector dimension is `768`
- the app still targets the same embedding dimension as the deployed index
- the deployed embedding model matches the vector corpus already stored in Firestore

Stop here if dimensions do not match.

## Step 4: Confirm the target Firebase project

Run:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase use
firebase projects:list
```

Expected:

- you know exactly which project alias is active
- the intended production project exists

If needed, switch before deploying.

Do not deploy while unsure which project is active.

## Step 5: Deploy Firestore indexes

Run:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only firestore:indexes
```

Expected:

- the deploy command succeeds

Then verify in the Firebase console or Firestore index UI that the vector indexes are building or complete.

Required indexes:

- `metadata.module_name ASC + embedding VECTOR`
- `metadata.branch_state ASC + embedding VECTOR`

Do not move to search testing until the indexes are fully built.

## Step 6: Deploy functions

Run:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only functions
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

Stop here if function deployment fails.

## Step 7: Run the first production health checks

Health:

```bash
curl -i "<FUNCTION_BASE_URL>/healthz"
```

Expected:

- HTTP `200`
- response body includes `ok: true`

Unauthorized MCP check:

```bash
curl -i \
  -X POST "<FUNCTION_BASE_URL>/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
```

Expected:

- HTTP `401`

Stop here if either check fails.

## Step 8: Run the production MCP smoke test

Run:

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

Stop here if smoke fails.

## Step 9: Verify the written document

Open Firestore and inspect `memory_vectors`.

Confirm:

- one new document exists
- metadata contains the expected `artifact_type`
- metadata contains the expected `module_name`
- metadata contains `branch_state=active`
- the record looks like a Gemini-era write, not leftover older data

If the smoke script stored the sample and search returned it, this step is mostly confirmation.

## Step 10: Run one real manual memory test

Do one small real production write after the generic smoke test.

Use a durable fact from this project, for example:

- Gemini embeddings use `768` dimensions
- Nanobot should start in search-only mode
- Firestore vector search is the backing retrieval layer

The point is to prove one meaningful retrieval, not to seed the whole system.

Then search for it with a natural query and confirm it is returned.

## Step 11: End the session cleanly

Capture these outputs in notes before stopping:

- active Firebase project alias
- deployed function base URL
- whether indexes are complete
- whether the smoke script passed
- which real memory you stored
- whether retrieval returned it
- any follow-up issue that should be fixed before Nanobot integration

## First failure triage

If deploy succeeds but search fails:

- check whether vector indexes finished building
- check `768` dimensions everywhere
- check that the collection is the one you expect

If requests return `401`:

- check the `Authorization: Bearer <token>` header
- check the deployed dotenv alias actually loaded the token you expect

If function deploy fails:

- check Blaze status
- check `firebase use`
- check local build output

If writes fail:

- check Firestore API enablement
- check runtime permissions
- check logs for rejected document shape or config errors

## Do not do in this session

Avoid expanding scope during the first production deploy session.

Do not:

- bulk-seed from provider exports
- attach Nanobot yet
- configure browser-hosted clients yet
- add automatic writes
- change embedding dimensions
- change the collection name unless forced by a deployment issue

The success criterion is one clean production deployment plus one clean production memory round trip.
