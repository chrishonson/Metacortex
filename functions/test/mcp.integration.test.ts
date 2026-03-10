import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenBrainApp } from "../src/app.js";
import { createTestRuntime } from "./support/fakes.js";

describe("MCP integration", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop();
      if (close) {
        await close();
      }
    }

    vi.restoreAllMocks();
  });

  it("serves tool calls over streamable HTTP", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const runtime = createTestRuntime();
    const baseUrl = await startServer(
      createOpenBrainApp({
        getAuthToken: () => runtime.config.authToken,
        getRuntime: () => runtime
      }),
      cleanup
    );

    const client = new Client({
      name: "test-client",
      version: "1.0.0"
    });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token"
        }
      }
    });

    cleanup.push(async () => {
      await client.close();
    });

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      "search_context",
      "store_context"
    ]);

    const storeResult = await client.callTool({
      name: "store_context",
      arguments: {
        content:
          "We are using Ktor for the Android/iOS networking layer in the main branch.",
        artifact_type: "DECISION",
        module_name: "kmp-networking",
        branch_state: "active"
      }
    });

    expect(textContent(storeResult)).toContain("Stored memory vector");

    const searchResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "networking layer for Android and iOS",
        filter_module: "kmp-networking"
      }
    });

    expect(textContent(searchResult)).toContain("Ktor");
    expect(textContent(searchResult)).toContain("kmp-networking");
  });

  it("serves the legacy SSE transport", async () => {
    const runtime = createTestRuntime();
    const baseUrl = await startServer(
      createOpenBrainApp({
        getAuthToken: () => runtime.config.authToken,
        getRuntime: () => runtime
      }),
      cleanup
    );

    const client = new Client({
      name: "test-sse-client",
      version: "1.0.0"
    });
    const transport = new SSEClientTransport(new URL(`${baseUrl}/mcp/sse`), {
      eventSourceInit: {
        fetch: globalThis.fetch,
        headers: {
          Authorization: "Bearer test-token"
        }
      },
      requestInit: {
        headers: {
          Authorization: "Bearer test-token"
        }
      }
    });

    cleanup.push(async () => {
      await client.close();
    });

    await client.connect(transport);

    await client.callTool({
      name: "store_context",
      arguments: {
        content: "Jetpack Compose is our UI framework for Android.",
        artifact_type: "PATTERN",
        module_name: "jetpack-compose-ui",
        branch_state: "active"
      }
    });

    const searchResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "android ui pattern",
        filter_state: "active"
      }
    });

    expect(textContent(searchResult)).toContain("Jetpack Compose");
  });
});

async function startServer(
  app: express.Express,
  cleanup: Array<() => Promise<void>>
): Promise<string> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  cleanup.push(async () => {
    await closeServer(server);
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return result.content
    .filter(item => item.type === "text")
    .map(item => item.text)
    .join("\n");
}
