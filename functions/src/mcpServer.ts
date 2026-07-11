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
  buildListPayload,
  buildRememberPayload,
  buildSearchPayload,
  MetaCortexService
} from "./service.js";
import {
  BRANCH_STATES,
  PROVENANCE_ORIGINS,
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
      valid_from: z
        .number()
        .optional()
        .describe(
          "Optional epoch-ms timestamp marking when this fact becomes valid. Omit for facts valid from creation."
        ),
      valid_until: z
        .number()
        .optional()
        .describe(
          "Optional epoch-ms timestamp marking when this fact stops being valid. Omit for facts with no known end."
        ),
      origin: z
        .enum(PROVENANCE_ORIGINS)
        .optional()
        .describe(
          "Optional provenance origin for this write. Defaults to agent_inferred when omitted. Only claim user_asserted when the user explicitly stated this fact themselves."
        ),
      source_session: z
        .string()
        .optional()
        .describe(
          "Optional identifier for the session or conversation this memory was derived from."
        ),
      derived_from: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of memory ids that this inference was derived from."
        ),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Optional confidence score between 0 and 1 for agent-inferred memories."
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
          origin: args.origin,
          draft: args.draft,
          content_length: args.content?.trim().length ?? 0,
          image_present: Boolean(args.image_base64),
          artifact_ref_count: args.artifact_refs?.length ?? 0,
          valid_from: args.valid_from,
          valid_until: args.valid_until
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
            .describe("Optional epoch-ms timestamp. When provided, only returns memories valid at that point in time (valid_from <= valid_at < valid_until, excluding corrected records)."),
          filter_origin: z
            .enum(PROVENANCE_ORIGINS)
            .optional()
            .describe(
              "Optional provenance origin filter. Only returns memories whose provenance.origin matches exactly; memories without provenance metadata are excluded when this filter is set."
            )
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
          valid_at: args.valid_at,
          filter_origin: args.filter_origin
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

  if (allowedTools.has("list_context")) {
    server.registerTool(
      "list_context",
      {
        title: "List Context",
        description:
          "Enumerate stored memories without vector search. Supports cursor-based pagination and filtering by topic, state, origin, and creation time. Returns a JSON object with items, next_cursor, and applied_filters. Note: due to origin post-filtering, a page may contain fewer than limit items while next_cursor is non-null.",
        inputSchema: {
          filter_topic: z
            .string()
            .optional()
            .describe(
              "Optional topic or subsystem label to pre-filter, such as auth, billing, or kmp-networking."
            ),
          filter_state: z
            .enum(BRANCH_STATES)
            .default(config.defaultFilterState)
            .describe("Optional branch state filter. Defaults to active."),
          filter_origin: z
            .enum(PROVENANCE_ORIGINS)
            .optional()
            .describe(
              "Optional provenance origin filter. Only returns memories whose provenance.origin matches exactly; memories without provenance metadata are excluded when this filter is set."
            ),
          created_after: z
            .number()
            .optional()
            .describe("Optional epoch-ms timestamp (inclusive). Only returns memories created at or after this time."),
          created_before: z
            .number()
            .optional()
            .describe("Optional epoch-ms timestamp (exclusive). Only returns memories created before this time."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe("Max results to return. Defaults to 20."),
          cursor: z
            .string()
            .optional()
            .describe("Optional cursor for pagination (a document id). When set, starts after the cursor.")
        }
      },
      async args => {
        const requestedFilterState = args.filter_state ?? config.defaultFilterState;
        const normalizedFilterTopic = normalizeOptionalText(args.filter_topic);
        const requestSummary = {
          filter_topic: normalizedFilterTopic,
          filter_state: requestedFilterState,
          filter_origin: args.filter_origin,
          created_after: args.created_after,
          created_before: args.created_before,
          limit: args.limit,
          cursor: args.cursor
        };
        const result = await observeToolCall(
          "list_context",
          requestSummary,
          async () => {
            if (!config.allowedFilterStates.includes(requestedFilterState)) {
              throw new HttpError(
                403,
                `filter_state '${requestedFilterState}' is not allowed for this client`
              );
            }

            return service.listContext(args);
          },
          listResult => ({
            result_count: listResult.items.length,
            result_ids: listResult.items.map(item => item.id),
            filter_state: listResult.applied_filters.filter_state,
            filter_topic: listResult.applied_filters.filter_topic,
            has_next_cursor: listResult.next_cursor !== null
          })
        );

        return {
          content: [jsonTextContent(buildListPayload(result))]
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

  server.registerPrompt(
    "correct_memory",
    {
      title: "Correct Memory",
      description:
        "User-initiated correction: retract a memory that was never true and replace it with the corrected fact. This composes remember_context and deprecate_context; only a user can invoke a prompt, so the agent can never trigger a correction on its own.",
      argsSchema: {
        incorrect_memory_id: z
          .string()
          .min(1)
          .describe("The id of the existing memory that was never true and must be retracted."),
        corrected_content: z
          .string()
          .min(1)
          .describe("The corrected fact to store in place of the incorrect memory."),
        topic: z
          .string()
          .optional()
          .describe("Optional topic label for the corrected memory."),
        valid_from: z
          .string()
          .optional()
          .describe("Optional epoch-ms timestamp (as a string) marking when the corrected fact becomes valid."),
        valid_until: z
          .string()
          .optional()
          .describe("Optional epoch-ms timestamp (as a string) marking when the corrected fact stops being valid.")
      }
    },
    args => {
      const topicLine = args.topic ? `\n- topic: ${args.topic}` : "";
      const validFromLine = args.valid_from ? `\n- valid_from: ${args.valid_from}` : "";
      const validUntilLine = args.valid_until ? `\n- valid_until: ${args.valid_until}` : "";

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                "This is a USER-INITIATED correction: the memory below was never true (a belief-axis retraction), not a fact that merely changed over time. Perform the following steps in order:\n\n" +
                `1. Call remember_context with content: "${args.corrected_content}"${topicLine}${validFromLine}${validUntilLine}\n` +
                `2. Call deprecate_context with id: "${args.incorrect_memory_id}", superseding_id: <the id returned by step 1>, supersession_reason: "corrected", initiator: "user"\n` +
                "3. Report both the deprecated id and the new corrected id back to the user."
            }
          }
        ]
      };
    }
  );

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
    allowedToolSet.has("list_context")
      ? "Use list_context to enumerate memories with filters and pagination."
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
