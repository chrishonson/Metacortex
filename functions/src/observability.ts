import { randomUUID } from "node:crypto";

import { Firestore } from "firebase-admin/firestore";

import type { McpToolName } from "./types.js";

export const MEMORY_EVENT_COLLECTION = "memory_events";
export const RETRIEVAL_EVENT_COLLECTION = "retrieval_query_events";
const MEMORY_EVENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type RequestEventReason =
  | "origin_not_allowed"
  | "unauthorized";

export interface ToolCallEventError {
  name: string;
  message: string;
  status_code?: number;
}

export interface ToolCallEvent {
  event_id: string;
  event_type: "tool_call";
  client_id: string;
  tool_name: McpToolName;
  status: "success" | "error";
  timestamp: number;
  expires_at: Date;
  latency_ms?: number;
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  error?: ToolCallEventError;
}

export interface RankedRetrievalResult {
  id: string;
  rank: number;
  score?: number;
}

export interface SearchRetrievalEventInput {
  event_type: "search";
  memory_collection: string;
  query: string;
  filter_topic?: string;
  filter_state: string;
  limit: number;
  result_count?: number;
  results?: RankedRetrievalResult[];
}

export interface FetchRetrievalEventInput {
  event_type: "fetch";
  memory_collection: string;
  memory_id: string;
  found?: boolean;
}

export type RetrievalEventInput =
  | SearchRetrievalEventInput
  | FetchRetrievalEventInput;

interface RetrievalEventBase {
  event_id: string;
  tool_event_id: string;
  client_id: string;
  status: "success" | "error";
  timestamp: number;
  expires_at: Date;
  latency_ms?: number;
  memory_collection: string;
  error?: ToolCallEventError;
}

export type RetrievalEvent = RetrievalEventBase & RetrievalEventInput;

export interface RequestEvent {
  event_id: string;
  event_type: "request";
  client_id: string;
  method: string;
  path: string;
  status: "rejected";
  status_code: number;
  reason: RequestEventReason;
  timestamp: number;
  expires_at: Date;
  latency_ms?: number;
}

export type ObservabilityEvent = ToolCallEvent | RequestEvent;

export interface RecordToolCallEventInput {
  client_id: string;
  tool_name: McpToolName;
  status: "success" | "error";
  latency_ms?: number;
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  error?: ToolCallEventError;
  retrieval?: RetrievalEventInput;
  timestamp?: number;
}

export interface RecordRequestEventInput {
  client_id: string;
  method: string;
  path: string;
  status: "rejected";
  status_code: number;
  reason: RequestEventReason;
  latency_ms?: number;
  timestamp?: number;
}

export interface ToolCallObserver {
  record(input: RecordToolCallEventInput): Promise<void>;
  recordRequest(input: RecordRequestEventInput): Promise<void>;
}

export class FirestoreToolCallObserver implements ToolCallObserver {
  constructor(
    private readonly firestore: Firestore,
    private readonly collectionName: string = MEMORY_EVENT_COLLECTION
  ) {}

  async record(input: RecordToolCallEventInput): Promise<void> {
    const timestamp = input.timestamp ?? Date.now();
    const event: ToolCallEvent = {
      event_id: randomUUID(),
      event_type: "tool_call",
      timestamp,
      expires_at: new Date(timestamp + MEMORY_EVENT_TTL_MS),
      client_id: input.client_id,
      tool_name: input.tool_name,
      status: input.status,
      ...(typeof input.latency_ms === "number"
        ? { latency_ms: input.latency_ms }
        : {}),
      request: input.request,
      ...(input.response ? { response: input.response } : {}),
      ...(input.error ? { error: input.error } : {})
    };

    const writes = [
      this.persist("metaCortexMcp tool event", event, this.collectionName)
    ];

    if (input.retrieval) {
      const retrievalEvent: RetrievalEvent = {
        event_id: randomUUID(),
        tool_event_id: event.event_id,
        client_id: input.client_id,
        status: input.status,
        timestamp,
        expires_at: new Date(timestamp + MEMORY_EVENT_TTL_MS),
        ...(typeof input.latency_ms === "number"
          ? { latency_ms: input.latency_ms }
          : {}),
        ...input.retrieval,
        ...(input.error ? { error: input.error } : {})
      };
      writes.push(
        this.persist(
          "metaCortexMcp retrieval event",
          retrievalEvent,
          RETRIEVAL_EVENT_COLLECTION,
          false
        )
      );
    }

    await Promise.all(writes);
  }

  async recordRequest(input: RecordRequestEventInput): Promise<void> {
    const timestamp = input.timestamp ?? Date.now();
    const event: RequestEvent = {
      event_id: randomUUID(),
      event_type: "request",
      timestamp,
      expires_at: new Date(timestamp + MEMORY_EVENT_TTL_MS),
      client_id: input.client_id,
      method: input.method,
      path: input.path,
      status: input.status,
      status_code: input.status_code,
      reason: input.reason,
      ...(typeof input.latency_ms === "number"
        ? { latency_ms: input.latency_ms }
        : {})
    };

    await this.persist("metaCortexMcp request event", event, this.collectionName);
  }

  private async persist(
    message: string,
    event: ObservabilityEvent | RetrievalEvent,
    collectionName: string,
    logToConsole = true
  ): Promise<void> {
    const sanitizedEvent = stripUndefined(event) as ObservabilityEvent | RetrievalEvent;

    if (logToConsole) {
      console.info(message, sanitizedEvent);
    }

    try {
      await this.firestore
        .collection(collectionName)
        .doc(sanitizedEvent.event_id)
        .set(sanitizedEvent);
    } catch (error) {
      console.error("metaCortexMcp observability event persist failed", {
        event_id: event.event_id,
        event_type: event.event_type,
        client_id: event.client_id,
        ...("tool_name" in event ? { tool_name: event.tool_name } : {}),
        error: serializeUnknownError(error)
      });
    }
  }
}

function serializeUnknownError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    value: error
  };
}

function stripUndefined(value: unknown): unknown {
  if (typeof value === "undefined") {
    return undefined;
  }

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(item => stripUndefined(item))
      .filter(item => typeof item !== "undefined");
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, stripUndefined(item)] as const)
        .filter(([, item]) => typeof item !== "undefined")
    );
  }

  return value;
}
