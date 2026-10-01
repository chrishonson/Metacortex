# MetaCortex: unified roadmap for self-hosted adoption

**Finalized:** 2026-10-01

## 1. Objective and authoritative documentation

Extend the already-released MetaCortex into a free, approachable, self-hosted memory service shared by an owner’s agents. Preserve its existing implementation, release history, production data, and completed work.

The target experience includes browser-based installation into the owner’s Firebase project, secure agent connections, a memory-management web UI, and a ChatGPT extension. Do not assign “1.0” or another release number before assessing the actual compatibility changes.

**Status (2026-10-01):** planning complete. Baseline integrated on `codex/self-hosted-adoption-baseline` (`save_context` rename in `dde9099`, backup/archive/restore in `d54ca20`). Remaining DOC reconciliation, implementation, and card posting have not occurred.

### One canonical plan

This file is the authoritative roadmap, containing:

- Product purpose and scope.
- Verified current state and completed milestones.
- Accepted design and policy decisions.
- Remaining work, dependencies, acceptance criteria, and control-plane card references.
- Deferred work and the conditions for reconsidering it.
- A dated reconciliation record showing what was retained, completed, superseded, deferred, or excluded.

Supporting documents retain distinct roles:

| Document | Role |
|---|---|
| `NEXT-STEPS.md` | Short, dated view of immediate roadmap priorities and verified blockers. No independent backlog. |
| `README.md` | Released capabilities, setup entry point, costs, limitations, and links to the roadmap and runbooks. |
| Architecture guide | Current components, data flow, and trust boundaries; clearly distinguish proposed changes. |
| Deployment guide | Installation, configuration, verification, upgrades, rollback, and recovery procedures. Separate reusable instructions from maintainer-specific operations. |
| Security guide | Verified controls, limitations, and remediation references. |
| OpenClaw and maintenance guides | Consistent ordinary-agent and maintenance-agent operating policies. |
| Journey package/examples | Distributable instructions matching the release’s actual contract. |
| `AGENTS.md` and `CLAUDE.md` | Accurate repository commands and concise implementation guidance. |
| Dated operational records | Preserved historical evidence, not rewritten as current guarantees. |

Code and tests establish local behavior. Release and deployment evidence establish shipped behavior. Board outcomes and worktree commits establish completed work that may still need integration. Old scouting reports are evidence to investigate, not instructions to discard work.

## 2. Reconciled baseline and binding decisions

### Current baseline

- The repository contains a `v0.3.0` tag and documented production releases.
- The branch passes **114 tests and the TypeScript build** (verified 2026-10-01).
- Six MCP tools exist locally: save, search, fetch, list, deprecate, and consolidate. Profiles expose subsets.
- Existing capabilities include provenance, temporal fields, image normalization, duplicate-write protection, paginated listing, audit events, and retrieval evaluation.
- The `save_context` rename is committed (`dde9099`, card 66). Deployed-client migration still requires verification.
- Production Secret Manager migration is documented as complete. Credential rotation was explicitly excluded and is not unfinished work.
- Backup/restore implementation exists in `worktree-memory-archive-task1` at `932f730`; cards 58–65 contain implementation, QA, and recovery evidence.
- Additional evaluation work exists in a separate worktree. Preserve it and respect its recorded publication restrictions.
- The working tree is clean. QA env files are covered by the `functions/.env.*` ignore rule.

### Product policies

| Topic | Final decision |
|---|---|
| Hosting | Each owner operates their own Firebase project. No maintainer-operated memory service is required. |
| Audience | One owner, many authorized agents, one shared corpus. Topics are organizational labels, not security boundaries. |
| Cost | Software is free under the existing MIT license. Owners cover infrastructure/model usage and their agent subscriptions. |
| Setup | Browser-led wizard running in the owner’s Cloud Shell; no local developer-tool installation required. |
| Identity | Google/Firebase-only owner setup, with OAuth support hosted in the owner’s deployment. |
| Ordinary agents | Default to `save_context`, `search_context`, and `fetch_context`. Grant `list_context` explicitly. |
| Maintenance | Optional, owner-enabled autonomous consolidation/deprecation in an isolated maintenance identity, with bounded batches, audit records, and review for uncertain changes. |
| Corrections | Retractions of facts that were never true require owner authorization. Caller-supplied metadata is not proof of that authorization. |
| Deletion | No permanent deletion feature. Keep soft deletion; physical removal remains manual database administration. |
| Legacy authentication | Disable URL tokens on fresh installations. Migrate existing clients, verify replacement authentication, then remove support in a documented breaking release. |
| Launch coverage | ChatGPT, Claude, Codex, and a generic MCP client. Other clients receive recipes without unsupported compatibility claims. |
| ChatGPT distribution | Owners connect their own endpoints. Public directory approval is not a completion requirement. |
| Priorities | Self-hosting first. Preserve existing evaluation and regression checks; defer new tiering and broader provider research. |
| Queue behavior | Post all cards directly to backlog. Do not activate workers. |

