import request from "supertest";
import { describe, expect, it } from "vitest";

import { createOpenBrainApp } from "../src/app.js";
import { MissingConfigurationError } from "../src/config.js";
import { createTestRuntime } from "./support/fakes.js";

describe("createOpenBrainApp", () => {
  it("exposes a public health endpoint", async () => {
    const app = createOpenBrainApp({
      getAuthToken: () => "test-token",
      getRuntime: () => createTestRuntime()
    });

    const response = await request(app).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it("rejects unauthorized MCP requests before runtime work continues", async () => {
    const app = createOpenBrainApp({
      getAuthToken: () => "test-token",
      getRuntime: () => createTestRuntime()
    });

    const response = await request(app).post("/mcp").send({
      jsonrpc: "2.0",
      id: 1,
      method: "ping"
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Unauthorized");
  });

  it("surfaces configuration failures as 500s", async () => {
    const app = createOpenBrainApp({
      getAuthToken: () => {
        throw new MissingConfigurationError("GEMINI_API_KEY is missing");
      },
      getRuntime: () => {
        throw new MissingConfigurationError("should not be called");
      }
    });

    const response = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer test-token")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "ping"
      });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("GEMINI_API_KEY");
  });
});
