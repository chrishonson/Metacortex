import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.resolve(scriptDir, "..");
const envProdPath = path.join(functionsDir, ".env.prod");

console.log("Reading production environment configuration...");

if (!fs.existsSync(envProdPath)) {
  console.error(`Error: Production environment file not found at: ${envProdPath}`);
  console.error("Please create a valid '.env.prod' file in the functions directory.");
  process.exit(1);
}

const loadedEnv = {};
try {
  const fileContent = fs.readFileSync(envProdPath, "utf8");
  for (const rawLine of fileContent.split(/\r?\n/)) {
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

    loadedEnv[key] = value;
  }
} catch (error) {
  console.error(`Error reading ${envProdPath}:`, error);
  process.exit(1);
}

const baseUrl = loadedEnv.FUNCTION_BASE_URL;
const adminToken = loadedEnv.MCP_ADMIN_TOKEN;

if (!baseUrl) {
  console.error("Error: 'FUNCTION_BASE_URL' not defined in .env.prod");
  process.exit(1);
}

if (!adminToken) {
  console.error("Error: 'MCP_ADMIN_TOKEN' not defined in .env.prod");
  process.exit(1);
}

// Clean and construct URL
const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
const targetUrl = `${cleanBaseUrl}/mcp?auth_token=${adminToken}`;

console.log(`Production URL: ${cleanBaseUrl}/mcp`);
console.log("Launching MCP Inspector...");

const child = spawn("npx", [
  "@modelcontextprotocol/inspector",
  "--transport",
  "http",
  "--server-url",
  targetUrl
], {
  stdio: "inherit",
  shell: true
});

child.on("error", (error) => {
  console.error("Failed to start the MCP Inspector process:", error);
  process.exit(1);
});

child.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.error(`MCP Inspector process exited with code ${code}`);
    process.exit(code);
  }
});
