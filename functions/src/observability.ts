import { randomUUID } from "node:crypto";

import { Firestore } from "firebase-admin/firestore";

import type { McpToolName } from "./types.js";

export const MEMORY_EVENT_COLLECTION = "memory_events";

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
  latency_ms?: number;
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  error?: ToolCallEventError;
}

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
    const event: ToolCallEvent = {
      event_id: randomUUID(),
      event_type: "tool_call",
      timestamp: input.timestamp ?? Date.now(),
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

    await this.persist("metaCortexMcp tool event", event);
  }

  async recordRequest(input: RecordRequestEventInput): Promise<void> {
    const event: RequestEvent = {
      event_id: randomUUID(),
      event_type: "request",
      timestamp: input.timestamp ?? Date.now(),
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

    await this.persist("metaCortexMcp request event", event);
  }

  private async persist(message: string, event: ObservabilityEvent): Promise<void> {
    console.info(message, event);

    try {
      await this.firestore
        .collection(this.collectionName)
        .doc(event.event_id)
        .set(event);
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
