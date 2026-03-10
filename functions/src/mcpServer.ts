import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { formatSearchResults, OpenBrainService } from "./service.js";
import { ARTIFACT_TYPES, BRANCH_STATES } from "./types.js";

export function createOpenBrainMcpServer(
  service: OpenBrainService,
  config: Pick<AppConfig, "serviceName" | "serviceVersion" | "defaultFilterState">
): McpServer {
  const server = new McpServer(
    {
      name: config.serviceName,
      version: config.serviceVersion
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  server.registerTool(
    "store_context",
    {
      title: "Store Context",
      description:
        "Normalize text or image-backed memories with Gemini, embed the resulting retrieval text, and store it in Firestore-backed long-term memory.",
      inputSchema: {
        content: z
          .string()
          .optional()
          .describe("Optional raw markdown or text to store. Required unless image_base64 is provided."),
        artifact_type: z
          .enum(ARTIFACT_TYPES)
          .describe("The type of artifact being stored."),
        module_name: z
          .string()
          .min(1)
          .describe("The codebase or subsystem name associated with the content."),
        branch_state: z
          .enum(BRANCH_STATES)
          .describe("The branch lifecycle state for the stored content."),
        image_base64: z
          .string()
          .optional()
          .describe("Optional base64-encoded image bytes for multimodal memories."),
        image_mime_type: z
          .string()
          .optional()
          .describe("Required when image_base64 is provided, for example image/png.")
      }
    },
    async args => {
      const result = await service.storeContext(args);

      return {
        content: [
          {
            type: "text",
            text: [
              `Stored memory vector ${result.id}.`,
              `artifact_type=${result.metadata.artifact_type}`,
              `module_name=${result.metadata.module_name}`,
              `branch_state=${result.metadata.branch_state}`,
              `modality=${result.metadata.modality}`,
              result.media
                ? `media=${result.media.kind}:${result.media.mime_type}`
                : undefined,
              `timestamp=${new Date(result.metadata.timestamp).toISOString()}`
            ]
              .filter(Boolean)
              .join("\n")
          }
        ]
      };
    }
  );

  server.registerTool(
    "search_context",
    {
      title: "Search Context",
      description:
        "Embed a text query with Gemini, pre-filter Firestore documents by relational metadata, and return the nearest text or image-backed context matches.",
      inputSchema: {
        query: z.string().min(1).describe("The natural-language search query."),
        filter_module: z
          .string()
          .optional()
          .describe("Optional module name to pre-filter before vector search."),
        filter_state: z
          .enum(BRANCH_STATES)
          .default(config.defaultFilterState)
          .describe("Optional branch state filter. Defaults to active.")
      }
    },
    async args => {
      const result = await service.searchContext(args);

      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(result)
          }
        ]
      };
    }
  );

  return server;
}
