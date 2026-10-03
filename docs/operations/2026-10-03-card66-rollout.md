# Card 66: save_context rollout

Completed 2026-10-03 UTC after explicit authorization to push, merge, update the existing profiles, deploy, and run live checks.

## Landed source

[PR #12](https://github.com/chrishonson/Metacortex/pull/12) merged into `release` at `ac0b78fd479b4bf0eb5b551acad1efdee7a59498`. Its tree matches focused source `c89c57c58497638ac0cef60ea732ca0834d1c749`: the rename from `dde9099` plus three remaining roadmap references. No compatibility alias was added.

The focused checkout passed 82 tests and the TypeScript build on Node 22. The encompassing adoption baseline `9c3feac` separately passed [all three hosted verification gates](https://github.com/chrishonson/Metacortex/actions/runs/37096977416), including 117 tests and clean Journey installation. The optional Claude review action failed without producing a review; manual diff review completed, and no required merge gate was bypassed.

## Deployment

- Project/function: `my-brain-88870`, `us-central1/metaCortexMcp`.
- Previous revision: `metacortexmcp-00029-max`.
- Verified ACTIVE revision: `metacortexmcp-00030-zaj`.
- `MCP_CLIENT_PROFILES_JSON` version 2 replaces only the write-tool name in all nine profile allowlists. Tokens, origins, lifecycle grants and other tools are unchanged. Version 1 remains available for deliberate rollback with the old source.
- Admin and Gemini secret bindings remain version 1. No credentials were rotated or written into local files.
- Deployment used an isolated copy of the tested source and the deployed non-secret settings. Model, region, collection and 768-dimensional embedding settings were preserved. No data migration, index change, restore or memory deletion was performed.

## Live acceptance

Each endpoint passed fresh MCP discovery, `save_context`, `search_context`, `fetch_context`, and rejection of `remember_context`:

| Profile | Result |
|---|---|
| chatgpt-web | Passed; configured browser origin checked |
| claude-web | Passed; configured browser origin checked |
| openclaw | Passed |
| antigravity-ide | Passed |
| claude-code-windows | Passed |
| claude-code-mac | Passed |
| gemini-spark | Passed; configured browser origin checked |
| grok-bot | Passed |
| grok | Passed |
| admin | Passed; full six-tool surface |

All ten identical writes resolved to one operational verification memory, `9cGoQNZXzScCkSRTAsNI`, under topic `metacortex-operations-card66`. The first created it; the remaining nine were duplicates. Every endpoint searched and fetched that same record. No private existing memory content was printed.

These checks verify fresh MCP sessions at the configured endpoints. Long-running agents may need to reconnect or refresh their tool catalogs after this breaking rename; the previous name is not an alias. They do not establish the future OAuth or ChatGPT UI acceptance matrix.

Card 66 was released as **done** with merge, gate and deployment evidence. The adoption roadmap continues with foundation acceptance and CORE.
