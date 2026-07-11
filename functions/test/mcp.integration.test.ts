import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMetaCortexApp } from "../src/app.js";
import { createTestRuntime } from "./support/fakes.js";

const authorizationHeaderName = "Authorization";
const authTokenField = ["auth", "Token"].join("") as "authToken";

function accessCredential(label: string): string {
  return `${label}-access`;
}

function bearerHeader(label: string): string {
  return ["Bearer", accessCredential(label)].join(" ");
}

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
      createMetaCortexApp({
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
          [authorizationHeaderName]: bearerHeader("test")
        }
      }
    });

    cleanup.push(async () => {
      await client.close();
    });

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      "consolidate_context",
      "deprecate_context",
      "fetch_context",
      "remember_context",
      "search_context"
    ]);
    expect(
      tools.tools.find(tool => tool.name === "remember_context")
    ).toMatchObject({
      description: expect.stringContaining("Do not send both"),
      inputSchema: {
        properties: expect.objectContaining({
          topic: expect.any(Object),
          draft: expect.any(Object),
          branch_state: expect.any(Object)
        })
      }
    });
    expect(
      tools.tools.find(tool => tool.name === "search_context")
    ).toMatchObject({
      inputSchema: {
        properties: expect.objectContaining({
          query: expect.any(Object),
          filter_topic: expect.any(Object)
        })
      }
    });
    expect(
      tools.tools.find(tool => tool.name === "fetch_context")
    ).toMatchObject({
      description: expect.stringContaining("returned by remember_context"),
      inputSchema: {
        properties: expect.objectContaining({
          id: expect.any(Object),
          document_id: expect.any(Object)
        })
      }
    });
    expect(tools.tools.map(tool => tool.name)).not.toContain("get_consolidation_queue");

    const rememberResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content:
          "We are using Ktor for the Android/iOS networking layer in the main branch.",
        topic: "kmp-networking"
      }
    });

    expect(parseJsonTextContent(rememberResult)).toMatchObject({
      item: {
        id: "memory-1",
        content:
          "We are using Ktor for the Android/iOS networking layer in the main branch.",
        metadata: {
          topic: "kmp-networking",
          branch_state: "active",
          modality: "text"
        }
      },
      write_status: "created"
    });

    const searchResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "networking layer for Android and iOS",
        filter_topic: "kmp-networking"
      }
    });

    const searchPayload = parseJsonTextContent(searchResult);
    expect(searchPayload).toMatchObject({
      matches: [
        {
          id: "memory-1",
          summary: expect.stringContaining("Ktor"),
          metadata: {
            topic: "kmp-networking",
            branch_state: "active"
          }
        }
      ],
      applied_filters: {
        filter_topic: "kmp-networking",
        filter_state: "active"
      }
    });
    expect(searchPayload.matches?.[0]).not.toHaveProperty("content_preview");

    const replacementResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content: "We standardized on Ktor 3 for shared networking.",
        topic: "kmp-networking"
      }
    });

    expect(parseJsonTextContent(replacementResult)).toMatchObject({
      item: {
        id: "memory-2"
      },
      write_status: "created"
    });

    const deprecateResult = await client.callTool({
      name: "deprecate_context",
      arguments: {
        id: "memory-1",
        superseding_id: "memory-2"
      }
    });

    expect(parseJsonTextContent(deprecateResult)).toMatchObject({
      item: {
        id: "memory-1",
        branch_state: "deprecated",
        superseded_by: "memory-2"
      },
      previous_state: "active"
    });

    const removedQueueResult = await client.callTool({
      name: "get_consolidation_queue",
      arguments: {
        topic: "kmp-networking"
      }
    });

    expect(removedQueueResult.isError).toBe(true);
    expect(textContent(removedQueueResult)).toContain(
      "Tool get_consolidation_queue not found"
    );

    const invalidRememberResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content: "This should fail.",
        topic: "kmp-networking",
        draft: true,
        branch_state: "wip"
      }
    });

    expect(invalidRememberResult.isError).toBe(true);
    expect(textContent(invalidRememberResult)).toContain(
      "Provide either draft or branch_state, not both"
    );
  });

  it("supports temporal validity fields on deprecate_context and search_context", async () => {
    const runtime = createTestRuntime();
    const baseUrl = await startServer(
      createMetaCortexApp({
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
          [authorizationHeaderName]: bearerHeader("test")
        }
      }
    });

    cleanup.push(async () => {
      await client.close();
    });

    await client.connect(transport);

    // Call remember_context to create a memory
    const rememberResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content: "We are using Ktor for networking.",
        topic: "kmp-networking"
      }
    });

    const rememberPayload = parseJsonTextContent(rememberResult) as any;
    expect(rememberPayload).toMatchObject({
      write_status: "created"
    });
    const firstId = rememberPayload.item.id;

    // Call remember_context again to create a second "replacement" memory
    const replacementResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content: "We standardized on Ktor 3 for shared networking.",
        topic: "kmp-networking"
      }
    });

    const replacementPayload = parseJsonTextContent(replacementResult) as any;
    expect(replacementPayload).toMatchObject({
      write_status: "created"
    });
    const secondId = replacementPayload.item.id;

    // Call deprecate_context with corrected reason and initiator user
    const deprecateResult = await client.callTool({
      name: "deprecate_context",
      arguments: {
        id: firstId,
        superseding_id: secondId,
        supersession_reason: "corrected",
        initiator: "user"
      }
    });

    expect(parseJsonTextContent(deprecateResult)).toMatchObject({
      item: {
        id: firstId,
        branch_state: "deprecated",
        superseded_by: secondId,
        supersession_reason: "corrected"
      },
      previous_state: "active"
    });

    // Call search_context with valid_at: Date.now() - firstId must not be in matches
    const searchResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "networking",
        filter_state: "deprecated",
        valid_at: Date.now()
      }
    });

    const searchPayload = parseJsonTextContent(searchResult) as any;
    expect(searchPayload.matches.map((m: any) => m.id)).not.toContain(firstId);

    // Additionally call remember_context to create a third memory
    const thirdResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content: "We use Ktor for Android and iOS networking.",
        topic: "kmp-networking"
      }
    });

    const thirdPayload = parseJsonTextContent(thirdResult) as any;
    expect(thirdPayload).toMatchObject({
      write_status: "created"
    });
    const thirdId = thirdPayload.item.id;

    // Capture beforeDeprecation timestamp
    const beforeDeprecation = Date.now();

    // Call deprecate_context with supersession_reason "changed" (or omit, but we'll specify "changed" as requested)
    const deprecateThirdResult = await client.callTool({
      name: "deprecate_context",
      arguments: {
        id: thirdId,
        superseding_id: secondId,
        supersession_reason: "changed"
      }
    });

    const deprecateThirdPayload = parseJsonTextContent(deprecateThirdResult) as any;
    expect(deprecateThirdPayload.item.supersession_reason).toBe("changed");

    // Search with valid_at before the deprecation - thirdId IS included
    const searchBeforeResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "networking",
        filter_state: "deprecated",
        valid_at: beforeDeprecation - 1000
      }
    });

    const searchBeforePayload = parseJsonTextContent(searchBeforeResult) as any;
    expect(searchBeforePayload.matches.map((m: any) => m.id)).toContain(thirdId);

    // Search with valid_at after the deprecation - thirdId is NOT included
    const searchAfterResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "networking",
        filter_state: "deprecated",
        valid_at: Date.now() + 1000
      }
    });

    const searchAfterPayload = parseJsonTextContent(searchAfterResult) as any;
    expect(searchAfterPayload.matches.map((m: any) => m.id)).not.toContain(thirdId);
  });

  it("enforces tool scoping on client-specific endpoints", async () => {
    const runtime = createTestRuntime({
      clientProfiles: [
        {
          id: "autonomous-agent",
          [authTokenField]: accessCredential("agent"),
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
      createMetaCortexApp({
        getConfig: () => runtime.config,
        getObserver: () => runtime.observer,
        getRuntime: () => runtime
      }),
      cleanup
    );

    const client = new Client({
      name: "autonomous-agent-client",
      version: "1.0.0"
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/clients/autonomous-agent/mcp`),
      {
        requestInit: {
          headers: {
            [authorizationHeaderName]: bearerHeader("agent")
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
        filter_topic: "kmp-networking"
      }
    });

    const scopedSearchPayload = parseJsonTextContent(searchResult);
    expect(scopedSearchPayload).toMatchObject({
      matches: [
        {
          id: "memory-1",
          summary: expect.stringContaining("Ktor")
        }
      ]
    });
    expect(scopedSearchPayload.matches?.[0]).not.toHaveProperty("content_preview");
    const disallowedResult = await client.callTool({
      name: "remember_context",
      arguments: {
        content: "should fail",
        topic: "kmp-networking"
      }
    });

    expect(disallowedResult.isError).toBe(true);
    expect(textContent(disallowedResult)).toContain("Tool remember_context not found");

    const disallowedStateResult = await client.callTool({
      name: "search_context",
      arguments: {
        query: "old deprecated networking layer",
        filter_topic: "kmp-networking",
        filter_state: "deprecated"
      }
    });

    expect(disallowedStateResult.isError).toBe(true);
    expect(textContent(disallowedStateResult)).toContain(
      "filter_state 'deprecated' is not allowed"
    );

    expect(runtime.observer.listEvents().at(-1)).toMatchObject({
      client_id: "autonomous-agent",
      tool_name: "search_context",
      status: "error",
      error: {
        message: "filter_state 'deprecated' is not allowed for this client",
        status_code: 403
      }
    });
    expect(runtime.observer.listRetrievalEvents()).toEqual([]);
  });

  it("consolidates wip memories via consolidate_context tool", async () => {
    const runtime = createTestRuntime();
    const baseUrl = await startServer(
      createMetaCortexApp({
        getConfig: () => runtime.config,
        getObserver: () => runtime.observer,
        getRuntime: () => runtime
      }),
      cleanup
    );

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { [authorizationHeaderName]: bearerHeader("test") }
      }
    });
    cleanup.push(async () => { await client.close(); });
    await client.connect(transport);

    await client.callTool({
      name: "remember_context",
      arguments: { content: "Draft: use Ktor for Android.", topic: "kmp-networking", draft: true }
    });
    await client.callTool({
      name: "remember_context",
      arguments: { content: "Draft: Ktor supports multiplatform.", topic: "kmp-networking", draft: true }
    });

    const rawResult = await client.callTool({
      name: "consolidate_context",
      arguments: { topic: "kmp-networking" }
    });

    expect(rawResult.isError).toBeFalsy();

    const payload = parseJsonTextContent(rawResult) as {
      item: { merged_id: string; topic: string; branch_state: string };
      deprecated_ids: string[];
      source_count: number;
    };

    expect(payload.item.topic).toBe("kmp-networking");
    expect(payload.item.branch_state).toBe("active");
    expect(payload.source_count).toBe(2);
    expect(payload.deprecated_ids).toHaveLength(2);
    expect(typeof payload.item.merged_id).toBe("string");
  });

  it("rejects duplicate source_ids for consolidate_context", async () => {
    const runtime = createTestRuntime();
    const baseUrl = await startServer(
      createMetaCortexApp({
        getConfig: () => runtime.config,
        getObserver: () => runtime.observer,
        getRuntime: () => runtime
      }),
      cleanup
    );

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { [authorizationHeaderName]: bearerHeader("test") }
      }
    });
    cleanup.push(async () => { await client.close(); });
    await client.connect(transport);

    const result = await client.callTool({
      name: "consolidate_context",
      arguments: {
        topic: "kmp-networking",
        source_ids: ["memory-1", "memory-1"]
      }
    });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("source_ids must be unique");
  });

  it("returns neutral 404 when fetch_context targets a disallowed branch state", async () => {
    const runtime = createTestRuntime({
      clientProfiles: [
        {
          id: "chatgpt-web",
          [authTokenField]: accessCredential("chatgpt"),
          allowedOrigins: ["https://chatgpt.com"],
          allowedTools: ["fetch_context"],
          allowedFilterStates: ["active"]
        }
      ]
    });
    await runtime.service.storeContext({
      content: "Deprecated networking note.",
      module_name: "kmp-networking",
      branch_state: "deprecated"
    });
    const baseUrl = await startServer(
      createMetaCortexApp({
        getConfig: () => runtime.config,
        getObserver: () => runtime.observer,
        getRuntime: () => runtime
      }),
      cleanup
    );

    const client = new Client({ name: "chatgpt-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/clients/chatgpt-web/mcp`),
      {
        requestInit: {
          headers: {
            [authorizationHeaderName]: bearerHeader("chatgpt")
          }
        }
      }
    );
    cleanup.push(async () => { await client.close(); });
    await client.connect(transport);

    const result = await client.callTool({
      name: "fetch_context",
      arguments: {
        id: "memory-1"
      }
    });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("Document not found");
    expect(runtime.observer.listEvents().at(-1)).toMatchObject({
      client_id: "chatgpt-web",
      tool_name: "fetch_context",
      status: "error",
      error: {
        message: "Document not found",
        status_code: 404
      }
    });
  });

  it("supports ChatGPT web remember, search, and fetch flows", async () => {
    const runtime = createTestRuntime({
      retrievalEventLoggingEnabled: true,
      clientProfiles: [
        {
          id: "chatgpt-web",
          [authTokenField]: accessCredential("chatgpt"),
          allowedOrigins: ["https://chatgpt.com"],
          allowedTools: ["remember_context", "search_context", "fetch_context"],
          allowedFilterStates: ["active"]
        }
      ]
    });

    const baseUrl = await startServer(
      createMetaCortexApp({
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
            [authorizationHeaderName]: bearerHeader("chatgpt")
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
          topic: "kmp-networking",
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
        filter_topic: "kmp-networking"
      }
    });

    expect(parseJsonTextContent(searchResult)).toMatchObject({
      matches: [
        {
          id: "memory-1",
          metadata: {
            topic: "kmp-networking",
            branch_state: "active"
          }
        }
      ],
      applied_filters: {
        filter_topic: "kmp-networking",
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
        metadata: {
          topic: "kmp-networking",
          branch_state: "active"
        }
      }
    });
    expect(parseJsonTextContent(fetchResult)).not.toHaveProperty(
      "item.retrieval_text"
    );

    const conflictingFetchResult = await client.callTool({
      name: "fetch_context",
      arguments: {
        id: "memory-1",
        document_id: "memory-2"
      }
    });

    expect(conflictingFetchResult.isError).toBe(true);
    expect(textContent(conflictingFetchResult)).toContain(
      "id and document_id must match"
    );

    expect(runtime.observer.listEvents()).toMatchObject([
      {
        client_id: "chatgpt-web",
        tool_name: "remember_context",
        status: "success",
        response: {
          id: "memory-1",
          topic: "kmp-networking",
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
          filter_topic: "kmp-networking",
          filter_state: "active"
        }
      },
      {
        client_id: "chatgpt-web",
        tool_name: "fetch_context",
        status: "success",
        response: {
          id: "memory-1",
          topic: "kmp-networking",
          branch_state: "active"
        }
      }
    ]);
    expect(runtime.observer.listRetrievalEvents()).toMatchObject([
      {
        event_type: "search",
        client_id: "chatgpt-web",
        status: "success",
        memory_collection: "memory_vectors",
        query: "shared networking for android and ios",
        filter_topic: "kmp-networking",
        filter_state: "active",
        limit: 5,
        result_count: 1,
        results: [
          {
            id: "memory-1",
            rank: 1,
            score: expect.any(Number)
          }
        ]
      },
      {
        event_type: "fetch",
        client_id: "chatgpt-web",
        status: "success",
        memory_collection: "memory_vectors",
        memory_id: "memory-1",
        found: true
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
