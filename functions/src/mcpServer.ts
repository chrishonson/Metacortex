import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { formatSearchResults, OpenBrainService } from "./service.js";
import {
  ARTIFACT_TYPES,
  BRANCH_STATES,
  type McpToolName
} from "./types.js";

export function createOpenBrainMcpServer(
  service: OpenBrainService,
  config: Pick<AppConfig, "serviceName" | "serviceVersion" | "defaultFilterState"> & {
    allowedTools: readonly McpToolName[];
  }
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

  const allowedTools = new Set(config.allowedTools);

  if (allowedTools.has("store_context")) {
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
            .describe("Required when image_base64 is provided, for example image/png."),
          artifact_refs: z
            .array(z.string())
            .optional()
            .describe("Optional array of Firebase Storage URIs (gs://...) linking to multimodal evidence.")
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
  }

  if (allowedTools.has("search_context")) {
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
            .describe("Optional branch state filter. Defaults to active."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Max results to return. Defaults to 5.")
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
  }

  if (allowedTools.has("deprecate_context")) {
    server.registerTool(
      "deprecate_context",
      {
        title: "Deprecate Context",
        description:
          "Soft-delete an obsolete memory by setting its state to deprecated and recording which document supersedes it. The document remains in the database for historical audits but vanishes from default active searches.",
        inputSchema: {
          document_id: z
            .string()
            .min(1)
            .describe("The Firestore document ID of the obsolete memory."),
          superseding_document_id: z
            .string()
            .min(1)
            .describe("The Firestore document ID of the new memory that replaces it.")
        }
      },
      async args => {
        const result = await service.deprecateContext(args);

        return {
          content: [
            {
              type: "text",
              text: [
                `Deprecated memory ${result.document_id}.`,
                `previous_state=${result.previous_state}`,
                `superseded_by=${result.superseding_document_id}`
              ].join("\n")
            }
          ]
        };
      }
    );
  }

  if (allowedTools.has("get_consolidation_queue")) {
    server.registerTool(
      "get_consolidation_queue",
      {
        title: "Get Consolidation Queue",
        description:
          "Fetch all WIP (work-in-progress) memories that need to be synthesized into official specs. Used by the local Nanobot cron job. Returns document IDs and raw content without performing vector search.",
        inputSchema: {
          module_name: z
            .string()
            .optional()
            .describe("Optional module name to filter the queue. Returns all modules if omitted.")
        }
      },
      async args => {
        const result = await service.getConsolidationQueue(args);

        if (result.items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: result.filter_module
                  ? `No WIP items found for module ${result.filter_module}.`
                  : "No WIP items found."
              }
            ]
          };
        }

        const lines = result.items.map(
          (item, index) =>
            [
              `Item ${index + 1}`,
              `id=${item.id}`,
              `artifact_type=${item.metadata.artifact_type}`,
              `module_name=${item.metadata.module_name}`,
              `timestamp=${new Date(item.metadata.timestamp).toISOString()}`,
              item.content
            ].join(" | ")
        );

        return {
          content: [
            {
              type: "text",
              text: [
                `Found ${result.items.length} WIP item(s)${result.filter_module ? ` for module ${result.filter_module}` : ""}.`,
                "",
                ...lines
              ].join("\n")
            }
          ]
        };
      }
    );
  }

  return server;
}
