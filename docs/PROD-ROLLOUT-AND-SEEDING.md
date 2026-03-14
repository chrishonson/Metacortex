# Production Rollout And Organic Memory Growth

## Current situation

You have:

- a working local MCP server
- a passing local emulator smoke test
- no meaningful legacy vector corpus to preserve

That is a good place to be.

Because you never really used the old OpenAI vectors, there is no migration burden beyond making sure production uses the current Gemini setup:

- Firestore vector indexes at `768`
- Gemini embedding config at `768`
- a clean or disposable `memory_vectors` collection

## Core principle

Do not bulk-seed the brain up front.

The right early behavior is:

- deploy it
- prove the hosted MCP works
- let memory grow from small, real interactions
- watch how retrieval quality changes
- only then automate more ingestion

The other important principle:

- external tooling should not pre-format final memory text
- memory ingestion should own normalization, summarization, and storage shape

So any future importer from Gemini, ChatGPT, or Claude should provide raw evidence and metadata to ingestion, not pre-baked memory prose.

## Production rollout

### Phase 1: Pre-deploy checks

Before deploying:

- confirm [firestore.indexes.json](/Users/nick/git/FirebaseOpenBrain/firestore.indexes.json) uses `768`
- confirm `functions/.env.prod` or equivalent has `GEMINI_API_KEY` and `MCP_AUTH_TOKEN`
- run:

```bash
cd /Users/nick/git/FirebaseOpenBrain
npm --prefix functions test
npm --prefix functions run build
```

### Phase 2: Deploy

Deploy indexes first, then functions:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only firestore:indexes
firebase deploy --only functions
```

Or together:

```bash
cd /Users/nick/git/FirebaseOpenBrain
firebase deploy --only firestore:indexes,functions
```

### Phase 3: First production smoke test

Do not involve Nanobot yet.

Start with one manual round trip against the deployed function URL.

1. Health check:

```bash
curl -i "<FUNCTION_BASE_URL>/healthz"
```

Expected:

- HTTP `200`
- JSON includes `ok: true`

2. Unauthorized request check:

```bash
curl -i \
  -X POST "<FUNCTION_BASE_URL>/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
```

Expected:

- HTTP `401`

3. Authenticated MCP smoke test:

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="<FUNCTION_BASE_URL>/mcp" \
MCP_AUTH_TOKEN="<YOUR_BEARER_TOKEN>" \
npm run smoke
```

Expected:

- tool listing succeeds
- `store_context` succeeds
- `search_context` returns the stored sample

4. Verify the Firestore document exists:

- open the `memory_vectors` collection in Firestore
- confirm one document was written
- confirm metadata includes `branch_state=active`

5. Optional multimodal smoke test:

```bash
cd /Users/nick/git/FirebaseOpenBrain/functions
MCP_BASE_URL="<FUNCTION_BASE_URL>/mcp" \
MCP_AUTH_TOKEN="<YOUR_BEARER_TOKEN>" \
MCP_IMAGE_BASE64="$(base64 < path/to/image.png | tr -d '\n')" \
MCP_IMAGE_MIME_TYPE="image/png" \
npm run smoke -- --content "Settings screen screenshot for the Compose UI"
```

## Organic seeding plan

Do not start by mining your full assistant history.

Start by letting the brain accumulate a small number of durable memories from real work.

### Week 1 target

Aim for:

- 5 to 20 memories total

These should come from real events such as:

- an explicit architecture choice
- a stable requirement
- a reusable workflow pattern
- a canonical project constraint
- a meaningful screenshot or image-backed memory

### What to store early

Store only things you would actually want retrieved later.

Good early memories:

- "We are using Ktor for Android/iOS networking"
- "Jetpack Compose is the current Android UI stack"
- "Memory embeddings use Gemini at 768 dimensions"
- "Nanobot should start in search-only mode"

Bad early memories:

- casual discussion fragments
- unresolved brainstorming
- one-off tasks
- temporary experiments
- account or subscription housekeeping

### Why this is better than bulk seeding

Early organic growth lets you answer the important questions first:

- are retrieved memories actually useful
- is the metadata shape sufficient
- are duplicates becoming a problem
- is Nanobot writing the kinds of memories you want

