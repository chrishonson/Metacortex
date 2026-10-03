# Security and operational boundaries

This document describes current implementation and accepted policy. Planned controls are tracked in the [roadmap](../metacortexplan.md); documentation does not claim they are already enforced.

## Current controls

- Dedicated client tokens, tool allowlists, readable-state allowlists, and per-profile origin rules.
- Separate admin endpoint and three-tool ordinary-agent profiles; `list_context` requires an explicit grant.
- Firestore rules deny direct client access to memory, audit, fingerprint, and evaluation collections. Admin SDK access uses IAM.
- Runtime secrets are bound through Secret Manager. The [2026-09-09 migration](operations/2026-09-09-secret-migration.md) is complete; it did not rotate credentials.
- Requests have a 1 MB JSON limit, including base64 image input. Raw image assets are not stored.
- Full retrieval-query telemetry is opt-in. Audit summaries can still include a query preview and error metadata; treat them as private data.

## Verified gaps and disposition

| Gap | Current behavior | Planned work |
|---|---|---|
| Legacy URL credentials | `auth_token` query authentication is accepted and may appear in infrastructure URL logs. | ACCESS/AUTH-CUTOVER: new-install disablement, verified client migration, then breaking removal. No silent removal in this baseline. |
| No owner/OAuth enforcement | Static credentials authorize profiles. A correction prompt or `initiator=user` is not proof of human action. | ACCESS/CORE: validated identities and owner-authorized corrections. |
| Shared corpus | Profiles do not isolate topics, projects, or users. | Intentional single-owner design; document rather than imply tenancy. |
| Write-state policy | Read-state allowlists do not restrict advanced save lifecycle fields. | CORE: test and enforce the documented permission contract. |
| Unbounded model usage | No per-client or installation-wide quotas are implemented. | LIMITS: configurable concurrent-safe limits and bounded retries. |
| Partial lifecycle operations | Consolidation writes a replacement before separate source updates. | CORE/MANAGE: retry-safe atomic or recoverable operations. |
| Backup limitations | Existing inventory gate checks top-level collection counts, not full content fidelity or a consistent recursive snapshot. | RECOVERY; see the archive runbooks before operating. |
| Credential comparison | Length mismatch returns before the timing-safe comparison. | ACCESS hardening; do not overstate constant-time guarantees. |
| Public topology / headers | Health reveals endpoint paths; JSON defensive headers are limited. | LIMITS review, lower priority than authorization and recovery. |
| CORS method advertisement | DELETE is advertised but the stateless transport rejects it. | LIMITS protocol/header consistency review. |

## Accepted authority policy

Normal agents receive save/search/fetch only. Listing is opt-in. An isolated maintenance identity may automatically consolidate/deprecate only after the owner enables it, with bounded batches, audit records, and escalation when meaning conflicts. User corrections require owner authorization. No product or agent interface may permanently delete memories.

The current maintenance guides are operator policy, not server-enforced quotas or ownership checks. Do not claim those planned controls are active.

## Secret and archive handling

Never commit deployment dotenv files, Secret Manager overrides, tokens, or memory exports. `.env.example` contains placeholders only. Production dotenv contains non-secret configuration; local emulator secrets belong in ignored overrides.

The portable archive writes plaintext memories into a private Git repository and pushes by default. Use dry-run for inspection and `--no-push` when only a local archive commit is intended. Full restore with `--write` prunes documents absent from archived collections; it is an explicit operator recovery action. Neither action is part of normal agent access.

Do not disable private-repository, IAM, or credential protections to simplify installation. Report sensitive issues privately to the repository maintainer rather than including credentials or private memory in public issues. A formal public security-response policy is part of DISTRIBUTE/OPERATE.
