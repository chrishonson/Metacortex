import type { AppConfig } from "../../src/config.js";
import type {
  EmbeddingClient,
  EmbeddingRequest,
  MemoryContentPreparer,
  MemoryPreparationInput,
  PreparedMemoryContent
} from "../../src/embeddings.js";
import type {
  ObservabilityEvent,
  RecordToolCallEventInput,
  RecordRequestEventInput,
  ToolCallObserver
} from "../../src/observability.js";
import type {
  BranchState,
  MemoryDocument,
  MemoryMedia,
  MemoryMetadata
} from "../../src/types.js";
import { MCP_TOOL_NAMES } from "../../src/types.js";
import {
  MetaCortexService
} from "../../src/service.js";
import type {
  MemoryRepository,
  SearchMemoryParams,
  StoreMemoryParams
} from "../../src/memoryRepository.js";

interface StoredRecord {
  id: string;
  content: string;
  retrieval_text: string;
  embedding: number[];
  metadata: MemoryMetadata;
  media?: MemoryMedia;
}

export class KeywordEmbeddingClient implements EmbeddingClient {
  async embed(request: EmbeddingRequest): Promise<number[]> {
    const normalized = request.text.toLowerCase();

    return [
      includesAny(normalized, ["ktor", "network", "networking"]) ? 1 : 0,
      includesAny(normalized, ["compose", "ui"]) ? 1 : 0,
      includesAny(normalized, ["android"]) ? 1 : 0,
      includesAny(normalized, ["ios", "swift"]) ? 1 : 0,
      includesAny(normalized, ["firebase", "firestore"]) ? 1 : 0,
      includesAny(normalized, ["decision", "architecture", "diagram", "screenshot"])
        ? 1
        : 0
    ];
  }
}

export class FakeMemoryContentPreparer implements MemoryContentPreparer {
  async prepare(input: MemoryPreparationInput): Promise<PreparedMemoryContent> {
    const normalizedContent = input.content?.trim();

    if (!normalizedContent && !input.imageBase64) {
      throw new Error(
        "Either content or image_base64 must be provided."
      );
    }

    if (input.imageBase64 && !input.imageMimeType) {
      throw new Error(
        "image_mime_type is required when image_base64 is provided"
      );
    }

    if (!input.imageBase64) {
      return {
        content: normalizedContent!,
        retrieval_text: normalizedContent!,
        modality: "text"
      };
    }

    const imageSummary =
      `Architecture screenshot for ${input.moduleName}.`;

    return {
      content: normalizedContent ?? imageSummary,
      retrieval_text: [
        normalizedContent,
        `Visual memory summary:\n${imageSummary}`
      ]
        .filter(Boolean)
        .join("\n\n"),
      modality: normalizedContent ? "mixed" : "image",
      media: {
        kind: "inline_image",
        mime_type: input.imageMimeType!
      }
    };
  }
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private nextId = 1;
  private readonly records: StoredRecord[] = [];
  private readonly fingerprints = new Map<
    string,
    { documentId: string; expiresAt: number }
  >();

  async store(
    params: StoreMemoryParams
  ): Promise<{ document: MemoryDocument; created: boolean }> {
    const existing = this.fingerprints.get(params.idempotencyKey);

    if (existing && existing.expiresAt >= params.metadata.created_at) {
      const record = this.records.find(item => item.id === existing.documentId);

      if (record) {
        return {
          document: toMemoryDocument(record),
          created: false
        };
      }
    }

    const id = `memory-${this.nextId++}`;

    const record = {
      id,
      content: params.content,
      retrieval_text: params.retrievalText,
      embedding: [...params.embedding],
      metadata: params.metadata,
      media: params.media
    };

    this.records.push(record);
    this.fingerprints.set(params.idempotencyKey, {
      documentId: id,
      expiresAt: params.metadata.created_at + 15 * 60 * 1000
    });

    return {
      document: toMemoryDocument(record),
      created: true
    };
  }

