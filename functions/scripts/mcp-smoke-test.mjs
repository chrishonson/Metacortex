import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.resolve(scriptDir, "..");
const explicitEnvKeys = new Set(Object.keys(process.env));
const loadedEnv = {};

for (const fileName of [".env", ".env.prod"]) {
  loadEnvFile(path.join(functionsDir, fileName), loadedEnv);
}

for (const [key, value] of Object.entries(loadedEnv)) {
  if (!explicitEnvKeys.has(key)) {
    process.env[key] = value;
  }
}

const args = process.argv.slice(2);

function readArg(name, fallback) {
  const index = args.findIndex(arg => arg === `--${name}`);
  if (index === -1) {
    return fallback;
  }

  return args[index + 1] ?? fallback;
}

const url = readArg("url", process.env.MCP_BASE_URL);
const clientId = readArg("client-id", process.env.MCP_CLIENT_ID);
const token = readArg(
  "token",
  resolveProfileToken(clientId) ??
    process.env.MCP_ADMIN_TOKEN ??
    process.env.MCP_AUTH_TOKEN
);
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
const branchState = readArg(
  "branch-state",
  process.env.MCP_BRANCH_STATE ?? "active"
);
const imageFile = readArg("image-file", process.env.MCP_IMAGE_FILE);
const imageBase64 = imageFile
  ? fs.readFileSync(path.resolve(imageFile)).toString("base64")
  : readArg("image-base64", process.env.MCP_IMAGE_BASE64);
const imageMimeType = readArg(
  "image-mime-type",
  process.env.MCP_IMAGE_MIME_TYPE ?? inferMimeType(imageFile)
);
const artifactRef = readArg("artifact-ref", process.env.MCP_ARTIFACT_REF);
const fetchFirst = readArg(
  "fetch-first",
  process.env.MCP_FETCH_FIRST ?? "false"
) === "true";

if (!url) {
  console.error("Missing MCP base URL. Pass --url or set MCP_BASE_URL.");
  process.exit(1);
}

if (!token) {
  console.error(
    "Missing MCP auth token. Pass --token or set MCP_ADMIN_TOKEN."
  );
  process.exit(1);
}

const client = new Client({
  name: "metacortex-smoke-test",
  version: "0.3.0"
});

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${token}`
    }
  }
});
let rememberedId;

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map(tool => tool.name).sort();
  console.log("Available tools:");
  for (const toolName of toolNames) {
    console.log(`- ${toolName}`);
  }

  if (mode === "admin-read-write" || mode === "read-write") {
    ensureTools(toolNames, ["remember_context", "search_context"]);

    const rememberResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content,
        topic,
        branch_state: branchState,
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
    const rememberText = requireSuccessfulToolResult(rememberResult, "remember_context");
    console.log(rememberText);
    rememberedId = extractRememberedId(rememberText);
  } else if (mode === "browser-read-write") {
    ensureTools(toolNames, ["remember_context", "search_context", "fetch_context"]);

    const rememberResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content,
        topic,
        ...(branchState ? { branch_state: branchState } : {}),
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
    const rememberText = requireSuccessfulToolResult(rememberResult, "remember_context");
    console.log(rememberText);
    rememberedId = extractRememberedId(rememberText);
  } else if (mode === "search-only") {
    ensureTools(toolNames, ["search_context"]);
  } else {
    throw new Error(`Unsupported smoke mode: ${mode}`);
  }

  const searchResult = await client.callTool({
    name: "search_context",
    arguments: {
      query,
      filter_topic: topic,
      filter_state: "active"
    }
  });

  console.log("\nsearch_context:");
  const searchText = requireSuccessfulToolResult(searchResult, "search_context");
  console.log(searchText);

  if (mode === "browser-read-write" || fetchFirst) {
    ensureTools(toolNames, ["fetch_context"]);
    const memoryId = rememberedId ?? extractMemoryId(searchText);

    if (!memoryId) {
      throw new Error(
        "fetch-first expected remember_context or search_context to return an id"
      );
    }

    const fetchResult = await client.callTool({
      name: "fetch_context",
      arguments: {
        id: memoryId
      }
    });

    console.log("\nfetch_context:");
    console.log(requireSuccessfulToolResult(fetchResult, "fetch_context"));
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

function requireSuccessfulToolResult(result, toolName) {
  const text = textContent(result);

  if (result.isError) {
    throw new Error(`${toolName} returned MCP error: ${text}`);
  }

  const payload = JSON.parse(text);

  if (payload.error) {
    throw new Error(`${toolName} returned error payload: ${text}`);
  }

  return text;
}

function extractMemoryId(searchText) {
  const payload = JSON.parse(searchText);
  return payload.matches?.[0]?.id;
}

function extractRememberedId(rememberText) {
  const payload = JSON.parse(rememberText);
  return payload.item?.id;
}

function loadEnvFile(filePath, target) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    target[key] = value;
  }
}

function resolveProfileToken(profileId) {
  if (!profileId) {
    return undefined;
  }

  const rawProfiles = process.env.MCP_CLIENT_PROFILES_JSON;

  if (!rawProfiles) {
    return undefined;
  }

  const profiles = JSON.parse(rawProfiles);

  if (!Array.isArray(profiles)) {
    return undefined;
  }

  const profile = profiles.find(
    candidate =>
      candidate &&
      typeof candidate === "object" &&
      candidate.id === profileId
  );

  return typeof profile?.token === "string" ? profile.token : undefined;
}

function inferMimeType(filePath) {
  if (!filePath) {
    return undefined;
  }

  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  return undefined;
}
