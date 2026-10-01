# Deployment and operator playbook

This guide describes the current local baseline, not the planned browser installer. See the [unified roadmap](../metacortexplan.md), [baseline evidence](operations/2026-10-01-adoption-baseline.md), and [security boundaries](SECURITY.md). MetaCortex is already released; no new deployment occurred during baseline reconciliation.

## Current contract

- Firebase Cloud Functions 2nd Gen in `us-central1`, Firestore Native mode, and a billed Firebase project.
- Six server tools, filtered by client profile. Ordinary agents receive save/search/fetch; listing is an explicit grant. Consolidation/deprecation are maintenance operations.
- Streamable HTTP only, on `<FUNCTION_BASE_URL>/mcp` and `<FUNCTION_BASE_URL>/clients/<clientId>/mcp`.
- One shared corpus per installation; topic/profile names do not isolate tenants.
- The local baseline uses `save_context`. Card 66 still requires verification of deployed tool/profile migration; there is no old-name alias.
- Model and collection settings come from the shipped `.env.example` and the operator's chosen deployment configuration. Validate actual model availability before deployment; model names in a template are not a live availability guarantee.

## Prerequisites

From your own checkout, install Node matching `.node-version`, npm, Firebase CLI, and Google Cloud CLI. Java is needed for the Firestore emulator. Authenticate your own Firebase/Google account and select the intended project explicitly.

```bash
node --version
npm --version
firebase --version
gcloud --version
npm --prefix functions ci
firebase login
firebase use --add
```

Do not reuse the maintainer's project identifiers for a new installation. The existing operator preflight and archive tools still contain maintainer assumptions; generalizing them is DEPLOY work. Inspect the target/configuration before running commands.

## Secrets and non-secret configuration

`functions/src/index.ts` binds three runtime secrets: `GEMINI_API_KEY`, `MCP_ADMIN_TOKEN`, and `MCP_CLIENT_PROFILES_JSON`. Production dotenv must not contain them. Store the values in Secret Manager for the chosen project, using Firebase's interactive secret entry rather than command-line secret literals:

```bash
firebase functions:secrets:set GEMINI_API_KEY --project <project-id>
firebase functions:secrets:set MCP_ADMIN_TOKEN --project <project-id>
firebase functions:secrets:set MCP_CLIENT_PROFILES_JSON --project <project-id>
```

Set non-secret model, dimension, collection, service, and origin settings in `functions/.env.<alias>` matching the selected Firebase alias. Consult `functions/.env.example`, but do not copy its credential placeholders into production dotenv. Local development may use ignored `.env`; emulators may use ignored `functions/.secret.local` overrides.

The runtime currently prefers Vertex when a Firebase project ID is available, and falls back to API-key mode otherwise. Configuration still requires `GEMINI_API_KEY`; removing that unnecessary requirement in Vertex mode is planned. Ensure runtime IAM/model access matches the selected route.

Admin CORS defaults to deny browser origins. Set each scoped profile's `allowedOrigins` separately. Example value for the client-profile secret (replace placeholders privately):

```json
[{"id":"chatgpt-web","token":"replace-chatgpt-token","allowedTools":["save_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://chatgpt.com"]},{"id":"claude-web","token":"replace-claude-token","allowedTools":["save_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://claude.ai"]}]
```

Headless agents that do not send Origin can use `allowedOrigins: []`. Grant `list_context` explicitly when required. Read-state allowlists are not write-state restrictions in the current service.

## Local verification

```bash
npm --prefix functions test
npm --prefix functions run build
npm --prefix functions run typecheck:scripts
node scripts/build-journey-kit.mjs --no-write
```

These checks do not prove live Firestore/model behavior. To run emulators, use local dummy credentials and a demo project. The Gemini calls need a deliberate test configuration; do not assume emulators automatically fake the model service.

```bash
firebase emulators:start --only functions,firestore --project demo-open-brain
```

The operator preflight `scripts/deploy-session-preflight.sh` additionally checks current Git/env/index/profile configuration, production secrets, and optional archive age. It is still tailored to the maintainer's production alias/project. A new owner should use the explicit checks above and must not run a maintainer-targeted preflight as if it were portable.

## Deploy an intentional release

1. Verify the target alias, project ID, runtime account permissions, non-secret dotenv, and enabled Secret Manager versions.
2. Validate models with `npm --prefix functions run validate:models` in a deliberately configured operator environment. This contacts a model service and may incur usage.
3. Confirm embedding dimensions match every relevant vector index. Never mix vector spaces; use a separate collection and re-embed for a migration.
4. Inspect backup/recovery evidence before touching an existing installation.
5. Deploy rules/indexes, wait for required indexes to become ready, then deploy the function:

