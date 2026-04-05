# Production Smoke Test Example

The bundled root verifier supports two modes:

```bash
node scripts/verify-journey-kit-install.mjs
```

That always runs local tests and build checks. If `MCP_BASE_URL` and `MCP_ADMIN_TOKEN` are also set, the same command runs deployed smoke verification too.

Validate the deployed admin endpoint first:

```bash
npm --prefix functions run smoke -- \
  --url "https://<FUNCTION_BASE_URL>/mcp" \
  --token "<ADMIN_TOKEN>" \
  --mode admin-read-write
```

Then verify one scoped browser client:

```bash
npm --prefix functions run smoke -- \
  --url "https://<FUNCTION_BASE_URL>/clients/chatgpt-web/mcp" \
  --token "<CHATGPT_TOKEN>" \
  --mode browser-read-write
```

Successful output should list the available tools, show a `remember_context` result when write access is allowed, and return at least one matching item from `search_context`.