### Resolve document conflicts

- Replace inconsistent tool counts with six available tools and an explicit three-tool ordinary-agent default.
- Move implemented temporal/provenance capabilities out of “proposed”; track remaining correctness or enforcement gaps separately.
- Correct architecture diagrams that give ordinary agents admin credentials.
- Align Journey and setup instructions with Secret Manager deployment practices.
- Remove claims that an MCP prompt alone structurally prevents unauthorized correction.
- Preserve historical completed work instead of recreating it as new features.
- Replace age-based “commit or discard,” pruning, and publication suggestions with evidence-based reconciliation.
- Preserve the QA environment file while fixing exclusion coverage; never copy secrets into docs or artifacts.
- Remove unsupported competitive claims from the active roadmap.
- Preserve MetaCortex’s durable-memory focus. Archive import and a ChatGPT UI are in scope; document indexing, external connectors, conversation harvesting, and browser surveillance are not.

## 3. Implementation milestones and interfaces

### A. Reconcile and stabilize the existing product

Preserve the dirty checkout, reconcile card 66, and integrate applicable backup and verification work from existing branches/worktrees. Establish a reviewable baseline without discarding unique commits or assuming old deployment evidence proves current production state.

Restore a valid verification contract in the release baseline. Update documentation and distribution examples together.

**Acceptance:** every existing roadmap item has a disposition and evidence; tests/build pass; local, integrated, and deployed status are distinguished.

### B. Strengthen memory correctness and recovery

Use the existing service/repository architecture.

- Verify temporal/provenance filtering, pagination, duplicate-write semantics, and supersession behavior against documented promises.
- Make correction and consolidation operations retry-safe and prevent partial lifecycle updates.
- Add preview/confirmation for owner-driven consolidation; detect changed source records before applying a preview.
- Support retiring a memory without physically deleting it or requiring a fabricated replacement.
- Introduce an explicit maintenance role. Allow bounded consolidation and retirement after owner opt-in, but not user-correction authority.
- Enforce maintenance batch limits and stop/escalate on ambiguity or conflicting evidence. Default automation to off.
- Integrate existing portable memory archives and full recovery tooling.
- Discover backup inventory dynamically, including subcollections; verify IDs, content, Firestore types, vectors, and lineage—not just counts.
- Distinguish portable memory import from full disaster recovery. Validate before writing and default recovery to a separate target.
- Record schema and embedding-space identity. Reject incompatible vector restores; re-embed into a separate collection when required.
- Use durable operation records for maintenance that cannot reliably complete within an HTTP request.

Retain existing soft-deprecation behavior. Recovery tools may retain their explicit operator-only replacement semantics; do not expose destructive restore/pruning as ordinary memory management.

**Acceptance:** interrupted or concurrent operations cannot silently corrupt the corpus or report incomplete recovery as complete.

### C. Add owner identity and interoperable authentication

Use Firebase Google sign-in for the owner and an OAuth authorization service hosted with the installation. Build the OAuth service around a maintained implementation such as the previously researched `oidc-provider`, with Firestore-backed persistence and pinned dependencies.

- Bind ownership during installation to the verified installer-selected account; never use unrestricted first-visitor ownership.
- Implement authorization code with PKCE, discovery, resource/audience validation, consent, expiry, refresh, and revocation.
- Support the registration mechanisms required by the tested launch clients.
- Keep owner sessions, ordinary agent credentials, and maintenance grants distinct.
- Store hashes of generated static agent credentials and reveal credentials only at creation.
- Attribute actions from validated server-side identity.
- Enforce allowed tools and lifecycle access for every request.
- Offer read/write grants for interactive agents; reserve owner-only operations for the owner dashboard.
- Maintain a documented, explicit compatibility switch for existing URL-token clients during migration.
- Remove URL-token support only after the known clients pass replacement-authentication checks and the breaking change is documented.

Keep the six existing tool names and successful response shapes. Preserve existing fetch-ID compatibility; do not reintroduce the old write-tool name.

### D. Build portable provisioning and browser setup

