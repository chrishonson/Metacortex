import type { AppConfig } from "./config.js";
import type {
  EmbeddingClient,
  MemoryContentPreparer
} from "./embeddings.js";
import { HttpError } from "./errors.js";
import type {
  ConsolidationQueueInput,
  ConsolidationQueueResult,
  DeprecateContextInput,
  DeprecateContextResult,
  MemoryDocument,
  SearchContextInput,
  SearchContextResult,
  StoreContextInput,
  StoreContextResult
} from "./types.js";
import type { MemoryRepository } from "./memoryRepository.js";

export class OpenBrainService {
  constructor(
    private readonly contentPreparer: MemoryContentPreparer,
    private readonly embeddings: EmbeddingClient,
    private readonly repository: MemoryRepository,
    private readonly config: Pick<AppConfig, "defaultFilterState" | "topK">
  ) {}

  async storeContext(input: StoreContextInput): Promise<StoreContextResult> {
    const normalizedModule = normalizeRequiredText(input.module_name, "module_name");
    const preparedContent = await this.contentPreparer.prepare({
      content: normalizeOptionalText(input.content),
      artifactType: input.artifact_type,
      moduleName: normalizedModule,
      imageBase64: normalizeOptionalText(input.image_base64),
      imageMimeType: normalizeOptionalText(input.image_mime_type)
    });
    const embedding = await this.embeddings.embed({
      text: preparedContent.content,
      taskType: "RETRIEVAL_DOCUMENT",
      title: `${input.artifact_type} ${normalizedModule}`
    });

    const metadata = {
      artifact_type: input.artifact_type,
      module_name: normalizedModule,
      branch_state: input.branch_state,
      timestamp: Date.now(),
      modality: preparedContent.modality,
      ...(input.artifact_refs && input.artifact_refs.length > 0
        ? { artifact_refs: input.artifact_refs }
        : {})
    } as const;

    const result = await this.repository.store({
      content: preparedContent.content,
      embedding,
      metadata,
      media: preparedContent.media
    });

    return {
      id: result.id,
      metadata,
      media: preparedContent.media
    };
  }

  async searchContext(input: SearchContextInput): Promise<SearchContextResult> {
    const normalizedQuery = normalizeRequiredText(input.query, "query");
    const filterModule = normalizeOptionalText(input.filter_module);
    const filterState = input.filter_state ?? this.config.defaultFilterState;
    const queryVector = await this.embeddings.embed({
      text: normalizedQuery,
      taskType: "RETRIEVAL_QUERY"
    });
    const matches = await this.repository.search({
      queryVector,
      limit: input.limit ?? this.config.topK,
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

  async deprecateContext(input: DeprecateContextInput): Promise<DeprecateContextResult> {
    const { previousState } = await this.repository.deprecate(
      input.document_id,
      input.superseding_document_id
    );

    return {
      document_id: input.document_id,
      superseding_document_id: input.superseding_document_id,
      previous_state: previousState
    };
  }

  async getConsolidationQueue(
    input: ConsolidationQueueInput
  ): Promise<ConsolidationQueueResult> {
    const filterModule = normalizeOptionalText(input.module_name);
    const items = await this.repository.getConsolidationQueue(filterModule);

    return {
      items: items.map(doc => ({
        id: doc.id,
        content: doc.content,
        metadata: doc.metadata
      })),
      filter_module: filterModule
    };
  }
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new HttpError(400, `${fieldName} must not be empty`);
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
        match.metadata.modality,
        new Date(match.metadata.timestamp).toISOString()
      ].join(" | ");

      const mediaLine = match.media
        ? `media=${match.media.kind}:${match.media.mime_type}\n`
        : "";
      const artifactRefsLine =
        match.metadata.artifact_refs && match.metadata.artifact_refs.length > 0
          ? `artifact_refs=${match.metadata.artifact_refs.join(",")}\n`
          : "";

      return `${header}\n${mediaLine}${artifactRefsLine}${match.content}`;
    })
    .join("\n\n");
}
