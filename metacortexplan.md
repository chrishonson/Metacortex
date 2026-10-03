# MetaCortex: unified roadmap for self-hosted adoption

**Finalized:** 2026-10-01

## 1. Objective and authoritative documentation

Extend the already-released MetaCortex into a free, approachable, self-hosted memory service shared by an owner’s agents. Preserve its existing implementation, release history, production data, and completed work.

The target experience includes browser-based installation into the owner’s Firebase project, secure agent connections, a memory-management web UI, and a ChatGPT extension. Do not assign “1.0” or another release number before assessing the actual compatibility changes.

**Status (2026-10-02):** planning and supporting-document reconciliation complete. Baseline integrated on `codex/self-hosted-adoption-baseline` (`save_context` rename in `dde9099`, backup/archive/restore in `d54ca20`), followed by review and fast-forward of upstream documentation through `82cb302`. Local verification and distribution checks are established; see the [baseline evidence](docs/operations/2026-10-01-adoption-baseline.md). All 19 cards are posted with verified dependencies: 18 in backlog and DISTRIBUTE review-blocked automatically by the control plane. No ready/claimed work was created. Card 66 is now merged and deployed; see the [rollout evidence](docs/operations/2026-10-03-card66-rollout.md). Product milestones B–F remain unimplemented.

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
- The branch passes **117 tests, the TypeScript build, and operator script typechecks** (verified 2026-10-02).
- Six MCP tools exist locally: save, search, fetch, list, deprecate, and consolidate. Profiles expose subsets.
- Existing capabilities include provenance, temporal fields, image normalization, duplicate-write protection, paginated listing, audit events, and retrieval evaluation.
- The `save_context` rename is committed (`dde9099`, card 66). The nine deployed profiles and admin endpoint passed live checks on 2026-10-03 UTC; card 66 is done.
- Production Secret Manager migration is documented as complete. Credential rotation was explicitly excluded and is not unfinished work.
- Backup/restore work from `worktree-memory-archive-task1` at `932f730` is integrated in `d54ca20`; cards 58–65 retain historical QA/recovery evidence. Recursive discovery, content fidelity, and safe recovery hardening remain RECOVERY work.
- Additional evaluation work exists in a separate worktree. Preserve it and respect its recorded publication restrictions.
- QA env files remain local and are covered by `functions/.env.*`; personal settings and study data are excluded from the Journey distribution allowlist.

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
| Queue behavior | Request backlog for every new card. The board automatically review-blocks outward-facing publication (DISTRIBUTE #84); preserve that safeguard. Do not activate workers. |

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

The initial checkout was preserved and the rename/backup work integrated. Accept that baseline and card 66’s completed rollout evidence, and retain applicable verification work from existing branches/worktrees. Establish a reviewable baseline without discarding unique commits or assuming old deployment evidence proves current production state.

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

Use the version-neutral initiative **MetaCortex self-hosted adoption**. Planning keys map to the allocated control-plane cards below (verified 2026-10-02). Card IDs are included for exact dependency reconciliation.

| Key | Card | Depends on | Completion evidence | Control-plane ID |
|---|---|---|---|---|
| DOC | #67 — Reconcile documentation into the canonical roadmap | — | Every source item has a disposition; maintained docs agree on scope, status, and policies. | `T2EoPAt0Th96kNj5nhFx` |
| BASE | #68 — Reconcile current changes and existing worktrees/cards | DOC | Preserved work inventory, integrated baseline, and card 66 disposition. | `uRU4R3U15UGW72tIchVZ` |
| VERIFY | #69 — Establish verification contract and CI | BASE | Backend and added-package checks run from a clean checkout; real gate definitions match commands. | `Fd8VtMHnOZ4oSP5iK3Lt` |
| CORE | #70 — Close memory/lifecycle correctness gaps | VERIFY | Regression tests for filtering, pagination, deduplication, supersession, races, and partial failures. | `otSzeNLBhbOCttYrn2cs` |
| RECOVERY | #71 — Integrate and verify existing backup/restore work | BASE, VERIFY | Inventory and content-fidelity restore evidence, including unknown collections/subcollections. | `BtDrMG2sJxfD81ocpiAi` |
| ACCESS | #72 — Implement owner identity, grants, and OAuth | CORE | Owner binding, protocol tests, revocation, authorization boundaries, and client authentication evidence. | `N5EO6Qbc95xS6VYrpul6` |
| LIMITS | #73 — Add usage controls and audit/privacy enforcement | ACCESS | Concurrent limit tests, redaction checks, configurable policies, and useful failure responses. | `7KvyBlTRK1uumpF3qQH1` |
| MANAGE | #74 — Implement owner management and maintenance operations | CORE, RECOVERY, ACCESS | Retry-safe APIs/jobs, opt-in bounded maintenance, owner-only corrections, and no permanent deletion surface. | `EMRnH6rMKLXNxbYaYeLw` |
| DEPLOY | #75 — Generalize deployment and provisioning | VERIFY, ACCESS, LIMITS | Fresh/repeated/interrupted provisioning tests and explicit-target protections. | `BLSsnfQGLAr1lj6KuHxr` |
| SETUP | #76 — Build Cloud Shell browser wizard | DEPLOY | Browser-led setup with billing/consent handoffs, resume, diagnostics, and first-memory verification. | `XfcvYQa1P5fDL8NsZ2tv` |
| WEB | #77 — Build memory browser and owner dashboard | MANAGE, LIMITS | Authenticated management flows, accessibility, failure states, and permission tests. | `LaWUbhG4JtfrglwWJUhk` |
| CLIENTS | #78 — Package and verify core agent integrations | ACCESS, DEPLOY | Dated ChatGPT/Claude/Codex/generic MCP round-trip results and accurate recipes. | `64lBCl4zrFJAmx0yvF0P` |
| CHATGPT | #79 — Build the self-hosted ChatGPT extension | WEB, CLIENTS | Sidebar/panel browsing, host-bridge authorization, and owner-dashboard handoff. | `7cZ1lUoLrRQkuGpXyyQC` |
| UPGRADE | #80 — Implement upgrade, migration, and recovery journeys | RECOVERY, SETUP, WEB | Existing-install upgrade, rollback, data-preserving uninstall, and recovery rehearsal. | `sCWpf3Urv1C8vkvvpL0a` |
| AUTH-CUTOVER | #81 — Complete legacy URL-token migration and removal | CLIENTS, UPGRADE | Known affected clients verified on replacement auth; breaking-release notes and removal tests. | `eJVcaCPKjrDdnHezEug0` |
| ACCEPT | #82 — Run security and adoption acceptance | CHATGPT, UPGRADE, AUTH-CUTOVER | Client/OS matrix, adversarial tests, and independent owner trials pass. | `9GmfwCF1hzPrxirPNWxY` |
| DISTRIBUTE | #84 — Publish the self-hosting improvements | ACCEPT | Verified release artifacts and successful installation from a clean public download. | `HnKmrS8PvxAzK8DosFuY` |
| OPERATE | #85 — Establish ongoing maintenance and support | DISTRIBUTE | Assigned ownership, triage process, model/dependency checks, and recovery-drill instructions. | `TRP5miRDvjvCQSSprKMH` |
| TIERING | #83 — Evaluate context tiering and broader retrieval experiments | VERIFY; deferred | Hypothesis, frozen baseline, quality/cost comparison, and explicit go/no-go result. | `1GnYHvNzhytdu9SmxDwj` |

### Posting rules

- Check the live board for matching work before creation.
- Reference existing cards 58–65 and 66 instead of duplicating their original deliverables.
- Create every new card directly in `backlog` using the board API. Do not use an API that briefly makes cards runnable.
- Use stable `[MC-ADOPTION/<key>]` markers for deduplication and retry recovery.
- Resolve dependencies to returned card IDs.
- Include concrete goals, exclusions, acceptance criteria, evidence requirements, and applicable verified gates in every card.
- Use `software` cards for implementation and `task` cards for reconciliation, external acceptance, publication, and operational handoff.
- Preserve unrelated queue ordering. Leave placement unspecified unless a verified gate requires it.
- Read the board back to verify backlog state (or mandatory policy review block), dependencies, gate references, and duplicate absence.
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

## 6. Reconciliation record

### 2026-10-02

| Item | Disposition |
|---|---|
| `docs/ARCHITECTURE.md`, `SECURITY.md`, `DEPLOYMENT.md`, `OPENCLAW_MEMORY_OPS.md`, `MAINTENANCE_AGENT_SPEC.md`, `FULL_BACKUP.md`, `MEMORY_ARCHIVE.md` | Retained. Already aligned with six tools, three-tool ordinary default, Secret Manager, and correction-authority limits (`d54ca20`). |
| `README.md` | Retained. States six tools and legacy URL-token status. |
| `CLAUDE.md`, `AGENTS.md` | Corrected tool count to six. |
| `journey-kit/` (`kit.md`, `README.md`, `examples/browser-client-setup.md`) | Corrected. Secrets moved from `.env.prod` to Secret Manager, tokenized ChatGPT URL no longer the recommended path, "secure" and "one-click" claims removed, model name matched to code default. Kit version number not changed. |
| `docs/superpowers/` plan and spec | Retained as dated records. |
| `docs/operations/2026-09-09-secret-migration.md` | Retained as historical evidence. |
| `slides.html` | Corrected. Removed $0 cost, infinite-scaling, near-zero-latency, one-click, "secure", daily-cron, and unverified native-client claims. Tool count now six. Deletion wording now matches soft-deprecation. |
| `studies/ci-recurrence/` | Retained. Unrelated CI-failure study data with no MetaCortex claims. |


### Disposition of the prior strategic plan

The strategic plan at `08d144f:metacortexplan.md` is preserved in Git. Its substantive items map as follows:

| Prior item | Disposition and current evidence |
|---|---|
| Durable user memory; exclude connectors/document indexing | Retained. Archive import and the owner-requested ChatGPT UI are explicit additions; conversation harvesting remains excluded. |
| TTL hardening for events and fingerprints | Implemented fields and operator scripts retained. Historical deployment evidence is not a fresh production check; retention/privacy and portable provisioning map to LIMITS/DEPLOY. |
| Search payload redundancy; fetch full content | Implemented summary-only search and fetch retained. Semantic generated summaries remain deferred TIERING work. |
| Model-default validation | Stable multimodal default and validation script retained. Live model checks belong to deployment/OPERATE; no current availability claim. |
| Context tiers L0/L1/L2 | Deferred to TIERING, with frozen evaluation baseline and an explicit go/no-go. Not a release dependency. |
| Temporal validity, changed/corrected semantics | Existing metadata, filtering, and supersession retained. Concurrent/partial-failure correctness and historical-query gaps map to CORE. |
| Memory/action provenance and legacy backfill | Existing provenance fields, filters, events, and backfill retained. Trusted attribution and correction authority map to ACCESS/MANAGE. |
| User-only correction through an MCP prompt | Prompt retained as guidance. The old structural-enforcement claim is superseded: self-reported initiator is not authorization. Enforce owner authority under ACCESS/MANAGE. |
| Audit fixes: token/config names, function name, auth realm, service name | Completed fixes retained. Remaining stale repository guidance corrected under DOC. |
| Streamable HTTP, JSON responses, removed store/queue tools, hidden retrieval_text, fetch-ID compatibility | Completed contract retained. Card 66 changes the unified write name to save_context without restoring removed aliases. |
| Competitive matrix and reliability claims about other products | Removed from the active roadmap as unsupported and unnecessary for self-hosted acceptance. Historical text remains in Git. |
| Old scouting suggestions to prune/discard/publish work | Superseded by the preservation inventory and per-card evidence in the baseline record. No age-based deletion or publication. |

The prior NEXT-STEPS material was not tracked at release commit `08d144f`; its current replacement is a dated view of this roadmap. Dated archive designs retain their historical role. Screenshots and presentation assets are explanatory material, not release acceptance evidence.

### Board reconciliation, 2026-10-02

Created 19 unique `[MC-ADOPTION/<key>]` cards. DOC #67 through ACCEPT #82 and TIERING #83 are backlog, as is OPERATE #85. DISTRIBUTE #84 was created with a backlog request and the `outward_facing` flag; the control plane immediately set it to `blocked` with a pending review escalation. This is the sole queue-state exception, preserving the required publication safeguard. All dependency IDs and software gate IDs were read back and verified. No worker activation or queue reordering occurred; the board has zero ready and zero claimed cards.

DOC/BASE/VERIFY retain delivered local evidence and remaining review/CI/deployment distinctions. They are not requests to redo completed integration. Existing cards 58–65 and 66 were not duplicated. Software cards reference `metacortex_typecheck`, `metacortex_test`, and `metacortex_package`; future packages must add feature-specific gates. TIERING remains deferred and does not block launch.

### 2026-10-03 UTC execution update

Card 66 landed through PR #12 and is done: production revision `metacortexmcp-00030-zaj`, profile secret version 2, nine scoped clients and admin verified. The [rollout record](docs/operations/2026-10-03-card66-rollout.md) distinguishes endpoint checks from long-running client catalog refreshes. Baseline `9c3feac` is pushed and its hosted typecheck/test/package gates passed. The earlier local-only and undeployed statements in dated records describe the state before this rollout.

The release integration includes the intended roadmap, archive/backup code, verification contract and packaging corrections. Unrelated study data and personal settings remain preserved on `codex/self-hosted-adoption-baseline`; they are not part of the release integration or Journey package. DOC/BASE/VERIFY acceptance precedes CORE #70; remaining cards stay queued until selected.