  async search(params: SearchMemoryParams): Promise<MemoryDocument[]> {
    return this.records
      .filter(record => record.metadata.branch_state === params.filterState)
      .filter(record =>
        params.filterModule
          ? record.metadata.module_name === params.filterModule
          : true
      )
      .map(record => ({
        ...toMemoryDocument(record),
        distance: cosineDistance(record.embedding, params.queryVector)
      }))
      .sort((left, right) => (left.distance ?? 1) - (right.distance ?? 1))
      .slice(0, params.limit);
  }

  async get(documentId: string): Promise<MemoryDocument | null> {
    const record = this.records.find(r => r.id === documentId);

    if (!record) {
      return null;
    }

    return toMemoryDocument(record);
  }

  listRecords(): StoredRecord[] {
    return [...this.records];
  }

  async deprecate(
    documentId: string,
    supersedingDocumentId: string
  ): Promise<{ previousState: BranchState }> {
    const record = this.records.find(r => r.id === documentId);

    if (!record) {
      throw new Error(`Document ${documentId} not found`);
    }

    const previousState = record.metadata.branch_state;
    record.metadata = {
      ...record.metadata,
      branch_state: "deprecated",
      superseded_by: supersedingDocumentId,
      updated_at: Date.now()
    };

    return { previousState };
  }

  async getConsolidationQueue(moduleName?: string): Promise<MemoryDocument[]> {
    return this.records
      .filter(r => r.metadata.branch_state === "wip")
      .filter(r => (moduleName ? r.metadata.module_name === moduleName : true))
      .map(toMemoryDocument);
  }
}

export class InMemoryToolCallObserver implements ToolCallObserver {
  private nextId = 1;
  private readonly events: ObservabilityEvent[] = [];

  async record(input: RecordToolCallEventInput): Promise<void> {
    this.events.push({
      event_id: `event-${this.nextId++}`,
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
    });
  }

  async recordRequest(input: RecordRequestEventInput): Promise<void> {
    this.events.push({
      event_id: `event-${this.nextId++}`,
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
    });
  }

  listEvents(): ObservabilityEvent[] {
    return [...this.events];
  }
}

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const authToken = overrides.authToken ?? "test-token";
  const defaultClientProfile = {
    id: "default",
    authToken,
    allowedOrigins: [],
    allowedTools: [...MCP_TOOL_NAMES],
    allowedFilterStates: ["active", "merged", "deprecated", "wip"] as BranchState[]
  };

  return {
    serviceName: "metacortex",
    serviceVersion: "0.1.0-test",
    authToken,
    geminiApiKey: "test-gemini-key",
    embeddingModel: "text-embedding-004",
    multimodalModel: "gemini-3.1-flash-lite-preview",
    embeddingDimensions: 768,
    memoryCollection: "memory_vectors",
    topK: 5,
    defaultFilterState: "active",
    defaultClientProfile: overrides.defaultClientProfile ?? defaultClientProfile,
    clientProfiles: [],
    ...overrides
  };
}

export function createTestRuntime(overrides: Partial<AppConfig> = {}) {
  const config = createTestConfig(overrides);
  const repository = new InMemoryMemoryRepository();
  const observer = new InMemoryToolCallObserver();
  const contentPreparer = new FakeMemoryContentPreparer();
  const embeddings = new KeywordEmbeddingClient();
  const service = new MetaCortexService(
    contentPreparer,
    embeddings,
    repository,
    config
  );

  return {
    config,
    service,
    repository,
    observer
  };
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some(needle => value.includes(needle));
}

function toMemoryDocument(record: StoredRecord): MemoryDocument {
  return {
    id: record.id,
    content: record.content,
    retrieval_text: record.retrieval_text,
    metadata: record.metadata,
    media: record.media
  };
}

function cosineDistance(left: number[], right: number[]): number {
  const dotProduct = left.reduce((sum, value, index) => sum + value * right[index]!, 0);
  const leftMagnitude = Math.sqrt(
    left.reduce((sum, value) => sum + value * value, 0)
  );
  const rightMagnitude = Math.sqrt(
    right.reduce((sum, value) => sum + value * value, 0)
  );

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 1;
  }

  return 1 - dotProduct / (leftMagnitude * rightMagnitude);
}
