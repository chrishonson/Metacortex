import request from "supertest";
import { describe, expect, it } from "vitest";

import { createMetaCortexApp } from "../src/app.js";
import { MissingConfigurationError } from "../src/config.js";
import { createTestRuntime } from "./support/fakes.js";

describe("createMetaCortexApp", () => {
  it("exposes a public health endpoint", async () => {
    const runtime = createTestRuntime();
    const app = createMetaCortexApp({
      getConfig: () => runtime.config,
      getObserver: () => runtime.observer,
      getRuntime: () => runtime
    });

    const response = await request(app).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it("rejects unauthorized MCP requests and records a request event", async () => {
    const runtime = createTestRuntime();
    const app = createMetaCortexApp({
      getConfig: () => runtime.config,
      getObserver: () => runtime.observer,
      getRuntime: () => runtime
    });

    const response = await request(app).post("/mcp").send({
      jsonrpc: "2.0",
      id: 1,
      method: "ping"
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Unauthorized");
    expect(runtime.observer.listEvents()).toContainEqual(
      expect.objectContaining({
        event_type: "request",
        client_id: "default",
        status: "rejected",
        status_code: 401,
        reason: "unauthorized"
      })
    );
  });

  it("surfaces configuration failures as 500s", async () => {
    const app = createMetaCortexApp({
      getConfig: () => {
        throw new MissingConfigurationError("GEMINI_API_KEY is missing");
      },
      getObserver: () => {
        throw new MissingConfigurationError("should not be called");
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
    const app = createMetaCortexApp({
      getConfig: () => runtime.config,
      getObserver: () => runtime.observer,
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
    expect(runtime.observer.listEvents()).toContainEqual(
      expect.objectContaining({
        event_type: "request",
        client_id: "default",
        status: "rejected",
        status_code: 403,
        reason: "origin_not_allowed"
      })
    );
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
    const app = createMetaCortexApp({
      getConfig: () => runtime.config,
      getObserver: () => runtime.observer,
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