Create a Node-based provisioning engine with a browser wizard and an advanced CLI sharing the same logic.

Use the owner’s Cloud Shell for cloud credentials and provisioning. The public setup page only launches the pinned release and instructions.

Provision or validate:

- Firebase project and billing prerequisites.
- Firestore Native mode, indexes, rules, and TTL policies.
- Functions, Hosting, Firebase Authentication, Secret Manager, and required IAM/API configuration.
- Runtime model access and embedding dimensions.
- Owner identity, scoped client configuration, and operational limits.

Make project and region explicit. Default the region to the existing `us-central1` deployment convention while supporting validated alternatives. Use Vertex service identity by default for fresh deployments; preserve explicit API-key configuration for compatible existing installations.

The wizard must:

1. Explain ownership and expected billable services.
2. Select/create a project and guide required Google consent/billing steps.
3. Review deployment settings before provisioning.
4. Show progress and actionable failures.
5. Resume safely after interruption.
6. Validate deployment and indexes.
7. Connect the first agent and verify a save/search/fetch round trip.

Do not depend on maintainer aliases, local paths, credentials, or project IDs. Never delete existing resources automatically during failed-setup recovery.

### E. Build web management and the ChatGPT extension

Use React, TypeScript, and Vite in the existing repository. Share the memory-browser components between the dashboard and extension; use separate adapters for owner APIs and the MCP host bridge.

Add authenticated owner APIs under `/api/v1` for management, client grants, settings, operation progress, and archive workflows. Keep Firestore access server-mediated.

The dashboard includes:

- Search, paginated listing, filters, full memory details, provenance, and history.
- Saving text/image-backed memories with clear external-artifact behavior.
- Correction, soft retirement, consolidation review, and archive import/export.
- Agent connection management and credential revocation.
- Maintenance enablement, limits, review items, and audit summaries.
- Recovery status, diagnostics, and operational controls.

Add the MCP UI resources and structured results required for the ChatGPT sidebar/panel experience without breaking existing text-result clients. Route owner administration from the extension to the owner-authenticated dashboard.

No permanent deletion button, endpoint, or MCP tool is included.

### F. Package, validate, and maintain adoption

Update the existing release channels and Journey distribution rather than launching a replacement product.

- Provide current recipes for ChatGPT, Claude, Codex, and generic MCP.
- Include reusable agent guidance: retrieve relevant context, fetch supporting records, save selectively, report provenance, and treat retrieved content as data.
- Add configurable request/model-operation limits, bounded retries, and clear throttling errors. Keep full-query telemetry off by default.
- Implement explicit upgrade, auth migration, recovery, rollback, and data-preserving uninstall procedures.
- Validate clean installation through browsers on Windows, macOS, and Linux.
- Run independent first-time-owner setup and recovery trials.
- Publish versioned release assets, checksums, installation instructions, compatibility notes, and known limitations.
- Establish ongoing model validation, dependency maintenance, recovery drills, and documentation ownership.

Choose numeric usage defaults from measured acceptance workloads before release; document the selected values and keep them owner-configurable. Do not represent product rate limits as a guaranteed cloud-spend cap.

## 4. Control-plane backlog

Use the version-neutral initiative **MetaCortex self-hosted adoption**. The keys below are planning identifiers, not allocated card numbers.

