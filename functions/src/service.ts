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
  FetchContextInput,
  FetchContextResult,
  MemoryDocument,
  RememberContextInput,
  RememberMemoryType,
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

  async rememberContext(input: RememberContextInput): Promise<StoreContextResult> {
    const normalizedTopic = normalizeOptionalText(input.topic) ?? "general";
    const normalizedContent = normalizeOptionalText(input.content);
    const artifactType =
      input.memory_type
        ? rememberMemoryTypeToArtifactType(input.memory_type)
        : inferArtifactType(normalizedContent);

    return this.storeContext({
      content: normalizedContent,
      artifact_type: artifactType,
      module_name: normalizedTopic,
      branch_state: input.draft ? "wip" : "active",
      artifact_refs: input.artifact_refs,
      image_base64: normalizeOptionalText(input.image_base64),
      image_mime_type: normalizeOptionalText(input.image_mime_type)
    });
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

  async fetchContext(input: FetchContextInput): Promise<FetchContextResult> {
    const documentId = normalizeRequiredText(input.document_id, "document_id");
    const item = await this.repository.get(documentId);

    if (!item) {
      throw new HttpError(404, "Document not found");
    }

    return { item };
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

      const idLine = `id=${match.id}\n`;
      const mediaLine = match.media
        ? `media=${match.media.kind}:${match.media.mime_type}\n`
        : "";
      const artifactRefsLine =
        match.metadata.artifact_refs && match.metadata.artifact_refs.length > 0
          ? `artifact_refs=${match.metadata.artifact_refs.join(",")}\n`
          : "";

      return `${header}\n${idLine}${mediaLine}${artifactRefsLine}${match.content}`;
    })
    .join("\n\n");
}

export function formatFetchedContext(result: FetchContextResult): string {
  const { item } = result;
  const header = [
    `id=${item.id}`,
    `artifact_type=${item.metadata.artifact_type}`,
    `module_name=${item.metadata.module_name}`,
    `branch_state=${item.metadata.branch_state}`,
    `modality=${item.metadata.modality}`,
    `timestamp=${new Date(item.metadata.timestamp).toISOString()}`
  ];

  if (item.media) {
    header.push(`media=${item.media.kind}:${item.media.mime_type}`);
  }

  if (item.metadata.artifact_refs && item.metadata.artifact_refs.length > 0) {
    header.push(`artifact_refs=${item.metadata.artifact_refs.join(",")}`);
  }

  if (item.metadata.superseded_by) {
    header.push(`superseded_by=${item.metadata.superseded_by}`);
  }

  return `${header.join("\n")}\n\n${item.content}`;
}

function rememberMemoryTypeToArtifactType(memoryType: RememberMemoryType): StoreContextInput["artifact_type"] {
  switch (memoryType) {
    case "decision":
      return "DECISION";
    case "requirement":
      return "REQUIREMENT";
    case "pattern":
      return "PATTERN";
    case "spec":
      return "SPEC";
  }
}

function inferArtifactType(content: string | undefined): StoreContextInput["artifact_type"] {
  const normalized = content?.toLowerCase() ?? "";

  if (!normalized) {
    return "PATTERN";
  }

  if (
    includesAny(normalized, [
      "must ",
      "must\n",
      "must be",
      "should ",
      "needs to",
      "need to",
      "requirement",
      "required",
      "cannot ",
      "can't "
    ])
  ) {
    return "REQUIREMENT";
  }

  if (
    includesAny(normalized, [
      "pattern",
      "workflow",
      "playbook",
      "runbook",
      "how to",
      "recipe",
      "screenshot"
    ])
  ) {
    return "PATTERN";
  }

  if (
    includesAny(normalized, [
      "spec",
      "schema",
      "contract",
      "interface",
      "api shape",
      "documented"
    ])
  ) {
    return "SPEC";
  }

  return "DECISION";
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some(needle => value.includes(needle));
}