You learn that with 10 real memories faster than with 500 imported ones.

## When to add Nanobot

Not immediately.

Recommended rollout:

### Stage 1: Manual only

Use manual smoke tests and manual `store_context` writes.

### Stage 2: Search-first Nanobot

After you have roughly 10 to 20 useful memories, allow Nanobot to call:

- `search_context`

At this stage, memory helps retrieval, but the bot is not yet shaping the corpus.

Use a dedicated client-scoped endpoint for this stage:

- `/clients/nanobot/mcp`

with:

- its own bearer token
- `allowedTools=["search_context"]`
- `allowedFilterStates=["active"]`
- no browser origins

### Stage 3: Controlled writes

After search quality looks good, allow Nanobot to call:

- `store_context`

but only for clearly durable events:

- accepted architectural decisions
- stable project specs
- durable requirements
- reusable patterns

### Stage 4: Corpus maintenance

Once the corpus is non-trivial, allow use of:

- `deprecate_context`
- `get_consolidation_queue`

## When to test browser-hosted clients

Right after Nanobot search-only is working.

Use a separate client-scoped endpoint for browser clients, for example:

- `/clients/browser/mcp`

with:

- its own bearer token
- a minimal tool set, usually `search_context`
- `allowedFilterStates=["active"]`
- explicit `allowedOrigins` such as `https://claude.ai`

Do not reuse the admin endpoint for browser-hosted clients.

## What to do with Gemini, ChatGPT, and Claude exports

Do not treat those exports as something to bulk-convert directly into final memory text.

Instead:

1. keep the raw exports intact
2. use them later as evidence sources
3. build tooling that identifies candidate memories
4. send raw candidate evidence into memory ingestion
5. let ingestion normalize the final stored text

That keeps one system responsible for memory formatting.

## What an importer should do

A future importer should:

- preserve provider provenance
- select candidate spans or messages
- attach source metadata
- optionally attach related images or artifacts
- hand that raw evidence to ingestion

It should not:

- write the final memory prose itself
- decide the exact stored wording
- bypass ingestion normalization

## Minimal future import flow

When you are ready to harvest from assistant subscriptions, do it in this order:

1. Export Gemini, ChatGPT, and Claude histories to a local archive.
2. Normalize provider formats into one transport shape:
   - provider
   - conversation id
   - message id
   - timestamp
   - speaker
   - raw text
   - attachment refs
3. Run candidate detection only.
4. Feed selected raw evidence into ingestion.
5. Let ingestion create the final stored memory text.
6. Route uncertain items to `wip`.
7. Review retrieval quality before importing more.

## Schema improvements before larger historical import

The current schema is fine for early organic growth.

Before bigger assistant-history ingestion, add provenance fields like:

- `source_provider`
- `source_conversation_id`
- `source_message_ids`
- `source_timestamp`
- `import_batch_id`
- `confidence`

Also consider a new artifact type:

- `PREFERENCE`

That will matter once you start pulling stable preferences out of subscription histories.

## Should this become a skill?

The runbook itself should stay as repo documentation.

The thing that should become a skill is the repeatable workflow around:

- candidate detection
- provenance capture
- ingestion handoff
- review and curation

So:

- no, this document should not itself be a skill
- yes, the future seeding workflow probably should

## Skills that would actually help

### 1. `memory-seeding`

Highest priority.

Purpose:

- process assistant exports
- identify candidate memories
- package raw evidence for ingestion
- avoid pre-formatting final memory text

### 2. `memory-curation`

Purpose:

- review `wip` items
- merge duplicates
- deprecate stale memories
- keep the corpus clean as it grows

### 3. `nanobot-memory-rollout`

Purpose:

- enforce read-first adoption
- define when automatic writes are allowed
- keep rollout disciplined

### 4. `conversation-export-normalizer`

Purpose:

- convert provider-specific exports into one raw transport format

This can either be a standalone skill or part of `memory-seeding`.

## Recommendation

Do this next:

1. deploy and smoke test production
2. add a handful of real memories manually
3. watch how retrieval behaves
4. then attach Nanobot in search-first mode
5. only later build the subscription-export seeding pipeline

If you build one skill next, make it `memory-seeding`.
