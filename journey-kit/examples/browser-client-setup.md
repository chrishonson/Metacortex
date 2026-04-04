# Browser Client Profile Setup

Use scoped client profiles for browser-hosted assistants instead of registering the admin endpoint directly.

Example `MCP_CLIENT_PROFILES_JSON` value:

```dotenv
MCP_CLIENT_PROFILES_JSON=[{"id":"chatgpt-web","token":"replace-chatgpt-token","allowedTools":["remember_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://chatgpt.com"]},{"id":"claude-web","token":"replace-claude-token","allowedTools":["remember_context","search_context","fetch_context"],"allowedFilterStates":["active"],"allowedOrigins":["https://claude.ai"]}]
```

Register these URLs after deploy:

```text
ChatGPT: https://<FUNCTION_BASE_URL>/clients/chatgpt-web/mcp?auth_token=<CHATGPT_TOKEN>
Claude:  https://<FUNCTION_BASE_URL>/clients/claude-web/mcp
```

ChatGPT should be configured as "No Authentication" because the token is already in the URL. Claude can use bearer auth with the scoped token or fall back to the tokenized URL if the client UI does not support custom headers.
