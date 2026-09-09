import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";

import { createMetaCortexApp } from "./app.js";
import { getConfig, getObserver, getRuntime } from "./runtime.js";

const mcpAdminToken = defineSecret("MCP_ADMIN_TOKEN");
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const clientProfiles = defineSecret("MCP_CLIENT_PROFILES_JSON");

export const metaCortexMcp = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
    invoker: "public",
    secrets: [mcpAdminToken, geminiApiKey, clientProfiles]
  },
  createMetaCortexApp({
    getConfig,
    getObserver,
    getRuntime
  })
);
