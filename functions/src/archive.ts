import type { EmbeddingClient } from "./embeddings.js";
import type { MemoryMedia, MemoryMetadata } from "./types.js";

export const ARCHIVE_SCHEMA_VERSION = 1;

export interface ArchivedMemory {
  id: string;
  content: string;
  retrieval_text: string;
  metadata: MemoryMetadata;
  media?: MemoryMedia;
}

const MEMORY_KEY_ORDER = [
  "id",
  "content",
  "retrieval_text",
  "metadata",
  "media"
] as const;

const METADATA_KEY_ORDER = [
  "module_name",
  "branch_state",
  "created_at",
  "updated_at",
  "modality",
  "artifact_refs",
  "superseded_by",
  "valid_from",
  "valid_until",
  "supersession_reason",
  "initiator",
  "provenance"
] as const;

const PROVENANCE_KEY_ORDER = [
  "origin",
  "source_session",
  "derived_from",
  "confidence"
] as const;

const MEDIA_KEY_ORDER = ["kind", "mime_type"] as const;

function orderKeys(
  source: Record<string, unknown>,
  keyOrder: readonly string[]
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};

  for (const key of keyOrder) {
    if (typeof source[key] !== "undefined" && source[key] !== null) {
      ordered[key] = source[key];
    }
  }

  return ordered;
}

export function canonicalizeArchivedMemory(
  memory: ArchivedMemory
): Record<string, unknown> {
  const metadata = orderKeys(
    memory.metadata as unknown as Record<string, unknown>,
    METADATA_KEY_ORDER
  );

  if (memory.metadata.provenance) {
    metadata.provenance = orderKeys(
      memory.metadata.provenance as unknown as Record<string, unknown>,
      PROVENANCE_KEY_ORDER
    );
  }

  const canonical = orderKeys(
    memory as unknown as Record<string, unknown>,
    MEMORY_KEY_ORDER
  );

  canonical.metadata = metadata;

  if (memory.media) {
    canonical.media = orderKeys(
      memory.media as unknown as Record<string, unknown>,
      MEDIA_KEY_ORDER
    );
  }

  return canonical;
}

export function serializeArchive(memories: readonly ArchivedMemory[]): string {
  const sorted = [...memories].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );

  return sorted
    .map(memory => JSON.stringify(canonicalizeArchivedMemory(memory)))
    .map(line => `${line}\n`)
    .join("");
}

export function parseArchive(ndjson: string): ArchivedMemory[] {
  const memories: ArchivedMemory[] = [];
  const lines = ndjson.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      continue;
    }

    try {
      memories.push(JSON.parse(line) as ArchivedMemory);
    } catch {
      throw new Error(`archive is malformed at line ${index + 1}`);
    }
  }

  return memories;
}

const TRUNCATION_TOLERANCE = 0.9;

export interface ArchiveManifest {
  generated_at: number;
  project_id: string;
  collection: string;
  document_count: number;
  state_histogram: Record<string, number>;
  embedding_model: string;
  embedding_dimensions: number;
  schema_version: number;
}

export interface BuildManifestParams {
  memories: readonly ArchivedMemory[];
  generatedAt: number;
  projectId: string;
  collection: string;
  embeddingModel: string;
  embeddingDimensions: number;
}

export function buildManifest(params: BuildManifestParams): ArchiveManifest {
  const tally = new Map<string, number>();

  for (const memory of params.memories) {
    const state = memory.metadata.branch_state;
    tally.set(state, (tally.get(state) ?? 0) + 1);
  }

  const stateHistogram: Record<string, number> = {};

  for (const state of [...tally.keys()].sort()) {
    stateHistogram[state] = tally.get(state)!;
  }

  return {
    generated_at: params.generatedAt,
    project_id: params.projectId,
    collection: params.collection,
    document_count: params.memories.length,
    state_histogram: stateHistogram,
    embedding_model: params.embeddingModel,
    embedding_dimensions: params.embeddingDimensions,
    schema_version: ARCHIVE_SCHEMA_VERSION
  };
}

export interface TruncationVerdict {
  allowed: boolean;
  reason?: string;
}

export function checkTruncation(
  previousCount: number | undefined,
  nextCount: number
): TruncationVerdict {
  if (typeof previousCount !== "number" || previousCount === 0) {
    return { allowed: true };
  }

  if (nextCount >= previousCount * TRUNCATION_TOLERANCE) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason:
      `read ${nextCount} documents but the previous archive held ${previousCount}; ` +
      "a drop beyond 10% looks like a partial read. Re-run with --force if this is expected."
  };
}

export function describeEmbeddingMismatch(
  manifest: ArchiveManifest,
  current: { embeddingModel: string; embeddingDimensions: number }
): string | null {
  const differences: string[] = [];

  if (manifest.embedding_model !== current.embeddingModel) {
    differences.push(
      `model ${manifest.embedding_model} -> ${current.embeddingModel}`
    );
  }

  if (manifest.embedding_dimensions !== current.embeddingDimensions) {
    differences.push(
      `dimensions ${manifest.embedding_dimensions} -> ${current.embeddingDimensions}`
    );
  }

  if (differences.length === 0) {
    return null;
  }

  return (
    `archive was taken from a different vector space (${differences.join(", ")}); ` +
    "restored vectors will not match the archived ones"
  );
}

export interface RestoreTarget {
  writeMemory(memory: ArchivedMemory, embedding: number[]): Promise<void>;
}

export interface RestoreParams {
  memories: readonly ArchivedMemory[];
  embeddings: EmbeddingClient;
  target: RestoreTarget;
}

export interface RestoreResult {
  restored: number;
}

export async function restoreMemories(
  params: RestoreParams
): Promise<RestoreResult> {
  let restored = 0;

  for (const memory of params.memories) {
    const embedding = await params.embeddings.embed({
      text: memory.retrieval_text,
      taskType: "RETRIEVAL_DOCUMENT",
      title: memory.metadata.module_name
    });

    await params.target.writeMemory(memory, embedding);
    restored += 1;
  }

  return { restored };
}


