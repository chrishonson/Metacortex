# Self-hosted adoption baseline

Started 2026-10-01; continued 2026-10-02. Scope: reconcile documentation, record the dependency-linked backlog without activation, and establish a reviewed local baseline. The [canonical roadmap](../../metacortexplan.md) governs future implementation.

## Preserved and integrated work

| Evidence | Disposition |
|---|---|
| Released `v0.3.0` and release branch `08d144f` | Existing product retained; no invented 1.0 milestone. |
| Initial tracked working-tree patch | Preserved privately before integration; local QA configuration retained and ignored. |
| `dde9099`, card 66 | Local write contract renamed to `save_context` without an alias. Deployment/profile migration remains unverified. |
| Archive worktree `932f730`, cards 58–65; integration `d54ca20` | Portable archives, dynamic top-level backup, restore, inventory helpers and tests integrated. Historical QA evidence retained. No live restore repeated. |
| Card 62 followed by cards 64–65 | The earlier four-collection backup was superseded by dynamic top-level discovery; neither proves recursive or content-equal recovery. |
| Card 23 and the secret-migration record | Completed Secret Manager migration retained. Credential rotation was explicitly excluded. |
| Evaluation worktree `c3d17d2`, card 45 | Separate work preserved with its publication restrictions. Existing retrieval evaluation remains in the baseline. |
| Partial trace work, card 30 | Historical incomplete work preserved; no new trace feature introduced. |
| Studies and personal settings committed in `d54ca20` | Preserved in Git; excluded from the distributable Journey allowlist. |

## Incoming review before pull

Reviewed the three upstream documentation commits between `d54ca20` and `82cb302`, then fast-forwarded the clean branch. No executable code changed in those incoming commits.

Resolved findings:

- `NEXT-STEPS.md` excluded card posting despite the authorized backlog scope; restored the roadmap's posting rules.
- Journey setup entered secrets before selecting the target and copied credential placeholders into production dotenv. Instructions now select a project first, omit credential keys entirely, and specify the project on secret commands.
- Journey metadata still recommended URL credentials and its README retained the old preview-model default. Aligned both with the current code and documented legacy-auth transition.
- Slides overstated read-state allowlists as restrictions on all memory operations. Clarified the current write-state gap.
- Deployment docs referenced a missing baseline record and script check. Added this record and a runnable check.

## Verification and distribution baseline

`verification.json` and `scripts/run-gate.py` declare and execute the typecheck, test, and package gates. CI uses those gate IDs on Node 22, matching the Functions engine. The script compiler includes operator TypeScript without emitting it into the deployed function.

The new check exposed accesses to an SDK project-ID property absent from its public TypeScript declaration. A checked accessor preserves the target guard and refuses an unverifiable target. Regression coverage checks the installed SDK, production-write refusal, and missing-project refusal without network operations.

The Journey allowlist now includes imported runtime modules, package-referenced scripts, tests, the lockfile, and current operating docs. Its package gate extracts only those files, installs dependencies independently, and runs tests/build/script checks. Live smoke credentials are removed from that check's environment. No artifact is published by verification.

Verified on 2026-10-02:

- 117 tests passed across 10 files, including MCP loopback integration tests and three target-guard regression cases.
- Functions build and operator TypeScript checks passed.
- Independent Journey extraction installed 428 locked packages and passed the same 117 tests, build, and script checks under Node 22.22.2 (69 allowlisted source/document files, two examples). A preliminary local Node 20 run also passed; Node 22 is the supported baseline.
- Maintained-document relative links resolved and `git diff --check` passed.
- Hosted CI, live deployment, model validation, recovery and registry publication were not run.

## Remaining limits

Local tests and packaging checks do not verify production, live models, OAuth/client compatibility, an actual cloud restore, or first-time-owner usability. CI configuration is local until pushed and observed running.

Portable archives preserve known fields and may commit/push when run without protective flags. Full backups discover top-level collections, not subcollections; counts do not prove content equality or snapshot consistency. Write-mode restore can prune and can fail partway through. Existing hardcoded maintainer guards/defaults are not portable installation protections. These remain RECOVERY and DEPLOY work.

All adoption cards were requested in backlog; 18 remain there. DISTRIBUTE #84 is automatically review-blocked by its outward-facing policy flag. No ready/claimed cards exist, and the review safeguard remains intact. Foundation cards record delivered local evidence and remaining acceptance rather than requesting duplicate implementation. Card 66 retains its remaining deployed-client verification; no production claim is inferred from a local rename.

## Board evidence

On 2026-10-02, read back all 19 unique adoption cards (#67–85), their dependency IDs, declared gates, and null leases. Board totals after posting: 84 cards; 24 backlog, 3 blocked, 43 done, 14 abandoned, zero ready/claimed/failed-out. The extra blocked item is publication #84's mandatory review escalation. No existing queue ordering or completed-card states changed.
