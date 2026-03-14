import { describe, expect, it } from "vitest";

import { loadConfig, MissingConfigurationError } from "../src/config.js";

describe("loadConfig", () => {
  it("loads required values and defaults", () => {
    const config = loadConfig({
      GEMINI_API_KEY: "gemini-key",
      MCP_AUTH_TOKEN: "secret-token"
    });

    expect(config.embeddingModel).toBe("text-multimodal-embedding-002");
    expect(config.multimodalModel).toBe("gemini-2.5-flash");
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
    expect(config.maxSseSessions).toBe(25);
  });

  it("rejects invalid branch state defaults", () => {
    expect(() =>
      loadConfig({
        GEMINI_API_KEY: "gemini-key",
        MCP_AUTH_TOKEN: "secret-token",
        DEFAULT_FILTER_STATE: "unknown"
      })
    ).toThrowError(MissingConfigurationError);
  });

  it("loads scoped client profiles", () => {
    const config = loadConfig({
      GEMINI_API_KEY: "gemini-key",
      MCP_AUTH_TOKEN: "admin-token",
      MCP_ALLOWED_ORIGINS: "https://admin.example",
      MCP_ALLOWED_TOOLS: "store_context,search_context",
      MCP_CLIENT_PROFILES_JSON: JSON.stringify([
        {
          id: "nanobot",
          token: "nano-token",
          allowedTools: ["search_context"]
        },
        {
          id: "browser",
          token: "browser-token",
          allowedTools: ["search_context"],
          allowedOrigins: ["https://claude.ai"],
          allowedFilterStates: ["active"]
        }
      ]),
      MAX_SSE_SESSIONS: "8",
      MCP_ALLOWED_FILTER_STATES: "active,merged,deprecated,wip"
    });

    expect(config.defaultClientProfile.allowedOrigins).toEqual([
      "https://admin.example"
    ]);
    expect(config.defaultClientProfile.allowedTools).toEqual([
      "store_context",
      "search_context"
    ]);
    expect(config.clientProfiles.map(profile => profile.id)).toEqual([
      "nanobot",
      "browser"
    ]);
    expect(config.clientProfiles[0]?.allowedFilterStates).toEqual(["active"]);
    expect(config.clientProfiles[1]?.allowedFilterStates).toEqual(["active"]);
    expect(config.maxSseSessions).toBe(8);
  });

  it("rejects client profiles without explicit allowedTools", () => {
    expect(() =>
      loadConfig({
        GEMINI_API_KEY: "gemini-key",
        MCP_AUTH_TOKEN: "admin-token",
        MCP_CLIENT_PROFILES_JSON: JSON.stringify([
          {
            id: "nanobot",
            token: "nano-token"
          }
        ])
      })
    ).toThrowError(MissingConfigurationError);
  });
});
