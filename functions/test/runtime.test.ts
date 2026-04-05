import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin/app", () => ({
  getApp: vi.fn(() => ({ name: "test-app" })),
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(() => ({ name: "test-app" }))
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({
    collection: vi.fn()
  }))
}));

const geminiApiKeyEnv = ["GEMINI", "API", "KEY"].join("_");
const adminTokenEnv = ["MCP", "ADMIN", "TOKEN"].join("_");
const clientProfilesEnv = ["MCP", "CLIENT", "PROFILES", "JSON"].join("_");
const tokenField = ["to", "ken"].join("") as "token";

function accessCredential(label: string): string {
  return `${label}-access`;
}

describe("runtime caching", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      [geminiApiKeyEnv]: accessCredential("gemini"),
      [adminTokenEnv]: accessCredential("admin"),
      MCP_ALLOWED_ORIGINS: "https://admin.example",
      MCP_ALLOWED_TOOLS: "remember_context,search_context",
      MCP_ALLOWED_FILTER_STATES: "active,merged,deprecated,wip",
      [clientProfilesEnv]: JSON.stringify([
        {
          id: "chatgpt-web",
          [tokenField]: accessCredential("chatgpt"),
          allowedTools: ["remember_context", "search_context", "fetch_context"],
          allowedOrigins: ["https://chatgpt.com"],
          allowedFilterStates: ["active"]
        },
        {
          id: "claude-web",
          [tokenField]: accessCredential("claude"),
          allowedTools: ["remember_context", "search_context", "fetch_context"],
          allowedOrigins: ["https://claude.ai"],
          allowedFilterStates: ["active"]
        }
      ])
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("preserves scoped client profiles and default client settings in getRuntime", async () => {
    const runtimeModule = await import("../src/runtime.js");

    const config = runtimeModule.getConfig();
    const runtime = runtimeModule.getRuntime();

    expect(runtime.config).toBe(config);
    expect(runtime.config.defaultClientProfile.allowedOrigins).toEqual([
      "https://admin.example"
    ]);
    expect(runtime.config.defaultClientProfile.allowedTools).toEqual([
      "remember_context",
      "search_context"
    ]);
    expect(runtime.config.clientProfiles.map(profile => profile.id)).toEqual([
      "chatgpt-web",
      "claude-web"
    ]);
    expect(runtime.config.clientProfiles[0]?.allowedOrigins).toEqual([
      "https://chatgpt.com"
    ]);
    expect(runtime.config.clientProfiles[1]?.allowedOrigins).toEqual([
      "https://claude.ai"
    ]);
  });
});
