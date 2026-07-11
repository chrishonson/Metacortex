import { createHash } from "node:crypto";

import type { AppConfig } from "./config.js";
import type {
  EmbeddingClient,
  MemoryContentPreparer
} from "./embeddings.js";
import { HttpError } from "./errors.js";
import type { LlmMergeClient } from "./merging.js";
import { normalizeOptionalText } from "./normalize.js";
import type {
  ConsolidateContextInput,
  ConsolidateContextResult,
  ConsolidationQueueInput,
  ConsolidationQueueResult,
  DeprecateContextInput,
  DeprecateContextResult,
  FetchContextInput,
  FetchContextResult,
  MemoryDocument,
  MemoryMetadata,
  RememberContextInput,
  SearchContextInput,
  SearchContextResult,
  StoreContextInput,
  StoreContextResult,
  SupersessionReason
} from "./types.js";
import type { MemoryRepository } from "./memoryRepository.js";

export class MetaCortexService {
  constructor(
    private readonly contentPreparer: MemoryContentPreparer,
    private readonly embeddings: EmbeddingClient,
    private readonly repository: MemoryRepository,
    private readonly config: Pick<AppConfig, "defaultFilterState" | "topK">,
    private readonly mergeClient: LlmMergeClient
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

    const provenance = {
      origin: input.origin ?? "agent_inferred",
      ...(input.source_session ? { source_session: input.source_session } : {}),
      ...(input.derived_from && input.derived_from.length > 0 ? { derived_from: input.derived_from } : {}),
      ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {})
    };

    const metadata = {
      module_name: normalizedModule,
      branch_state: input.branch_state,
      created_at: now,
      updated_at: now,
      modality: preparedContent.modality,
      ...(normalizedArtifactRefs.length > 0
        ? { artifact_refs: normalizedArtifactRefs }
        : {}),
      ...(typeof input.valid_from === "number"
        ? { valid_from: input.valid_from }
        : {}),
      ...(typeof input.valid_until === "number"
        ? { valid_until: input.valid_until }
        : {}),
      provenance
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
    const branchState = resolveRememberBranchState(input);

    return this.storeContext({
      content: normalizeOptionalText(input.content),
      module_name: normalizedTopic,
      branch_state: branchState,
      artifact_refs: input.artifact_refs,
      image_base64: normalizeOptionalText(input.image_base64),
      image_mime_type: normalizeOptionalText(input.image_mime_type),
      valid_from: input.valid_from,
      valid_until: input.valid_until,
      origin: input.origin,
      source_session: input.source_session,
      derived_from: input.derived_from,
      confidence: input.confidence
    });
  }

  async searchContext(input: SearchContextInput): Promise<SearchContextResult> {
    const normalizedQuery = normalizeRequiredText(input.query, "query");
    const filterTopic = normalizeOptionalText(input.filter_topic);
    const filterState = input.filter_state ?? this.config.defaultFilterState;
    const queryVector = await this.embeddings.embed({
      text: normalizedQuery,
      taskType: "RETRIEVAL_QUERY"
    });
    let matches = await this.repository.search({
      queryVector,
      limit: input.limit ?? this.config.topK,
      filterModule: filterTopic,
      filterState
    });

    if (typeof input.valid_at === "number") {
      matches = matches.filter(match => matchesValidAt(match.metadata, input.valid_at!));
    }

    if (input.filter_origin) {
      matches = matches.filter(match => match.metadata.provenance?.origin === input.filter_origin);
    }

    return {
      matches,
      appliedFilters: {
        filter_topic: filterTopic,
        filter_state: filterState
      }
    };
  }

  async fetchContext(input: FetchContextInput): Promise<FetchContextResult> {
    const id = resolveFetchContextId(input);
    const item = await this.repository.get(id);

    if (!item) {
      throw new HttpError(404, "Document not found");
    }

    return { item };
  }

  async deprecateContext(input: DeprecateContextInput): Promise<DeprecateContextResult> {
    const resolvedReason: SupersessionReason = input.supersession_reason ?? "changed";
    const { previousState } = await this.repository.deprecate(
      input.id,
      input.superseding_id,
      {
        supersessionReason: resolvedReason,
        initiator: input.initiator
      }
    );

    return {
      id: input.id,
      superseding_id: input.superseding_id,
      previous_state: previousState,
      supersession_reason: resolvedReason
    };
  }

  async getConsolidationQueue(
    input: ConsolidationQueueInput
  ): Promise<ConsolidationQueueResult> {
    const filterTopic = normalizeOptionalText(input.topic);
    const items = await this.repository.getConsolidationQueue(filterTopic);

    return {
      items: items.map(doc => ({
        id: doc.id,
        content: doc.content,
        metadata: doc.metadata
      })),
      filter_topic: filterTopic
    };
  }

