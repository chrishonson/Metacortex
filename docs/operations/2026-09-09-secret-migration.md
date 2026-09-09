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

## Completed scope

Nick explicitly removed rotation from card-23 on 2026-09-09 UTC ("no rotation").
The completed scope is storage migration with existing credential values
preserved. Credential rotation and client reconfiguration are not outstanding
requirements for this card. No rotation was performed.

Future deployments must retain the secret bindings in this branch. Do not rerun
the original plaintext migration against the already-migrated deployment.
Rollback must not restore ordinary environment variables containing credentials.
