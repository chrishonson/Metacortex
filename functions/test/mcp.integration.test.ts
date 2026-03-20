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
        getConfig: () => runtime.config,
        getObserver: () => runtime.observer,
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
      "deprecate_context",
      "fetch_context",
      "get_consolidation_queue",
      "remember_context",
      "search_context",
      "store_context"
    ]);

    const storeResult = await client.callTool({
      name: "store_context",
      arguments: {
        content:
          "We are using Ktor for the Android/iOS networking layer in the main branch.",
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

    expect(parseJsonTextContent(searchResult)).toMatchObject({
      matches: [
        {
          id: "memory-1",
          summary: expect.stringContaining("Ktor"),
          metadata: {
            module_name: "kmp-networking",
            branch_state: "active"
          }
        }
      ],
      applied_filters: {
        filter_module: "kmp-networking",
        filter_state: "active"
      }
    });

    // Store a WIP context and verify consolidation queue
    await client.callTool({
      name: "store_context",
      arguments: {
        content: "Draft thoughts on error handling in networking.",
        module_name: "kmp-networking",
        branch_state: "wip"
      }
    });

    const queueResult = await client.callTool({
      name: "get_consolidation_queue",
      arguments: {
        module_name: "kmp-networking"
      }
    });

    expect(textContent(queueResult)).toContain("WIP item");
    expect(textContent(queueResult)).toContain("Draft thoughts on error handling");
  });

  it("serves the legacy SSE transport", async () => {
    const runtime = createTestRuntime();
    const baseUrl = await startServer(
      createOpenBrainApp({
        getConfig: () => runtime.config,
        getObserver: () => runtime.observer,
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
        content: "Jetpack Compose settings screen screenshot.",
        module_name: "jetpack-compose-ui",
        branch_state: "active",
        image_base64: "ZmFrZS1pbWFnZS1ieXRlcw==",
        image_mime_type: "image/png",
        artifact_refs: ["gs://bucket/settings-screen.png"]
      }
    });

    const searchResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "android compose screenshot",
        filter_state: "active"
      }
    });

    expect(parseJsonTextContent(searchResult)).toMatchObject({
      matches: [
        {
          id: "memory-1",
          summary: expect.stringContaining("Jetpack Compose"),
          metadata: {
            modality: "mixed",
            artifact_refs: ["gs://bucket/settings-screen.png"]
          }
        }
      ]
    });
  });

  it("enforces tool scoping on client-specific endpoints", async () => {
    const runtime = createTestRuntime({
      clientProfiles: [
        {
          id: "nanobot",
          authToken: "nano-token",
          allowedOrigins: [],
          allowedTools: ["search_context"],
          allowedFilterStates: ["active"]
        }
      ]
    });

    await runtime.service.storeContext({
      content: "We are using Ktor for the Android/iOS networking layer in the main branch.",
      module_name: "kmp-networking",
      branch_state: "active"
    });

    const baseUrl = await startServer(
      createOpenBrainApp({
        getConfig: () => runtime.config,
        getObserver: () => runtime.observer,
        getRuntime: () => runtime
      }),
      cleanup
    );

    const client = new Client({
      name: "nanobot-client",
      version: "1.0.0"
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/clients/nanobot/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: "Bearer nano-token"
          }
        }
      }
    );

    cleanup.push(async () => {
      await client.close();
    });

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(["search_context"]);

    const searchResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "networking layer for Android and iOS",
        filter_module: "kmp-networking"
      }
    });

    expect(parseJsonTextContent(searchResult)).toMatchObject({
      matches: [
        {
          id: "memory-1",
          summary: expect.stringContaining("Ktor")
        }
      ]
    });
    const disallowedResult = await client.callTool({
      name: "store_context",
      arguments: {
        content: "should fail",
        module_name: "kmp-networking",
        branch_state: "active"
      }
    });

    expect(disallowedResult.isError).toBe(true);
    expect(textContent(disallowedResult)).toContain("Tool store_context not found");

    const disallowedStateResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "old deprecated networking layer",
        filter_module: "kmp-networking",
        filter_state: "deprecated"
      }
    });

    expect(disallowedStateResult.isError).toBe(true);
    expect(textContent(disallowedStateResult)).toContain(
      "filter_state 'deprecated' is not allowed"
    );

    expect(runtime.observer.listEvents().at(-1)).toMatchObject({
      client_id: "nanobot",
      tool_name: "search_context",
      status: "error",
      error: {
        message: "filter_state 'deprecated' is not allowed for this client",
        status_code: 403
      }
    });
  });

  it("supports ChatGPT web remember, search, and fetch flows", async () => {
    const runtime = createTestRuntime({
      clientProfiles: [
        {
          id: "chatgpt-web",
          authToken: "chatgpt-token",
          allowedOrigins: ["https://chatgpt.com"],
          allowedTools: ["remember_context", "search_context", "fetch_context"],
          allowedFilterStates: ["active"]
        }
      ]
    });

    const baseUrl = await startServer(
      createOpenBrainApp({
        getConfig: () => runtime.config,
        getObserver: () => runtime.observer,
        getRuntime: () => runtime
      }),
      cleanup
    );

    const client = new Client({
      name: "chatgpt-client",
      version: "1.0.0"
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/clients/chatgpt-web/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: "Bearer chatgpt-token"
          }
        }
      }
    );

    cleanup.push(async () => {
      await client.close();
    });

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      "fetch_context",
      "remember_context",
      "search_context"
    ]);

    const rememberResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content: "We use Ktor for shared Android and iOS networking.",
        topic: "kmp-networking"
      }
    });

    expect(parseJsonTextContent(rememberResult)).toMatchObject({
      item: {
        id: "memory-1",
        content: "We use Ktor for shared Android and iOS networking.",
        metadata: {
          module_name: "kmp-networking",
          branch_state: "active",
          modality: "text"
        }
      },
      write_status: "created"
    });

    const searchResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "shared networking for android and ios",
        filter_module: "kmp-networking"
      }
    });

    expect(parseJsonTextContent(searchResult)).toMatchObject({
      matches: [
        {
          id: "memory-1",
          metadata: {
            module_name: "kmp-networking",
            branch_state: "active"
          }
        }
      ],
      applied_filters: {
        filter_module: "kmp-networking",
        filter_state: "active"
      }
    });

    const fetchResult = await client.callTool({
      name: "fetch_context",
      arguments: {
        document_id: "memory-1"
      }
    });

    expect(parseJsonTextContent(fetchResult)).toMatchObject({
      item: {
        id: "memory-1",
        content: "We use Ktor for shared Android and iOS networking.",
        retrieval_text: "We use Ktor for shared Android and iOS networking.",
        metadata: {
          module_name: "kmp-networking",
          branch_state: "active"
        }
      }
    });

    expect(runtime.observer.listEvents()).toMatchObject([
      {
        client_id: "chatgpt-web",
        tool_name: "remember_context",
        status: "success",
        response: {
          document_id: "memory-1",
          module_name: "kmp-networking",
          branch_state: "active"
        }
      },
      {
        client_id: "chatgpt-web",
        tool_name: "search_context",
        status: "success",
        response: {
          result_count: 1,
          result_ids: ["memory-1"],
          filter_module: "kmp-networking",
          filter_state: "active"
        }
      },
      {
        client_id: "chatgpt-web",
        tool_name: "fetch_context",
        status: "success",
        response: {
          document_id: "memory-1",
          module_name: "kmp-networking",
          branch_state: "active"
        }
      }
    ]);
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

function parseJsonTextContent(
  result: Awaited<ReturnType<Client["callTool"]>>
): Record<string, unknown> {
  return JSON.parse(textContent(result)) as Record<string, unknown>;
}
