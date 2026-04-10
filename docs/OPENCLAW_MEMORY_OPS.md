# OpenClaw Memory Operations

This document defines the recommended two-agent operating model for MetaCortex.

## Objective

Keep the always-on assistant useful as a durable memory client without granting it ambient admin authority.

## Roles

### 1. OpenClaw runtime client

Use a dedicated scoped client profile for normal assistant traffic.

Recommended profile:

```json
{
  "id": "openclaw",
  "token": "replace-openclaw-token",
  "allowedTools": ["remember_context", "search_context", "fetch_context"],
  "allowedFilterStates": ["active"],
  "allowedOrigins": []
}
```

Use `allowedOrigins: []` only if the OpenClaw runtime does not send an `Origin` header. If it runs in Electron, a WebView, or another browser-like shell that does send `Origin`, set `allowedOrigins` to the exact origin value or values that runtime emits.

Purpose:

- save durable memories during normal work
- search prior memories before answering
- fetch the canonical stored item behind a search result

This profile's `allowedFilterStates: ["active"]` setting limits search and fetch visibility to active memories. It does not restrict `remember_context` writes.

Do not give this client `deprecate_context`.
Do not send `draft=true` or an explicit `branch_state` from normal OpenClaw runtime traffic. Leave lifecycle control to the isolated maintenance lane.

### 2. Maintenance admin agent

Use the admin endpoint only in an isolated maintenance lane.

Purpose:

- detect redundant or stale memories
- identify superseded facts
- create canonical replacement records when needed
- deprecate obsolete records with `superseded_by`
- produce an audit summary

This agent should not be the same always-on assistant session that handles user conversations.

## Recommended endpoint split

- admin endpoint: `<FUNCTION_BASE_URL>/mcp`
- OpenClaw client endpoint: `<FUNCTION_BASE_URL>/clients/openclaw/mcp`

## Admin cadence

Recommended starting cadence:

- once daily if memory volume is high
- every 2 to 3 days if memory volume is low
- on-demand after major project changes or migrations

## Admin decision rules

The maintenance agent should only auto-deprecate when all conditions are true:

1. two or more active memories are strongly semantically overlapping
2. one memory is clearly newer or more complete
3. the replacement memory preserves the important content
4. confidence is high enough to avoid data loss by meaning, not by raw deletion

If confidence is low, the agent should emit a review summary instead of deprecating.

## Recommended maintenance workflow

1. search by topic clusters and recent high-activity areas
2. identify duplicate or conflicting active memories
3. if needed, write a new canonical memory that consolidates the best content
4. deprecate obsolete records using `deprecate_context`
5. emit a concise audit summary containing:
   - deprecated ids
   - superseding id
   - topic
   - reason
   - confidence

## Safe failure behavior

- never hard delete memories
- if the replacement write fails, do not deprecate
- if search quality is uncertain, do not deprecate
- if more than a small batch looks affected, stop and summarize instead of bulk mutating

## Suggested admin summary format

```text
Memory maintenance summary
- topic: auth
- canonical item: abc123
- deprecated: def456, ghi789
- reason: newer canonical memory supersedes duplicate active records
- confidence: high
```

## Example `functions/.env.prod` client profile extension

Add an `openclaw` profile alongside browser profiles:

```dotenv
MCP_CLIENT_PROFILES_JSON=[{"id":"chatgpt-web","token":"replace-chatgpt-token","allowedTools":["remember_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://chatgpt.com"]},{"id":"claude-web","token":"replace-claude-token","allowedTools":["remember_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://claude.ai"]},{"id":"openclaw","token":"replace-openclaw-token","allowedTools":["remember_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":[]}]
```

As above, keep `allowedOrigins: []` only for a runtime that sends no `Origin` header. Browser-like OpenClaw shells must list their concrete origin values here.

## Suggested OpenClaw behavior

Normal conversation agent:

- search memory before answering when prior context may matter
- remember durable facts selectively
- omit `draft` and `branch_state` in routine runtime writes so they land as active memories
- avoid writing trivial chatter

Maintenance agent:

- isolated execution only
- admin token only
- scheduled via cron or invoked manually
- summarize every mutation pass
