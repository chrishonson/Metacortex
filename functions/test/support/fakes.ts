import type { AppConfig } from "../../src/config.js";
import type {
  EmbeddingClient,
  EmbeddingRequest,
  MemoryContentPreparer,
  MemoryPreparationInput,
  PreparedMemoryContent
} from "../../src/embeddings.js";
import type {
  BranchState,
  MemoryDocument,
  MemoryMedia,
  MemoryMetadata
} from "../../src/types.js";
import { MCP_TOOL_NAMES } from "../../src/types.js";
import {
  OpenBrainService
} from "../../src/service.js";
import type {
  MemoryRepository,
  SearchMemoryParams,
  StoreMemoryParams
} from "../../src/memoryRepository.js";

interface StoredRecord {
  id: string;
  content: string;
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
        "Either content or image_base64 must be provided to store_context"
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
        modality: "text"
      };
    }

    return {
      content: [
        normalizedContent,
        `Visual memory summary:
Architecture screenshot for ${input.moduleName} with labels relevant to ${input.artifactType}.`
      ]
        .filter(Boolean)
        .join("\n\n"),
      modality: "text_image",
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

  async store(params: StoreMemoryParams): Promise<{ id: string }> {
    const id = `memory-${this.nextId++}`;

    this.records.push({
      id,
      content: params.content,
      embedding: [...params.embedding],
      metadata: params.metadata,
      media: params.media
    });

    return { id };
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
        id: record.id,
        content: record.content,
        metadata: record.metadata,
        media: record.media,
        distance: cosineDistance(record.embedding, params.queryVector)
      }))
      .sort((left, right) => (left.distance ?? 1) - (right.distance ?? 1))
      .slice(0, params.limit);
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
      superseded_by: supersedingDocumentId
    };

    return { previousState };
  }

  async getConsolidationQueue(moduleName?: string): Promise<MemoryDocument[]> {
    return this.records
      .filter(r => r.metadata.branch_state === "wip")
      .filter(r => (moduleName ? r.metadata.module_name === moduleName : true))
      .map(r => ({
        id: r.id,
        content: r.content,
        metadata: r.metadata,
        media: r.media
      }));
  }
}

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const authToken = overrides.authToken ?? "test-token";
  const defaultClientProfile = {
    id: "default",
    authToken,
    allowedOrigins: [],
    allowedTools: [...MCP_TOOL_NAMES],
    allowedFilterStates: ["active", "merged", "deprecated", "wip"] as const
  };

  return {
    serviceName: "firebase-open-brain",
    serviceVersion: "0.1.0-test",
    authToken,
    geminiApiKey: "test-gemini-key",
    embeddingModel: "text-multimodal-embedding-002",
    multimodalModel: "gemini-3.1-flash-lite-preview",
    embeddingDimensions: 768,
    memoryCollection: "memory_vectors",
    topK: 5,
    defaultFilterState: "active",
    defaultClientProfile: overrides.defaultClientProfile ?? defaultClientProfile,
    clientProfiles: [],
    maxSseSessions: 25,
    ...overrides
  };
}

export function createTestRuntime(overrides: Partial<AppConfig> = {}) {
  const config = createTestConfig(overrides);
  const repository = new InMemoryMemoryRepository();
  const contentPreparer = new FakeMemoryContentPreparer();
  const embeddings = new KeywordEmbeddingClient();
  const service = new OpenBrainService(
    contentPreparer,
    embeddings,
    repository,
    config
  );

  return {
    config,
    service,
    repository
  };
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some(needle => value.includes(needle));
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
