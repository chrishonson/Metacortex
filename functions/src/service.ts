import type { AppConfig } from "./config.js";
import type { EmbeddingClient } from "./embeddings.js";
import type {
  MemoryDocument,
  SearchContextInput,
  SearchContextResult,
  StoreContextInput,
  StoreContextResult
} from "./types.js";
import type { MemoryRepository } from "./memoryRepository.js";

export class OpenBrainService {
  constructor(
    private readonly embeddings: EmbeddingClient,
    private readonly repository: MemoryRepository,
    private readonly config: Pick<AppConfig, "defaultFilterState" | "topK">
  ) {}

  async storeContext(input: StoreContextInput): Promise<StoreContextResult> {
    const normalizedContent = normalizeRequiredText(input.content, "content");
    const normalizedModule = normalizeRequiredText(input.module_name, "module_name");
    const embedding = await this.embeddings.embed(normalizedContent);

    const metadata = {
      artifact_type: input.artifact_type,
      module_name: normalizedModule,
      branch_state: input.branch_state,
      timestamp: Date.now()
    } as const;

    const result = await this.repository.store({
      content: normalizedContent,
      embedding,
      metadata
    });

    return {
      id: result.id,
      metadata
    };
  }

  async searchContext(input: SearchContextInput): Promise<SearchContextResult> {
    const normalizedQuery = normalizeRequiredText(input.query, "query");
    const filterModule = normalizeOptionalText(input.filter_module);
    const filterState = input.filter_state ?? this.config.defaultFilterState;
    const queryVector = await this.embeddings.embed(normalizedQuery);
    const matches = await this.repository.search({
      queryVector,
      limit: this.config.topK,
      filterModule,
      filterState
    });

    return {
      matches,
      appliedFilters: {
        filter_module: filterModule,
        filter_state: filterState
      }
    };
  }
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${fieldName} must not be empty`);
  }

  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function formatSearchResults(result: SearchContextResult): string {
  if (result.matches.length === 0) {
    return "No matching context found.";
  }

  return result.matches
    .map((match: MemoryDocument, index) => {
      const header = [
        `Result ${index + 1}`,
        match.metadata.artifact_type,
        match.metadata.module_name,
        match.metadata.branch_state,
        new Date(match.metadata.timestamp).toISOString()
      ].join(" | ");

      return `${header}\n${match.content}`;
    })
    .join("\n\n");
}