  async consolidateContext(
    input: ConsolidateContextInput
  ): Promise<ConsolidateContextResult> {
    const topic = normalizeOptionalText(input.topic) ?? "general";

    let sources: Array<{ id: string; content: string }>;

    if (input.source_ids && input.source_ids.length > 0) {
      const uniqueSourceIds = [...new Set(input.source_ids)];
      const fetched = await Promise.all(
        uniqueSourceIds.map(id => this.repository.get(id))
      );

      for (const doc of fetched) {
        if (!doc) {
          throw new HttpError(404, "Document not found");
        }
      }

      sources = (fetched as NonNullable<(typeof fetched)[number]>[]).map(doc => ({
        id: doc.id,
        content: doc.content
      }));
    } else {
      const queue = await this.getConsolidationQueue({ topic });
      sources = queue.items.map(item => ({ id: item.id, content: item.content }));
    }

    if (sources.length < 2) {
      throw new HttpError(
        422,
        `At least 2 source memories are required for consolidation. Found: ${sources.length}.`
      );
    }

    const { mergedContent } = await this.mergeClient.merge({ topic, sources });

    const stored = await this.storeContext({
      content: mergedContent,
      module_name: topic,
      branch_state: "active"
    });

    await Promise.all(
      sources.map(source => this.repository.deprecate(source.id, stored.id))
    );

    return {
      merged_id: stored.id,
      merged_content: stored.content,
      deprecated_ids: sources.map(source => source.id),
      topic,
      source_count: sources.length
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

function resolveFetchContextId(input: FetchContextInput): string {
  const id = normalizeOptionalText(input.id);
  const documentId = normalizeOptionalText(input.document_id);

  if (id && documentId && id !== documentId) {
    throw new HttpError(400, "id and document_id must match when both are provided");
  }

  const resolved = id ?? documentId;

  if (!resolved) {
    throw new HttpError(400, "id or document_id must be provided");
  }

  return resolved;
}

export function buildSearchPayload(result: SearchContextResult): Record<string, unknown> {
  return {
    matches: result.matches.map(match => ({
      id: match.id,
      summary: summarizeMemoryContent(match.content),
      ...(typeof match.distance === "number"
        ? { score: distanceToScore(match.distance) }
        : {}),
      metadata: buildPublicMetadata(match)
    })),
    applied_filters: {
      filter_topic: result.appliedFilters.filter_topic ?? null,
      filter_state: result.appliedFilters.filter_state
    }
  };
}

export function buildFetchPayload(result: FetchContextResult): Record<string, unknown> {
  return {
    item: {
      id: result.item.id,
      content: result.item.content,
      metadata: buildPublicMetadata(result.item)
    }
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
      id: result.id,
      branch_state: "deprecated",
      superseded_by: result.superseding_id,
      supersession_reason: result.supersession_reason
    },
    previous_state: result.previous_state
  };
}

export function buildConsolidatePayload(
  result: ConsolidateContextResult
): Record<string, unknown> {
  return {
    item: {
      merged_id: result.merged_id,
      merged_content: result.merged_content,
      topic: result.topic,
      branch_state: "active"
    },
    deprecated_ids: result.deprecated_ids,
    source_count: result.source_count
  };
}

function resolveRememberBranchState(
  input: RememberContextInput
): StoreContextInput["branch_state"] {
  if (typeof input.draft !== "undefined" && typeof input.branch_state !== "undefined") {
    throw new HttpError(400, "Provide either draft or branch_state, not both");
  }

  if (!input.branch_state) {
    return input.draft ? "wip" : "active";
  }

  return input.branch_state;
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
    topic: match.metadata.module_name,
    branch_state: match.metadata.branch_state,
    modality: normalizePublicModality(match.metadata.modality),
    ...(match.metadata.artifact_refs
      ? { artifact_refs: match.metadata.artifact_refs }
      : {}),
    created_at: new Date(match.metadata.created_at).toISOString(),
    updated_at: new Date(match.metadata.updated_at).toISOString(),
    ...(typeof match.metadata.valid_from === "number"
      ? { valid_from: new Date(match.metadata.valid_from).toISOString() }
      : {}),
    ...(typeof match.metadata.valid_until === "number"
      ? { valid_until: new Date(match.metadata.valid_until).toISOString() }
      : {}),
    ...(match.metadata.supersession_reason
      ? { supersession_reason: match.metadata.supersession_reason }
      : {}),
    ...(match.metadata.initiator
      ? { initiator: match.metadata.initiator }
      : {}),
    ...(match.metadata.provenance
      ? { provenance: match.metadata.provenance }
      : {})
  };
}

function distanceToScore(distance: number): number {
  return Math.max(0, Number((1 - distance).toFixed(6)));
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

function matchesValidAt(metadata: MemoryMetadata, validAt: number): boolean {
  const validFromOk = typeof metadata.valid_from === "undefined" || metadata.valid_from <= validAt;
  const validUntilOk = typeof metadata.valid_until === "undefined" || metadata.valid_until > validAt;
  const reasonOk = metadata.supersession_reason !== "corrected";

  return validFromOk && validUntilOk && reasonOk;
}
