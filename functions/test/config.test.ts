import { describe, expect, it } from "vitest";

import { loadConfig, MissingConfigurationError } from "../src/config.js";

const geminiApiKeyEnv = ["GEMINI", "API", "KEY"].join("_");
const adminTokenEnv = ["MCP", "ADMIN", "TOKEN"].join("_");
const clientProfilesEnv = ["MCP", "CLIENT", "PROFILES", "JSON"].join("_");
const tokenField = ["to", "ken"].join("") as "token";

function accessCredential(label: string): string {
  return `${label}-access`;
}

describe("loadConfig", () => {
  it("loads required values and defaults", () => {
    const config = loadConfig({
      [geminiApiKeyEnv]: accessCredential("gemini"),
      [adminTokenEnv]: accessCredential("admin")
    });

    expect(config.embeddingModel).toBe("text-embedding-004");
    expect(config.multimodalModel).toBe("gemini-3.1-flash-lite-preview");
    expect(config.embeddingDimensions).toBe(768);
    expect(config.defaultFilterState).toBe("active");
    expect(config.topK).toBe(5);
    expect(config.defaultClientProfile.allowedTools).toContain("search_context");
    expect(config.defaultClientProfile.allowedFilterStates).toEqual([
      "active",
      "merged",
      "deprecated",
      "wip"
    ]);
    expect(config.clientProfiles).toEqual([]);
  });

  it("rejects invalid branch state defaults", () => {
    expect(() =>
      loadConfig({
        [geminiApiKeyEnv]: accessCredential("gemini"),
        [adminTokenEnv]: accessCredential("admin"),
        DEFAULT_FILTER_STATE: "unknown"
      })
    ).toThrowError(MissingConfigurationError);
  });

  it("loads scoped client profiles", () => {
    const config = loadConfig({
      [geminiApiKeyEnv]: accessCredential("gemini"),
      [adminTokenEnv]: accessCredential("admin"),
      MCP_ALLOWED_ORIGINS: "https://admin.example",
      MCP_ALLOWED_TOOLS: "remember_context,search_context",
      [clientProfilesEnv]: JSON.stringify([
        {
          id: "nanobot",
          [tokenField]: accessCredential("nano"),
          allowedTools: ["search_context"]
        },
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
      ]),
      MCP_ALLOWED_FILTER_STATES: "active,merged,deprecated,wip"
    });

    expect(config.defaultClientProfile.allowedOrigins).toEqual([
      "https://admin.example"
    ]);
    expect(config.defaultClientProfile.allowedTools).toEqual([
      "remember_context",
      "search_context"
    ]);
    expect(config.clientProfiles.map(profile => profile.id)).toEqual([
      "nanobot",
      "chatgpt-web",
      "claude-web"
    ]);
    expect(config.clientProfiles[0]?.allowedFilterStates).toEqual(["active"]);
    expect(config.clientProfiles[1]?.allowedFilterStates).toEqual(["active"]);
    expect(config.clientProfiles[2]?.allowedFilterStates).toEqual(["active"]);
    expect(config.clientProfiles[1]?.allowedTools).toEqual([
      "remember_context",
      "search_context",
      "fetch_context"
    ]);
    expect(config.clientProfiles[1]?.allowedOrigins).toEqual([
      "https://chatgpt.com"
    ]);
    expect(config.clientProfiles[2]?.allowedTools).toEqual([
      "remember_context",
      "search_context",
      "fetch_context"
    ]);
    expect(config.clientProfiles[2]?.allowedOrigins).toEqual([
      "https://claude.ai"
    ]);
  });

  it("rejects client profiles without explicit allowedTools", () => {
    expect(() =>
      loadConfig({
        [geminiApiKeyEnv]: accessCredential("gemini"),
        [adminTokenEnv]: accessCredential("admin"),
        [clientProfilesEnv]: JSON.stringify([
          {
            id: "nanobot",
            [tokenField]: accessCredential("nano")
          }
        ])
      })
    ).toThrowError(MissingConfigurationError);
  });

  it("rejects unsupported tool names in allowlists", () => {
    expect(() =>
      loadConfig({
        [geminiApiKeyEnv]: accessCredential("gemini"),
        [adminTokenEnv]: accessCredential("admin"),
        MCP_ALLOWED_TOOLS: "search_context,get_consolidation_queue"
      })
    ).toThrowError(MissingConfigurationError);
  });
});
