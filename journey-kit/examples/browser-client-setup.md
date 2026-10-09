# Browser Client Profile Setup

Use scoped client profiles for browser-hosted assistants instead of registering the admin endpoint directly.

Example `MCP_CLIENT_PROFILES_JSON` value:

```json
[{"id":"chatgpt-web","token":"replace-chatgpt-token","allowedTools":["save_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://chatgpt.com"]},{"id":"claude-web","token":"replace-claude-token","allowedTools":["save_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://claude.ai"]}]
```

Store this value as the `MCP_CLIENT_PROFILES_JSON` Secret Manager secret, not in dotenv.

Register these endpoints after deploy, each with its own bearer credential:

```text
ChatGPT: https://<FUNCTION_BASE_URL>/clients/chatgpt-web/mcp
Claude:  https://<FUNCTION_BASE_URL>/clients/claude-web/mcp
```

Use the authentication options the specific client version offers. Current code still accepts `?auth_token=<SCOPED_TOKEN>` for URL-only clients as legacy behavior. The token appears in the URL and may be logged. It will be removed after the OAuth migration. No client compatibility is verified by this example.
