# Optional maintenance-agent operating policy

MetaCortex supports an isolated maintenance workflow for consolidation and soft deprecation. The owner must explicitly enable it. The [roadmap](../metacortexplan.md) governs priorities; this guide distinguishes policy from implemented enforcement.

## Current access

Ordinary agents use dedicated scoped endpoints with save/search/fetch and active-state visibility. Do not give an always-on conversation agent the admin token. Listing is optional and must be granted explicitly.

Today maintenance uses the admin endpoint in a separate trusted session. This is broad authority: owner identity, a dedicated enforced maintenance role, quotas, and human-correction authorization are planned rather than implemented. Never mistake caller-provided provenance or `initiator` for validated identity.

## Authorized behavior

After explicit owner enablement, maintenance may inspect overlapping memories, consolidate compatible records, and deprecate superseded records. Use an operator-configured small batch and cadence; the current service does not enforce that batch automatically. Start manually, then schedule only if the owner requests it.

1. Inspect candidate topics and fetch full source records.
2. Separate overlap from contradictions and historical changes.
3. Propose review when evidence is uncertain, sources conflict, or a correction would retract a fact as never true.
4. For authorized consolidation, preserve all relevant meaning and verify the replacement before deprecation.
5. Stop on partial failure. Report IDs and outcomes without claiming the whole batch succeeded.
6. Emit a private audit summary with topic, source/replacement IDs, reason, and review items.

Only auto-deprecate when overlap is strong, the replacement preserves meaning, no unresolved conflict remains, and the reason can be explained. Exceeding the configured batch stops the pass.

## Boundaries

- No permanent deletion, bulk rewrites, or speculative correction.
- Owner authorization is required for corrections of facts that were never true.
- No failure-triggered retries that blindly repeat partially completed consolidation.
- No automatic enablement during setup or baseline integration.
- No ambient admin authority in ordinary agent sessions.

## Implementation gaps

The current consolidation sequence is not atomic. The correction prompt is a convention and is visible even when the profile cannot execute all composed tools. Server-enforced authorization, bounded maintenance, durable operations, and review handling belong to CORE/ACCESS/MANAGE. Until those land, the operator remains responsible for these controls.