```bash
firebase use <alias>
firebase deploy --project <alias> --only firestore:rules,firestore:indexes
firebase deploy --project <alias> --only functions
```

The Functions predeploy hook builds the source. The alias selects `.env.<alias>`; passing a raw project ID may load a different dotenv file. Always verify effective non-secret settings.

Existing production Secret Manager migration is complete: [card-23 record](operations/2026-09-09-secret-migration.md). Do not repeat the plaintext migration or rotate credentials merely because deployment docs changed.

## TTL and retention

The current code writes Date-valued `expires_at` fields for TTL. Audit/retrieval events target 90 days; write fingerprints target 30 days. Numeric `dedupe_expires_at` separately controls the short duplicate-write window. Firestore TTL must be enabled on each actual collection separately.

Use `functions/scripts/backfill-firestore-ttl.mjs` and `scripts/deploy-firestore-ttl.sh` only after inspecting their target defaults/options. Backfill is not automatically necessary for an already-migrated deployment. TTL applies to operational collections, not a product feature for permanently deleting memories.

## Post-deploy verification

Check `/healthz`, rejected unauthenticated MCP requests, allowed/disallowed browser origins, and MCP initialization/tool discovery for each intended profile. Health alone does not prove model access or retrieval.

Use credentials supplied privately through the environment. Smoke commands may write synthetic memories unless `search-only` is selected:

```bash
npm --prefix functions run smoke -- --mode search-only
npm --prefix functions run smoke -- --mode browser-read-write
```

Set `MCP_BASE_URL` to the exact scoped endpoint and `MCP_ADMIN_TOKEN` to that endpoint's matching credential (the smoke script variable name does not require using the admin account). `admin-read-write` is the default; `read-write` remains an alias. Image tests also accept image input and artifact references.

Verify save → search → fetch returns the same ID, tool discovery matches the profile, and audit events reflect the correct client. Listing needs a profile that explicitly includes it. Current fetches of inaccessible states return neutral not-found behavior.

## Client connections and compatibility

Prefer bearer headers where the client supports them. Use [the client recipe](../journey-kit/examples/browser-client-setup.md) for current static-token configuration. Do not assume a specific client settings UI or OAuth support in this baseline.

Legacy query credentials remain accepted by the current code. They may enter infrastructure URL logs. The planned sequence is: implement replacement auth, disable URL tokens for new installations, migrate/test existing clients, then remove support in a documented breaking release. There is no transition switch implemented yet.

Rotate/revoke a static client today by updating/removing its Secret Manager profile, updating the consumer, and redeploying. Use separate credentials for each client and maintenance boundary. OAuth/grant management in the web UI is future work.

## Backup, restore, and rollback

Use [portable memory archives](MEMORY_ARCHIVE.md) for memory export/re-embedding and [full top-level backup](FULL_BACKUP.md) for as-is vectors and operational collections. Existing inventory checks do not establish recursive, consistent, content-equal recovery. Do not silently strengthen their success claims.

For rollback, retain the previous source revision and compatible non-secret configuration/secret references. Reverting source alone does not undo schema/data changes. Keep the previous credential values unless an explicit migration requires changing them. Never restore plaintext production secrets into dotenv. Rehearse restore into a separate target; replacement/pruning is an explicit operator action.

## Maintainer environments (not installer defaults)

The existing production project is `my-brain-88870` (alias `prod`); the QA project is `metacortex-qa` (alias `qa`). Their existence and prior QA restore outcomes are historical evidence from cards 59–65, not fresh live checks. Current local aliases remain private. Keep QA and production credentials distinct. Do not deploy to either environment during a documentation/baseline task.

## Observability and troubleshooting

`memory_events` records compact tool/ingress outcomes. Optional `retrieval_query_events` contains full queries and retrieval evidence; keep it disabled unless deliberately required. Logs and query previews can contain private material. Audit collection retention does not remove copies in exported archives.

- Search fails: verify index readiness, model availability/access, vector dimensions, and Firestore Native mode.
- Authentication fails: verify endpoint/profile pairing and deployed Secret Manager bindings; do not print credentials.
- Origin denied: inspect the actual Origin and its scoped profile; do not broaden admin access.
- Writes fail: inspect runtime IAM and Firestore/model API access.
- Deployment misconfigured: verify the selected alias and dotenv/secret separation.
- Partial maintenance or recovery: stop and inspect operation/source/target state; do not blindly rerun a destructive command.
