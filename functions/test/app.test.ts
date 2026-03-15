import request from "supertest";
import { describe, expect, it } from "vitest";

import { createOpenBrainApp } from "../src/app.js";
import { MissingConfigurationError } from "../src/config.js";
import { createTestRuntime } from "./support/fakes.js";

describe("createOpenBrainApp", () => {
  it("exposes a public health endpoint", async () => {
    const runtime = createTestRuntime();
    const app = createOpenBrainApp({
      getConfig: () => runtime.config,
      getRuntime: () => runtime
    });

    const response = await request(app).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it("rejects unauthorized MCP requests before runtime work continues", async () => {
    const runtime = createTestRuntime();
    const app = createOpenBrainApp({
      getConfig: () => runtime.config,
      getRuntime: () => runtime
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
      getConfig: () => {
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

    expect(response.status).toBe(503);
    expect(response.body.error).toBe("Service unavailable");
    expect(response.body.requestId).toEqual(expect.any(String));
  });

  it("blocks browser origins that are not allowlisted", async () => {
    const runtime = createTestRuntime();
    const app = createOpenBrainApp({
      getConfig: () => runtime.config,
      getRuntime: () => runtime
    });

    const response = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer test-token")
      .set("Origin", "https://evil.example")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "ping"
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Origin not allowed");
  });

  it("allows preflight for explicitly allowlisted browser clients", async () => {
    const runtime = createTestRuntime({
      clientProfiles: [
        {
          id: "claude-web",
          authToken: "claude-token",
          allowedOrigins: ["https://claude.ai"],
          allowedTools: ["search_context"],
          allowedFilterStates: ["active"]
        }
      ]
    });
    const app = createOpenBrainApp({
      getConfig: () => runtime.config,
      getRuntime: () => runtime
    });

    const response = await request(app)
      .options("/clients/claude-web/mcp")
      .set("Origin", "https://claude.ai");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://claude.ai"
    );
  });
});
