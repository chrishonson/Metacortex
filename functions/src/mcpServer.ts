import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import {
  formatFetchedContext,
  formatSearchResults,
  OpenBrainService
} from "./service.js";
import {
  ARTIFACT_TYPES,
  BRANCH_STATES,
  REMEMBER_MEMORY_TYPES,
  type BranchState,
  type McpToolName
} from "./types.js";

export function createOpenBrainMcpServer(
  service: OpenBrainService,
  config: Pick<AppConfig, "serviceName" | "serviceVersion" | "defaultFilterState"> & {
    allowedTools: readonly McpToolName[];
    allowedFilterStates: readonly BranchState[];
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

  if (allowedTools.has("remember_context")) {
    server.registerTool(
      "remember_context",
      {
        title: "Remember Context",
        description:
          "Save a durable memory for future retrieval from chat clients. Prefer this over store_context for normal read/write use. The server defaults topic to general, stores canonical memories as active, and uses wip only when draft=true.",
        inputSchema: {
          content: z
            .string()
            .optional()
            .describe("The memory to save. Required unless image_base64 is provided."),
          topic: z
            .string()
            .optional()
            .describe(
              "Optional subsystem or topic label for later filtering, such as auth, billing, or ui-settings. Defaults to general if omitted."
            ),
          memory_type: z
            .enum(REMEMBER_MEMORY_TYPES)
            .optional()
            .describe(
              "Optional memory category. Use decision for chosen approaches, requirement for rules or constraints, pattern for reusable workflows, and spec for canonical interface or schema details. If omitted, the server infers a best-effort type."
            ),
          draft: z
            .boolean()
            .optional()
            .describe(
              "Set true only for rough notes awaiting consolidation. Omit or false for normal durable memory."
            ),
          image_base64: z
            .string()
            .optional()
            .describe("Optional base64-encoded image bytes for image-backed memories."),
          image_mime_type: z
            .string()
            .optional()
            .describe("Required when image_base64 is provided, for example image/png."),
          artifact_refs: z
            .array(z.string())
            .optional()
            .describe(
              "Optional external artifact references, usually Firebase Storage URIs such as gs://bucket/path.png."
            )
        }
      },
      async args => {
        const result = await service.rememberContext(args);

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
                result.metadata.artifact_refs?.length
                  ? `artifact_refs=${result.metadata.artifact_refs.join(",")}`
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

  if (allowedTools.has("store_context")) {
    server.registerTool(
      "store_context",
      {
        title: "Store Context",
        description:
          "Low-level admin write tool. Normalize text or image-backed memories with Gemini, embed the resulting retrieval text, and store it in Firestore-backed long-term memory using explicit metadata fields. Prefer remember_context for normal chat-client writes.",
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
            .describe(
              "The lifecycle state for the stored memory. Use active for canonical context, wip for draft material awaiting consolidation, merged for incorporated context, and deprecated for obsolete context."
            ),
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
                result.metadata.artifact_refs?.length
                  ? `artifact_refs=${result.metadata.artifact_refs.join(",")}`
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
          "Search stored memories with a natural-language query. Returns matching memories with document ids for follow-up fetches, plus artifact_refs when available.",
        inputSchema: {
          query: z.string().min(1).describe("The natural-language search query."),
          filter_module: z
            .string()
            .optional()
            .describe(
              "Optional topic or subsystem label to pre-filter before vector search, such as auth, billing, or kmp-networking."
            ),
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
        const requestedFilterState = args.filter_state ?? config.defaultFilterState;

        if (!config.allowedFilterStates.includes(requestedFilterState)) {
          throw new HttpError(
            403,
            `filter_state '${requestedFilterState}' is not allowed for this client`
          );
        }

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

  if (allowedTools.has("fetch_context")) {
    server.registerTool(
      "fetch_context",
      {
        title: "Fetch Context",
        description:
          "Fetch one stored memory by document id. Use this after search_context when a client needs the full stored content or artifact references for a specific result.",
        inputSchema: {
          document_id: z
            .string()
            .min(1)
            .describe("The document id returned by search_context.")
        }
      },
      async args => {
        const result = await service.fetchContext(args);

        if (!config.allowedFilterStates.includes(result.item.metadata.branch_state)) {
          throw new HttpError(
            403,
            `branch_state '${result.item.metadata.branch_state}' is not allowed for this client`
          );
        }

        return {
          content: [
            {
              type: "text",
              text: formatFetchedContext(result)
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
          "Fetch all memories whose branch_state is wip, optionally filtered by module_name. This is a raw backlog read for draft memories awaiting consolidation into canonical context; it does not perform vector search or change any records.",
        inputSchema: {
          module_name: z
            .string()
            .optional()
            .describe(
              "Optional module name to filter draft memories. Returns all wip memories if omitted."
            )
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
