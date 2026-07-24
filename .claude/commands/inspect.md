---
name: inspect
description: Launch the production MetaCortex MCP Inspector
---

Launch the production Model Context Protocol (MCP) Inspector.

1. Ensure functions/.env.prod exists and contains FUNCTION_BASE_URL and MCP_ADMIN_TOKEN.
2. Launch the inspector using the command:
   npm --prefix functions run inspect:prod
3. If the command fails due to port conflicts (such as port 6277 or 6274 already in use), run it with alternative ports, for example:
   CLIENT_PORT=6400 SERVER_PORT=6401 npm --prefix functions run inspect:prod
4. Display the inspector URL and authentication token to the user.
