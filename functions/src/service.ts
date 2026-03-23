import { createHash } from "node:crypto";

import type { AppConfig } from "./config.js";
import type {
  EmbeddingClient,
  MemoryContentPreparer
} from "./embeddings.js";
import { HttpError } from "./errors.js";
import { normalizeOptionalText } from "./normalize.js";
import type {
  ConsolidationQueueInput,
  ConsolidationQueueResult,
  DeprecateContextInput,
  DeprecateContextResult,
  FetchContextInput,
  FetchContextResult,
  MemoryDocument,
  RememberContextInput,
  SearchContextInput,
  SearchContextResult,
  StoreContextInput,
  StoreContextResult
} from "./types.js";
import type { MemoryRepository } from "./memoryRepository.js";

export class MetaCortexService {
  constructor(
    private readonly contentPreparer: MemoryContentPreparer,
    private readonly embeddings: EmbeddingClient,
    private readonly repository: MemoryRepository,
    private readonly config: Pick<AppConfig, "defaultFilterState" | "topK">
  ) {}

  async storeContext(input: StoreContextInput): Promise<StoreContextResult> {
    const normalizedModule = normalizeRequiredText(input.module_name, "module_name");
    const normalizedContent = normalizeOptionalText(input.content);
    const normalizedImageBase64 = normalizeOptionalText(input.image_base64);
    const normalizedImageMimeType = normalizeOptionalText(input.image_mime_type);
    const normalizedArtifactRefs = normalizeArtifactRefs(input.artifact_refs);
    const preparedContent = await this.contentPreparer.prepare({
      content: normalizedContent,
      moduleName: normalizedModule,
      imageBase64: normalizedImageBase64,
      imageMimeType: normalizedImageMimeType
    });
    const embedding = await this.embeddings.embed({
      text: preparedContent.retrieval_text,
      taskType: "RETRIEVAL_DOCUMENT",
      title: normalizedModule
    });
    const now = Date.now();

    const metadata = {
      module_name: normalizedModule,
      branch_state: input.branch_state,
      created_at: now,
      updated_at: now,
      modality: preparedContent.modality,
      ...(normalizedArtifactRefs.length > 0
        ? { artifact_refs: normalizedArtifactRefs }
        : {})
    } as const;

    const result = await this.repository.store({
      content: preparedContent.content,
      retrievalText: preparedContent.retrieval_text,
      embedding,
      idempotencyKey: buildWriteFingerprint({
        moduleName: normalizedModule,
        branchState: input.branch_state,
        content: normalizedContent,
        imageBase64: normalizedImageBase64,
        imageMimeType: normalizedImageMimeType,
        artifactRefs: normalizedArtifactRefs
      }),
      metadata,
      media: preparedContent.media
    });

    return {
      id: result.document.id,
      content: result.document.content,
      retrieval_text: result.document.retrieval_text,
      metadata: result.document.metadata,
      media: result.document.media,
      was_duplicate: !result.created
    };
  }

  async rememberContext(input: RememberContextInput): Promise<StoreContextResult> {
    const normalizedTopic = normalizeOptionalText(input.topic) ?? "general";

    return this.storeContext({
      content: normalizeOptionalText(input.content),
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

export function buildSearchPayload(result: SearchContextResult): Record<string, unknown> {
  return {
    matches: result.matches.map(match => ({
      id: match.id,
      summary: summarizeMemoryContent(match.content),
      ...(typeof match.distance === "number"
        ? { score: distanceToScore(match.distance) }
        : {}),
      content_preview: previewMemoryContent(match.content),
      metadata: buildPublicMetadata(match)
    })),
    applied_filters: {
      filter_module: result.appliedFilters.filter_module ?? null,
      filter_state: result.appliedFilters.filter_state
    }
  };
}

export function buildFetchPayload(result: FetchContextResult): Record<string, unknown> {
  return {
    item: {
      id: result.item.id,
      content: result.item.content,
      retrieval_text: result.item.retrieval_text,
      metadata: buildPublicMetadata(result.item)
    }
  };
}

export function buildStorePayload(result: StoreContextResult): Record<string, unknown> {
  return {
    item: {
      id: result.id,
      content: result.content,
      retrieval_text: result.retrieval_text,
      metadata: buildPublicMetadata({
        metadata: result.metadata
      }),
      ...(result.media ? { media: result.media } : {})
    },
    write_status: result.was_duplicate ? "duplicate" : "created"
  };
}

export function buildRememberPayload(result: StoreContextResult): Record<string, unknown> {
  return {
    item: {
      id: result.id,
      content: result.content,
      metadata: buildPublicMetadata({
        metadata: result.metadata
      })
    },
    write_status: result.was_duplicate ? "duplicate" : "created"
  };
}

export function buildDeprecatePayload(
  result: DeprecateContextResult
): Record<string, unknown> {
  return {
    item: {
      id: result.document_id,
      branch_state: "deprecated",
      superseded_by: result.superseding_document_id
    },
    previous_state: result.previous_state
  };
}

export function buildConsolidationQueuePayload(
  result: ConsolidationQueueResult
): Record<string, unknown> {
  return {
    items: result.items.map(item => ({
      id: item.id,
      content: item.content,
      metadata: buildPublicMetadata({
        metadata: item.metadata
      })
    })),
    filter_module: result.filter_module ?? null,
    result_count: result.items.length
  };
}

function buildWriteFingerprint(input: {
  moduleName: string;
  branchState: StoreContextInput["branch_state"];
  content?: string;
  imageBase64?: string;
  imageMimeType?: string;
  artifactRefs: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        module_name: input.moduleName,
        branch_state: input.branchState,
        content: input.content ?? null,
        image_mime_type: input.imageMimeType ?? null,
        image_sha256: input.imageBase64
          ? createHash("sha256").update(input.imageBase64).digest("hex")
          : null,
        artifact_refs: input.artifactRefs
      })
    )
    .digest("hex");
}

function normalizeArtifactRefs(value: string[] | undefined): string[] {
  if (!value || value.length === 0) {
    return [];
  }

  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}

function summarizeMemoryContent(value: string, limit = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

function buildPublicMetadata(match: Pick<MemoryDocument, "metadata">): Record<string, unknown> {
  return {
    module_name: match.metadata.module_name,
    branch_state: match.metadata.branch_state,
    modality: normalizePublicModality(match.metadata.modality),
    ...(match.metadata.artifact_refs
      ? { artifact_refs: match.metadata.artifact_refs }
      : {}),
    created_at: new Date(match.metadata.created_at).toISOString(),
    updated_at: new Date(match.metadata.updated_at).toISOString()
  };
}

function distanceToScore(distance: number): number {
  return Math.max(0, Number((1 - distance).toFixed(6)));
}

function previewMemoryContent(value: string, limit = 400): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

function normalizePublicModality(value: string): "text" | "image" | "mixed" {
  if (value === "text_image") {
    return "mixed";
  }

  if (value === "text" || value === "image" || value === "mixed") {
    return value;
  }

  return "text";
}