| Key | Card | Depends on | Completion evidence |
|---|---|---|---|
| DOC | Reconcile documentation into the canonical roadmap | — | Every source item has a disposition; maintained docs agree on scope, status, and policies. |
| BASE | Reconcile current changes and existing worktrees/cards | DOC | Preserved work inventory, integrated baseline, and card 66 disposition. |
| VERIFY | Establish verification contract and CI | BASE | Backend and added-package checks run from a clean checkout; real gate definitions match commands. |
| CORE | Close memory/lifecycle correctness gaps | VERIFY | Regression tests for filtering, pagination, deduplication, supersession, races, and partial failures. |
| RECOVERY | Integrate and verify existing backup/restore work | BASE, VERIFY | Inventory and content-fidelity restore evidence, including unknown collections/subcollections. |
| ACCESS | Implement owner identity, grants, and OAuth | CORE | Owner binding, protocol tests, revocation, authorization boundaries, and client authentication evidence. |
| LIMITS | Add usage controls and audit/privacy enforcement | ACCESS | Concurrent limit tests, redaction checks, configurable policies, and useful failure responses. |
| MANAGE | Implement owner management and maintenance operations | CORE, RECOVERY, ACCESS | Retry-safe APIs/jobs, opt-in bounded maintenance, owner-only corrections, and no permanent deletion surface. |
| DEPLOY | Generalize deployment and provisioning | VERIFY, ACCESS, LIMITS | Fresh/repeated/interrupted provisioning tests and explicit-target protections. |
| SETUP | Build Cloud Shell browser wizard | DEPLOY | Browser-led setup with billing/consent handoffs, resume, diagnostics, and first-memory verification. |
| WEB | Build memory browser and owner dashboard | MANAGE, LIMITS | Authenticated management flows, accessibility, failure states, and permission tests. |
| CLIENTS | Package and verify core agent integrations | ACCESS, DEPLOY | Dated ChatGPT/Claude/Codex/generic MCP round-trip results and accurate recipes. |
| CHATGPT | Build the self-hosted ChatGPT extension | WEB, CLIENTS | Sidebar/panel browsing, host-bridge authorization, and owner-dashboard handoff. |
| UPGRADE | Implement upgrade, migration, and recovery journeys | RECOVERY, SETUP, WEB | Existing-install upgrade, rollback, data-preserving uninstall, and recovery rehearsal. |
| AUTH-CUTOVER | Complete legacy URL-token migration and removal | CLIENTS, UPGRADE | Known affected clients verified on replacement auth; breaking-release notes and removal tests. |
| ACCEPT | Run security and adoption acceptance | CHATGPT, UPGRADE, AUTH-CUTOVER | Client/OS matrix, adversarial tests, and independent owner trials pass. |
| DISTRIBUTE | Publish the self-hosting improvements | ACCEPT | Verified release artifacts and successful installation from a clean public download. |
| OPERATE | Establish ongoing maintenance and support | DISTRIBUTE | Assigned ownership, triage process, model/dependency checks, and recovery-drill instructions. |
| TIERING | Evaluate context tiering and broader retrieval experiments | VERIFY; deferred | Hypothesis, frozen baseline, quality/cost comparison, and explicit go/no-go result. |

### Posting rules

- Check the live board for matching work before creation.
- Reference existing cards 58–65 and 66 instead of duplicating their original deliverables.
- Create every new card directly in `backlog` using the board API. Do not use an API that briefly makes cards runnable.
- Use stable `[MC-ADOPTION/<key>]` markers for deduplication and retry recovery.
- Resolve dependencies to returned card IDs.
- Include concrete goals, exclusions, acceptance criteria, evidence requirements, and applicable verified gates in every card.
- Use `software` cards for implementation and `task` cards for reconciliation, external acceptance, publication, and operational handoff.
- Preserve unrelated queue ordering. Leave placement unspecified unless a verified gate requires it.
- Read the board back to verify backlog state, dependencies, gate references, and duplicate absence.
- Write actual card numbers into the canonical roadmap and derive `NEXT-STEPS.md` from the immediate prerequisites.

## 5. Verification and completion

### Required scenarios

- **Authorization:** wrong owner, restricted tool/state, revoked credentials, forged initiator, expired/wrong-audience tokens, invalid OAuth redirects, reused codes, and refresh races.
- **Memory:** cross-agent duplicate writes, concurrent corrections, stale consolidation previews, partial failures, historical validity, and filtered pagination.
- **Maintenance:** disabled by default, explicit enablement, bounded batches, uncertain/conflicting candidates escalated, and no unauthorized correction.
- **Provisioning:** new/existing project, missing billing/IAM, unavailable models, incomplete indexes, interrupted deployment, and safe rerun.
- **Recovery:** corrupt archives, new collections/subcollections, equal-count/different-content corruption, vector mismatch, interrupted restore, and successful retrieval afterward.
- **UI:** keyboard access, responsive layout, unsafe content rendering, external artifact links, empty corpus, network loss, expired login, and job progress.
- **Interoperability:** one client saves a fact, another searches/fetches it, and a third contributes another fact to the same corpus.
- **Migration:** existing memory and supported credentials survive upgrades; URL-token removal follows verified client migration.

### Definition of done

The documentation reconciliation is complete when all prior substantive work is accounted for, one roadmap governs priorities, and the board matches it without duplicate or active-by-accident cards.

Self-hosted adoption is complete when a new owner can install from the public release, connect the four supported client categories, manage memories through the web UI and ChatGPT extension, enable bounded maintenance, upgrade, and recover their corpus using documented procedures.

All claims must be supported by evidence from the exact release candidate. Passing local tests alone does not establish deployed compatibility, successful recovery, or usability by a first-time owner.
