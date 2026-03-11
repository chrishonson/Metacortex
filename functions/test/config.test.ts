import { describe, expect, it } from "vitest";

import { loadConfig, MissingConfigurationError } from "../src/config.js";

describe("loadConfig", () => {
  it("loads required values and defaults", () => {
    const config = loadConfig({
      GEMINI_API_KEY: "gemini-key",
      MCP_AUTH_TOKEN: "secret-token"
    });

    expect(config.embeddingModel).toBe("gemini-embedding-001");
    expect(config.multimodalModel).toBe("gemini-2.5-flash");
    expect(config.embeddingDimensions).toBe(768);
    expect(config.defaultFilterState).toBe("active");
    expect(config.topK).toBe(5);
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
});
