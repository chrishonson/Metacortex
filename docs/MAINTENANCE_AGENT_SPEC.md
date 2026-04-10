# MetaCortex Maintenance Agent Spec

This spec defines the isolated admin worker responsible for memory consolidation and deprecation.

## Purpose

Reduce human review load for routine memory hygiene while keeping destructive authority out of always-on user-facing agents.

## Access Model

The maintenance agent uses the admin endpoint only:

- endpoint: `<FUNCTION_BASE_URL>/mcp`
- auth: `MCP_ADMIN_TOKEN`

It must not run under the same scoped client profile used by OpenClaw day-to-day memory operations.

## Responsibilities

- review recent and high-activity memory areas
- detect duplicate or overlapping active memories
- identify records superseded by newer canonical memories
- create replacement canonical memories when consolidation improves retrieval quality
- deprecate obsolete records using `deprecate_context`
- emit a concise maintenance summary after each pass

## Non-Goals

- no hard deletion
- no bulk corpus rewrites in one pass
- no speculative mutation when confidence is low
- no user-facing conversation duties

## Execution Model

Recommended trigger modes:

1. scheduled pass, daily or every 2 to 3 days
2. on-demand run after major architecture changes, migrations, or noisy write bursts

Recommended environment:

- isolated agent session or background worker
- explicit tool access to admin MCP only
- no ambient access in normal chat sessions

## Maintenance Pass Algorithm

1. identify candidate topics
   - recent write-heavy topics
   - repeated retrieval topics
   - topics with many active items
2. inspect active records for semantic overlap or contradiction
3. classify each cluster:
   - no action
   - consolidate
   - deprecate older duplicate
   - escalate for manual review
4. if consolidation is needed:
   - write a new canonical memory capturing the best current truth
   - confirm the new record exists and is fetchable
5. deprecate obsolete records with `superseded_by`
6. output audit summary

## Auto-Deprecation Threshold

Only auto-deprecate when all are true:

- overlap is strong
- replacement is clearly newer, more complete, or more precise
- no meaningful conflict remains unresolved
- the agent can explain the reason in one sentence

If any condition fails, emit a review item instead of mutating.

## Suggested Summary Output

```text
MetaCortex maintenance summary
- scanned topics: auth, memory, deployment
- consolidated: 2
- deprecated: 3
- review-needed: 1

Details
- topic: auth
  canonical: abc123
  deprecated: def456, ghi789
  reason: newer canonical auth flow supersedes duplicate active memories
  confidence: high
```

## Safe Failure Rules

- if replacement write fails, do not deprecate
- if search results are ambiguous, do not deprecate
- if a pass would deprecate more than a small batch, stop and summarize
- keep all actions auditable via event logs and summary output

## Recommended Cadence

Start with one pass every 2 days.
Increase to daily only if write volume justifies it.

## Relationship To OpenClaw Runtime Client

OpenClaw runtime client:

- endpoint: `<FUNCTION_BASE_URL>/clients/openclaw/mcp`
- tools: `remember_context`, `search_context`, `fetch_context`
- state visibility: `active`

Maintenance agent:

- endpoint: `<FUNCTION_BASE_URL>/mcp`
- token: admin only
- includes `deprecate_context`

Keep these trust boundaries separate.
