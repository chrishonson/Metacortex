import { describe, expect, it } from "vitest";

import { loadConfig, MissingConfigurationError } from "../src/config.js";

describe("loadConfig", () => {
  it("loads required values and defaults", () => {
    const config = loadConfig({
      OPENAI_API_KEY: "openai-key",
      MCP_AUTH_TOKEN: "secret-token"
    });

    expect(config.embeddingModel).toBe("text-embedding-3-small");
    expect(config.defaultFilterState).toBe("active");
    expect(config.topK).toBe(5);
  });

  it("rejects invalid branch state defaults", () => {
    expect(() =>
      loadConfig({
        OPENAI_API_KEY: "openai-key",
        MCP_AUTH_TOKEN: "secret-token",
        DEFAULT_FILTER_STATE: "unknown"
      })
    ).toThrowError(MissingConfigurationError);
  });
});
