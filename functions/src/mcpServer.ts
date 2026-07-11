import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { normalizeOptionalText } from "./normalize.js";
import type {
  RetrievalEventInput,
  ToolCallObserver
} from "./observability.js";
import {
  buildConsolidatePayload,
  buildDeprecatePayload,
  buildFetchPayload,
  buildRememberPayload,
  buildSearchPayload,
  MetaCortexService
} from "./service.js";
import {
  BRANCH_STATES,
  SUPERSESSION_REASONS,
  type BranchState,
  type McpToolName
} from "./types.js";

export function createMetaCortexMcpServer(
  service: MetaCortexService,
  config: Pick<
    AppConfig,
    | "serviceName"
    | "serviceVersion"
    | "defaultFilterState"
    | "memoryCollection"
    | "retrievalEventLoggingEnabled"
    | "topK"
  > & {
    observer: ToolCallObserver;
    clientId: string;
    allowedTools: readonly McpToolName[];
    allowedFilterStates: readonly BranchState[];
  }
): McpServer {
  const rememberContextInputSchema = z
    .object({
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
          "Convenience shorthand for draft writes. Use true to store the memory as wip. Do not send this with branch_state."
        ),
      branch_state: z
        .enum(BRANCH_STATES)
        .optional()
        .describe(
          "Optional advanced lifecycle state. Defaults to active. Use this instead of draft when you need explicit lifecycle control such as merged or deprecated."
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
    })
    .superRefine((value, ctx) => {
      if (typeof value.draft !== "undefined" && typeof value.branch_state !== "undefined") {
        ctx.addIssue({
          code: "custom",
          path: ["branch_state"],
          message: "Provide either draft or branch_state, not both"
        });
      }
    });
  const fetchContextInputSchema = z
    .object({
      id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The stable memory id returned by remember_context or search_context."
        ),
      document_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Compatibility alias for id. Prefer id for new clients."
        )
    })
    .superRefine((value, ctx) => {
      const id = normalizeOptionalText(value.id);
      const documentId = normalizeOptionalText(value.document_id);

      if (!id && !documentId) {
        ctx.addIssue({
          code: "custom",
          path: ["id"],
          message: "Provide id or document_id"
        });
      }

      if (id && documentId && id !== documentId) {
        ctx.addIssue({
          code: "custom",
          path: ["document_id"],
          message: "id and document_id must match when both are provided"
        });
      }
    });
  const consolidateContextInputSchema = z
    .object({
      topic: z
        .string()
        .optional()
        .describe(
          "Topic whose WIP memory queue will be consolidated. Defaults to general. Ignored when source_ids is provided — in that case topic labels the merged output."
        ),
      source_ids: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Explicit list of unique memory ids to consolidate. When provided, these memories are merged regardless of their branch_state. At least 2 ids required."
        )
    })
    .superRefine((value, ctx) => {
      if (!value.source_ids) {
        return;
      }

      const uniqueIds = new Set(value.source_ids);

      if (uniqueIds.size !== value.source_ids.length) {
        ctx.addIssue({
          code: "custom",
          path: ["source_ids"],
          message: "source_ids must be unique"
        });
      }
    });
  const server = new McpServer(
    {
      name: config.serviceName,
      version: config.serviceVersion
    },
    {
      capabilities: {
        logging: {}
      },
      instructions: buildServerInstructions(config.allowedTools)
    }
  );

  const allowedTools = new Set(config.allowedTools);
  const observeToolCall = async <Result>(
    toolName: McpToolName,
    requestSummary: Record<string, unknown>,
    run: () => Promise<Result>,
    summarizeResult: (result: Result) => Record<string, unknown>,
    retrieval?: {
      request: RetrievalEventInput;
      summarizeResult: (result: Result) => Partial<RetrievalEventInput>;
    }
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
        response: summarizeResult(result),
        ...(retrieval
          ? {
              retrieval: {
                ...retrieval.request,
                ...retrieval.summarizeResult(result)
              } as RetrievalEventInput
            }
          : {})
      });

      return result;
    } catch (error) {
      await config.observer.record({
        client_id: config.clientId,
        tool_name: toolName,
        status: "error",
        latency_ms: Date.now() - startedAt,
        request: requestSummary,
        ...(retrieval ? { retrieval: retrieval.request } : {}),
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
          "Save a durable memory for future retrieval. This is the single write tool for both chat clients and admin workflows. The server defaults topic to general and branch_state to active. Use draft=true as a shorthand for wip, or set branch_state explicitly for advanced lifecycle control. Do not send both.",
        inputSchema: rememberContextInputSchema
      },
      async args => {
        const requestedBranchState = args.branch_state ?? (args.draft ? "wip" : "active");
        const requestSummary = {
          topic: normalizeOptionalText(args.topic) ?? "general",
          branch_state: requestedBranchState,
          draft: args.draft,
          content_length: args.content?.trim().length ?? 0,
          image_present: Boolean(args.image_base64),
          artifact_ref_count: args.artifact_refs?.length ?? 0
        };
        const result = await observeToolCall(
          "remember_context",
          requestSummary,
          () => service.rememberContext(args),
          record => ({
            id: record.id,
            topic: record.metadata.module_name,
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

  if (allowedTools.has("search_context")) {
    server.registerTool(
      "search_context",
      {
        title: "Search Context",
        description:
          "Search stored memories with a natural-language query. Returns a single JSON object with ranked matches, stable ids, and metadata for follow-up fetches.",
        inputSchema: {
          query: z.string().min(1).describe("The natural-language search query."),
          filter_topic: z
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
            .describe("Max results to return. Defaults to 5."),
          valid_at: z
            .number()
            .optional()
            .describe("Optional epoch-ms timestamp. When provided, only returns memories valid at that point in time (valid_from <= valid_at < valid_until, excluding corrected records).")
        }
      },
      async args => {
        const requestedFilterState = args.filter_state ?? config.defaultFilterState;
        const normalizedFilterTopic = normalizeOptionalText(args.filter_topic);
        const requestedLimit = args.limit ?? config.topK;
        const requestSummary = {
          query_preview: truncateText(args.query),
          query_length: args.query.trim().length,
          filter_topic: normalizedFilterTopic,
          filter_state: requestedFilterState,
          limit: args.limit,
          valid_at: args.valid_at
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
            filter_topic: searchResult.appliedFilters.filter_topic
          }),
          config.retrievalEventLoggingEnabled
            ? {
                request: {
                  event_type: "search",
                  memory_collection: config.memoryCollection,
                  query: args.query.trim(),
                  filter_topic: normalizedFilterTopic,
                  filter_state: requestedFilterState,
                  limit: requestedLimit
                },
                summarizeResult: searchResult => ({
                  result_count: searchResult.matches.length,
                  results: searchResult.matches.map((match, index) => ({
                    id: match.id,
                    rank: index + 1,
                    ...(typeof match.distance === "number"
                      ? {
                          score: Math.max(
                            0,
                            Number((1 - match.distance).toFixed(6))
                          )
                        }
                      : {})
                  }))
                })
              }
            : undefined
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
          "Fetch one stored memory by id. Pass the id returned by remember_context or search_context.",
        inputSchema: fetchContextInputSchema
      },
      async args => {
        const requestSummary = {
          id: args.id ?? args.document_id,
          used_document_id_alias: Boolean(args.document_id && !args.id)
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
                404,
                "Document not found"
              );
            }

            return fetched;
          },
          fetched => ({
            id: fetched.item.id,
            topic: fetched.item.metadata.module_name,
            branch_state: fetched.item.metadata.branch_state,
            modality: fetched.item.metadata.modality,
            artifact_ref_count: fetched.item.metadata.artifact_refs?.length ?? 0
          }),
          config.retrievalEventLoggingEnabled
            ? {
                request: {
                  event_type: "fetch",
                  memory_collection: config.memoryCollection,
                  memory_id: args.id ?? args.document_id ?? ""
                },
                summarizeResult: () => ({ found: true })
              }
            : undefined
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
          "Soft-delete an obsolete memory by setting its state to deprecated and recording which id supersedes it. The memory remains in the database for historical audits but vanishes from default active searches.",
        inputSchema: {
          id: z
            .string()
            .min(1)
            .describe("The id of the obsolete memory."),
          superseding_id: z
            .string()
            .min(1)
            .describe("The id of the new memory that replaces it."),
          supersession_reason: z
            .enum(SUPERSESSION_REASONS)
            .optional()
            .describe("Why the memory is being superseded. 'changed' (default) means the old fact was true of its era, records valid_until. 'corrected' means the old record was never true, excluded from valid-time results but kept for audit."),
          initiator: z
            .enum(["user", "agent"])
            .optional()
            .describe("Who initiated this deprecation, for audit purposes.")
        }
      },
      async args => {
        const requestSummary = {
          id: args.id,
          superseding_id: args.superseding_id,
          supersession_reason: args.supersession_reason,
          initiator: args.initiator
        };
        const result = await observeToolCall(
          "deprecate_context",
          requestSummary,
          () => service.deprecateContext(args),
          record => ({
            id: record.id,
            superseding_id: record.superseding_id,
            previous_state: record.previous_state,
            supersession_reason: record.supersession_reason
          })
        );

        return {
          content: [jsonTextContent(buildDeprecatePayload(result))]
        };
      }
    );
  }

  if (allowedTools.has("consolidate_context")) {
    server.registerTool(
      "consolidate_context",
      {
        title: "Consolidate Context",
        description:
          "Merge multiple related memories into one canonical active memory. By default, consolidates all WIP (draft) memories for a topic. Pass source_ids to consolidate specific memories regardless of their current state. Deprecates all source memories and links them to the merged result.",
        inputSchema: consolidateContextInputSchema
      },
      async args => {
        const requestSummary = {
          topic: normalizeOptionalText(args.topic) ?? "general",
          source_ids: args.source_ids ?? [],
          source_id_count: args.source_ids?.length ?? 0
        };
        const result = await observeToolCall(
          "consolidate_context",
          requestSummary,
          () =>
            service.consolidateContext({
              topic: args.topic,
              source_ids: args.source_ids
            }),
          record => ({
            merged_id: record.merged_id,
            topic: record.topic,
            source_count: record.source_count,
            deprecated_ids: record.deprecated_ids
          })
        );

        return {
          content: [jsonTextContent(buildConsolidatePayload(result))]
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

function buildServerInstructions(allowedTools: readonly McpToolName[]): string {
  const allowedToolSet = new Set(allowedTools);
  const instructions = [
    "MetaCortex stores durable project memories and returns tool results as JSON text.",
    allowedToolSet.has("remember_context")
      ? "Use remember_context for writes. Prefer topic plus plain content, and send either draft or branch_state, not both."
      : undefined,
    allowedToolSet.has("search_context")
      ? "Use search_context for retrieval and filter_topic to narrow by topic."
      : undefined,
    allowedToolSet.has("fetch_context")
      ? "Use fetch_context with the id returned by remember_context or search_context when you need the full stored record."
      : undefined,
    allowedToolSet.has("consolidate_context")
      ? "Use consolidate_context to merge WIP draft memories into one canonical active memory, or pass source_ids to consolidate specific memories."
      : undefined
  ];

  return instructions.filter(Boolean).join(" ");
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
