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
const mode = readArg(
  "mode",
  process.env.MCP_SMOKE_MODE ?? "admin-read-write"
);
const content = readArg(
  "content",
  "We are using Ktor for the Android/iOS networking layer in the main branch."
);
const query = readArg(
  "query",
  "networking layer for Android and iOS"
);
const topic = readArg("topic", process.env.MCP_TOPIC ?? "kmp-networking");
const imageBase64 = readArg("image-base64", process.env.MCP_IMAGE_BASE64);
const imageMimeType = readArg(
  "image-mime-type",
  process.env.MCP_IMAGE_MIME_TYPE
);
const artifactRef = readArg("artifact-ref", process.env.MCP_ARTIFACT_REF);

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
  const toolNames = tools.tools.map(tool => tool.name).sort();
  console.log("Available tools:");
  for (const toolName of toolNames) {
    console.log(`- ${toolName}`);
  }

  if (mode === "admin-read-write" || mode === "read-write") {
    ensureTools(toolNames, ["store_context", "search_context"]);

    const storeResult = await client.callTool({
      name: "store_context",
      arguments: {
        content,
        artifact_type: "DECISION",
        module_name: topic,
        branch_state: "active",
        ...(artifactRef
          ? {
              artifact_refs: [artifactRef]
            }
          : {}),
        ...(imageBase64
          ? {
              image_base64: imageBase64,
              image_mime_type: imageMimeType ?? "image/png"
            }
          : {})
      }
    });

    console.log("\nstore_context:");
    console.log(textContent(storeResult));
  } else if (mode === "browser-read-write") {
    ensureTools(toolNames, ["remember_context", "search_context", "fetch_context"]);

    const rememberResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content,
        topic,
        ...(artifactRef
          ? {
              artifact_refs: [artifactRef]
            }
          : {}),
        ...(imageBase64
          ? {
              image_base64: imageBase64,
              image_mime_type: imageMimeType ?? "image/png"
            }
          : {})
      }
    });

    console.log("\nremember_context:");
    console.log(textContent(rememberResult));
  } else if (mode === "search-only") {
    ensureTools(toolNames, ["search_context"]);

    if (toolNames.includes("store_context")) {
      throw new Error("search-only mode expected store_context to be unavailable");
    }
  } else {
    throw new Error(`Unsupported smoke mode: ${mode}`);
  }

  const searchResult = await client.callTool({
    name: "search_context",
    arguments: {
      query,
      filter_module: topic,
      filter_state: "active"
    }
  });

  console.log("\nsearch_context:");
  const searchText = textContent(searchResult);
  console.log(searchText);

  if (mode === "browser-read-write") {
    const documentId = extractDocumentId(searchText);

    if (!documentId) {
      throw new Error(
        "browser-read-write mode expected search_context to return a document id"
      );
    }

    const fetchResult = await client.callTool({
      name: "fetch_context",
      arguments: {
        document_id: documentId
      }
    });

    console.log("\nfetch_context:");
    console.log(textContent(fetchResult));
  }
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

function ensureTools(toolNames, required) {
  for (const toolName of required) {
    if (!toolNames.includes(toolName)) {
      throw new Error(`Expected tool ${toolName} to be available`);
    }
  }
}

function extractDocumentId(searchText) {
  const match = searchText.match(/^id=([^\s]+)$/m);
  return match?.[1];
}
