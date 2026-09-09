# Card-23: production secret migration

As of 2026-09-09 UTC, production revision `metacortexmcp-00028-pul` is ACTIVE
and binds version 1 of `MCP_ADMIN_TOKEN`, `GEMINI_API_KEY`, and
`MCP_CLIENT_PROFILES_JSON` from Secret Manager in `my-brain-88870`.
None of those keys remains in `serviceConfig.environmentVariables`.

The existing values were transferred in memory directly to Secret Manager;
no credential bytes were printed or written to a temporary file. The original
checkout's `functions/.env.prod` had the three secret entries removed after
production verification. The isolated deployment used the existing non-secret
production settings, preserving model and collection configuration.

## Verification

- 82 tests passed with coverage; TypeScript build passed.
- Deployment preflight passed, including enabled Secret Manager versions.
- Synthetic preflight check rejected a plaintext dotenv credential without
  printing the synthetic value.
- Authenticated MCP `tools/list` succeeded for admin and all nine scoped clients:
  chatgpt-web, claude-web, openclaw, antigravity-ide, claude-code-windows,
  claude-code-mac, gemini-spark, grok-bot, grok.
- A read-only `search_context` request through the grok client succeeded,
  exercising the injected Gemini key and retrieval path. No memory was created.
- Production function metadata confirmed all three secret references and no
  remaining plaintext secret keys.

## Unfinished: coordinated rotation

This is storage migration, not credential rotation. Existing credentials still
work and are not claimed safe merely because their storage changed. No evidence
of credential misuse was established by this task.

The local `/Users/nick/.claude.json` configuration points to the admin `/mcp`
endpoint. Verified configuration access for browser/remote consumers was not
available in this session. Updating Secret Manager alone would not update these
clients. Before invalidating the nine scoped tokens, obtain access to their
actual configurations or a confirmed owner-operated cutover procedure.

Then rotate the admin token and each scoped client token, store scoped replacements
as `metacortex-client-<id>`, update the consumers, publish the new profile-bundle
version, redeploy and repeat authentication checks. Determine all users of the
existing Gemini API key before revocation; create a replacement with appropriate
API restrictions, cut over MetaCortex, verify embedding search, then retire the
old key once its remaining consumers are accounted for.

Keep card-23 blocked until rotation and consumer cutover are verified. Do not
rerun the original plaintext migration against the already-migrated deployment.
Future deployments must retain the secret bindings in this branch. Rollback
must not restore ordinary environment variables containing credentials.
