import type { AppConfig } from "../../src/config.js";
import type { EmbeddingClient } from "../../src/embeddings.js";
import type {
  MemoryDocument,
  MemoryMetadata
} from "../../src/types.js";
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
}

export class KeywordEmbeddingClient implements EmbeddingClient {
  async embed(text: string): Promise<number[]> {
    const normalized = text.toLowerCase();

    return [
      includesAny(normalized, ["ktor", "network", "networking"]) ? 1 : 0,
      includesAny(normalized, ["compose", "ui"]) ? 1 : 0,
      includesAny(normalized, ["android"]) ? 1 : 0,
      includesAny(normalized, ["ios", "swift"]) ? 1 : 0,
      includesAny(normalized, ["firebase", "firestore"]) ? 1 : 0,
      includesAny(normalized, ["decision", "architecture"]) ? 1 : 0
    ];
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
      metadata: params.metadata
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
        distance: cosineDistance(record.embedding, params.queryVector)
      }))
      .sort((left, right) => (left.distance ?? 1) - (right.distance ?? 1))
      .slice(0, params.limit);
  }

  listRecords(): StoredRecord[] {
    return [...this.records];
  }
}

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    serviceName: "firebase-open-brain",
    serviceVersion: "0.1.0-test",
    authToken: "test-token",
    openAiApiKey: "test-openai-key",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
    memoryCollection: "memory_vectors",
    topK: 5,
    defaultFilterState: "active",
    ...overrides
  };
}

export function createTestRuntime(overrides: Partial<AppConfig> = {}) {
  const config = createTestConfig(overrides);
  const repository = new InMemoryMemoryRepository();
  const embeddings = new KeywordEmbeddingClient();
  const service = new OpenBrainService(embeddings, repository, config);

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
