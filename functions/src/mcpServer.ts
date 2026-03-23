import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { normalizeOptionalText } from "./normalize.js";
import type { ToolCallObserver } from "./observability.js";
import {
  buildFetchPayload,
  buildRememberPayload,
  buildSearchPayload,
  MetaCortexService
} from "./service.js";
import {
  BRANCH_STATES,
  type BranchState,
  type McpToolName
} from "./types.js";

export function createMetaCortexMcpServer(
  service: MetaCortexService,
  config: Pick<AppConfig, "serviceName" | "serviceVersion" | "defaultFilterState"> & {
    observer: ToolCallObserver;
    clientId: string;
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
  const observeToolCall = async <Result>(
    toolName: McpToolName,
    requestSummary: Record<string, unknown>,
    run: () => Promise<Result>,
    summarizeResult: (result: Result) => Record<string, unknown>
  ): Promise<Result> => {
    const startedAt = Date.now();

    try {
      const result = await run();

      await config.observer.record({
        client_id: config.clientId,
        tool_name: toolName,
        status: "success",
        latency_ms: Date.now() - startedAt,
        request: requestSummary,
        response: summarizeResult(result)
      });

      return result;
    } catch (error) {
      await config.observer.record({
        client_id: config.clientId,
        tool_name: toolName,
        status: "error",
        latency_ms: Date.now() - startedAt,
        request: requestSummary,
        error: summarizeToolError(error)
      });

      throw error;
    }
  };

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
        const requestSummary = {
          topic: normalizeOptionalText(args.topic) ?? "general",
          draft: args.draft ?? false,
          content_length: args.content?.trim().length ?? 0,
          image_present: Boolean(args.image_base64),
          artifact_ref_count: args.artifact_refs?.length ?? 0
        };
        const result = await observeToolCall(
          "remember_context",
          requestSummary,
          () => service.rememberContext(args),
          record => ({
            document_id: record.id,
            module_name: record.metadata.module_name,
            branch_state: record.metadata.branch_state,
            modality: record.metadata.modality,
            write_status: record.was_duplicate ? "duplicate" : "created",
            artifact_ref_count: record.metadata.artifact_refs?.length ?? 0
          })
        );

        return {
          content: [jsonTextContent(buildRememberPayload(result))]
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
          "Low-level admin write tool. Normalize text or image-backed memories with Gemini, embed the resulting retrieval text, and store it in Firestore-backed long-term memory. Prefer remember_context for normal chat-client writes.",
        inputSchema: {
          content: z
            .string()
            .optional()
            .describe("Optional raw markdown or text to store. Required unless image_base64 is provided."),
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
        const requestSummary = {
          module_name: normalizeOptionalText(args.module_name),
          branch_state: args.branch_state,
          content_length: args.content?.trim().length ?? 0,
          image_present: Boolean(args.image_base64),
          artifact_ref_count: args.artifact_refs?.length ?? 0
        };
        const result = await observeToolCall(
          "store_context",
          requestSummary,
          () => service.storeContext(args),
          record => ({
            document_id: record.id,
            module_name: record.metadata.module_name,
            branch_state: record.metadata.branch_state,
            modality: record.metadata.modality,
            write_status: record.was_duplicate ? "duplicate" : "created",
            artifact_ref_count: record.metadata.artifact_refs?.length ?? 0
          })
        );

        return {
          content: [
            {
              type: "text",
              text: [
                result.was_duplicate
                  ? `Reused existing memory vector ${result.id}.`
                  : `Stored memory vector ${result.id}.`,
                `write_status=${result.was_duplicate ? "duplicate" : "created"}`,
                `module_name=${result.metadata.module_name}`,
                `branch_state=${result.metadata.branch_state}`,
                `modality=${result.metadata.modality}`,
                result.media
                  ? `media=${result.media.kind}:${result.media.mime_type}`
                  : undefined,
                result.metadata.artifact_refs?.length
                  ? `artifact_refs=${result.metadata.artifact_refs.join(",")}`
                  : undefined,
                `created_at=${new Date(result.metadata.created_at).toISOString()}`,
                `updated_at=${new Date(result.metadata.updated_at).toISOString()}`
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
          "Search stored memories with a natural-language query. Returns a single JSON object with ranked matches, stable document ids, and metadata for follow-up fetches.",
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
        const requestSummary = {
          query_preview: truncateText(args.query),
          query_length: args.query.trim().length,
          filter_module: normalizeOptionalText(args.filter_module),
          filter_state: requestedFilterState,
          limit: args.limit
        };
        const result = await observeToolCall(
          "search_context",
          requestSummary,
          async () => {
            if (!config.allowedFilterStates.includes(requestedFilterState)) {
              throw new HttpError(
                403,
                `filter_state '${requestedFilterState}' is not allowed for this client`
              );
            }

            return service.searchContext(args);
          },
          searchResult => ({
            result_count: searchResult.matches.length,
            result_ids: searchResult.matches.map(match => match.id),
            filter_state: searchResult.appliedFilters.filter_state,
            filter_module: searchResult.appliedFilters.filter_module
          })
        );

        return {
          content: [jsonTextContent(buildSearchPayload(result))]
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
          "Fetch one stored memory by document id. Returns a single JSON object with canonical content, retrieval text, and metadata for the requested record.",
        inputSchema: {
          document_id: z
            .string()
            .min(1)
            .describe("The document id returned by search_context.")
        }
      },
      async args => {
        const requestSummary = {
          document_id: args.document_id
        };
        const result = await observeToolCall(
          "fetch_context",
          requestSummary,
          async () => {
            const fetched = await service.fetchContext(args);

            if (
              !config.allowedFilterStates.includes(
                fetched.item.metadata.branch_state
              )
            ) {
              throw new HttpError(
                403,
                `branch_state '${fetched.item.metadata.branch_state}' is not allowed for this client`
              );
            }

            return fetched;
          },
          fetched => ({
            document_id: fetched.item.id,
            module_name: fetched.item.metadata.module_name,
            branch_state: fetched.item.metadata.branch_state,
            modality: fetched.item.metadata.modality,
            artifact_ref_count: fetched.item.metadata.artifact_refs?.length ?? 0
          })
        );

        return {
          content: [jsonTextContent(buildFetchPayload(result))]
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
        const requestSummary = {
          document_id: args.document_id,
          superseding_document_id: args.superseding_document_id
        };
        const result = await observeToolCall(
          "deprecate_context",
          requestSummary,
          () => service.deprecateContext(args),
          record => ({
            document_id: record.document_id,
            superseding_document_id: record.superseding_document_id,
            previous_state: record.previous_state
          })
        );

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
        const requestSummary = {
          module_name: normalizeOptionalText(args.module_name)
        };
        const result = await observeToolCall(
          "get_consolidation_queue",
          requestSummary,
          () => service.getConsolidationQueue(args),
          queue => ({
            filter_module: queue.filter_module,
            result_count: queue.items.length,
            result_ids: queue.items.map(item => item.id)
          })
        );

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
              `module_name=${item.metadata.module_name}`,
              `updated_at=${new Date(item.metadata.updated_at).toISOString()}`,
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

function summarizeToolError(error: unknown): {
  name: string;
  message: string;
  status_code?: number;
} {
  if (error instanceof HttpError) {
    return {
      name: error.name,
      message: error.message,
      status_code: error.statusCode
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    name: "UnknownError",
    message: String(error)
  };
}

function truncateText(value: string, limit = 160): string {
  const normalized = value.trim();

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit)}...`;
}

function jsonTextContent(payload: Record<string, unknown>) {
  return {
    type: "text" as const,
    text: JSON.stringify(payload)
  };
}
