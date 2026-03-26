import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { normalizeOptionalText } from "./normalize.js";
import type { ToolCallObserver } from "./observability.js";
import {
  buildDeprecatePayload,
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
        .describe(
          "The stable memory id returned by remember_context or search_context."
        )
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
            .describe("Max results to return. Defaults to 5.")
        }
      },
      async args => {
        const requestedFilterState = args.filter_state ?? config.defaultFilterState;
        const requestSummary = {
          query_preview: truncateText(args.query),
          query_length: args.query.trim().length,
          filter_topic: normalizeOptionalText(args.filter_topic),
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
            filter_topic: searchResult.appliedFilters.filter_topic
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
          "Fetch one stored memory by id. Pass the id returned by remember_context or search_context.",
        inputSchema: fetchContextInputSchema
      },
      async args => {
        const requestSummary = {
          id: args.id
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
            id: fetched.item.id,
            topic: fetched.item.metadata.module_name,
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
          "Soft-delete an obsolete memory by setting its state to deprecated and recording which id supersedes it. The memory remains in the database for historical audits but vanishes from default active searches.",
        inputSchema: {
          id: z
            .string()
            .min(1)
            .describe("The id of the obsolete memory."),
          superseding_id: z
            .string()
            .min(1)
            .describe("The id of the new memory that replaces it.")
        }
      },
      async args => {
        const requestSummary = {
          id: args.id,
          superseding_id: args.superseding_id
        };
        const result = await observeToolCall(
          "deprecate_context",
          requestSummary,
          () => service.deprecateContext(args),
          record => ({
            id: record.id,
            superseding_id: record.superseding_id,
            previous_state: record.previous_state
          })
        );

        return {
          content: [jsonTextContent(buildDeprecatePayload(result))]
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
