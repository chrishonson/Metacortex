# Production Smoke Test Example

Validate the deployed admin endpoint first:

```bash
MCP_BASE_URL="https://<FUNCTION_BASE_URL>/mcp" \
MCP_ADMIN_TOKEN="<ADMIN_TOKEN>" \
npm --prefix functions run smoke -- --mode admin-read-write
```

Then verify one scoped browser client:

```bash
MCP_BASE_URL="https://<FUNCTION_BASE_URL>/clients/chatgpt-web/mcp" \
MCP_ADMIN_TOKEN="<CHATGPT_TOKEN>" \
MCP_SMOKE_MODE="browser-read-write" \
npm --prefix functions run smoke
```

Successful output should list the available tools, show a `remember_context` result when write access is allowed, and return at least one matching item from `search_context`.
