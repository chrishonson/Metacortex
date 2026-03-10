import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);

function readArg(name, fallback) {
  const index = args.findIndex(arg => arg === `--${name}`);
  if (index === -1) {
    return fallback;
  }

  return args[index + 1] ?? fallback;
}

const url = readArg("url", process.env.MCP_BASE_URL);
const token = readArg("token", process.env.MCP_AUTH_TOKEN);
const query = readArg(
  "query",
  "networking layer for Android and iOS"
);

if (!url) {
  console.error("Missing MCP base URL. Pass --url or set MCP_BASE_URL.");
  process.exit(1);
}

if (!token) {
  console.error("Missing MCP auth token. Pass --token or set MCP_AUTH_TOKEN.");
  process.exit(1);
}

const client = new Client({
  name: "firebase-open-brain-smoke-test",
  version: "0.1.0"
});

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${token}`
    }
  }
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("Available tools:");
  for (const tool of tools.tools) {
    console.log(`- ${tool.name}`);
  }

  const storeResult = await client.callTool({
    name: "store_context",
    arguments: {
      content:
        "We are using Ktor for the Android/iOS networking layer in the main branch.",
      artifact_type: "DECISION",
      module_name: "kmp-networking",
      branch_state: "active"
    }
  });

  console.log("\nstore_context:");
  console.log(textContent(storeResult));

  const searchResult = await client.callTool({
    name: "search_context",
    arguments: {
      query,
      filter_module: "kmp-networking",
      filter_state: "active"
    }
  });

  console.log("\nsearch_context:");
  console.log(textContent(searchResult));
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
}

function textContent(result) {
  return result.content
    .filter(item => item.type === "text")
    .map(item => item.text)
    .join("\n");
}
