import { randomUUID } from "node:crypto";

import { Firestore } from "firebase-admin/firestore";

import type { McpToolName } from "./types.js";

export const MEMORY_EVENT_COLLECTION = "memory_events";

export interface ToolCallEventError {
  name: string;
  message: string;
  status_code?: number;
}

export interface ToolCallEvent {
  event_id: string;
  client_id: string;
  tool_name: McpToolName;
  status: "success" | "error";
  timestamp: number;
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  error?: ToolCallEventError;
}

export interface RecordToolCallEventInput {
  client_id: string;
  tool_name: McpToolName;
  status: "success" | "error";
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  error?: ToolCallEventError;
  timestamp?: number;
}

export interface ToolCallObserver {
  record(input: RecordToolCallEventInput): Promise<void>;
}

export class FirestoreToolCallObserver implements ToolCallObserver {
  constructor(
    private readonly firestore: Firestore,
    private readonly collectionName: string = MEMORY_EVENT_COLLECTION
  ) {}

  async record(input: RecordToolCallEventInput): Promise<void> {
    const event: ToolCallEvent = {
      event_id: randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
      client_id: input.client_id,
      tool_name: input.tool_name,
      status: input.status,
      request: input.request,
      ...(input.response ? { response: input.response } : {}),
      ...(input.error ? { error: input.error } : {})
    };

    console.info("openBrainMcp tool event", event);

    try {
      await this.firestore
        .collection(this.collectionName)
        .doc(event.event_id)
        .set(event);
    } catch (error) {
      console.error("openBrainMcp tool event persist failed", {
        event_id: event.event_id,
        client_id: event.client_id,
        tool_name: event.tool_name,
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
