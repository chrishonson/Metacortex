export const ARTIFACT_TYPES = [
  "SPEC",
  "DECISION",
  "PATTERN",
  "REQUIREMENT"
] as const;

export const MCP_TOOL_NAMES = [
  "remember_context",
  "store_context",
  "search_context",
  "fetch_context",
  "deprecate_context",
  "get_consolidation_queue"
] as const;

export const BRANCH_STATES = [
  "active",
  "merged",
  "deprecated",
  "wip"
] as const;

export const MEMORY_MODALITIES = [
  "text",
  "image",
  "mixed"
] as const;

export const REMEMBER_MEMORY_TYPES = [
  "decision",
  "requirement",
  "pattern",
  "spec",
  "preference",
  "general"
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type BranchState = (typeof BRANCH_STATES)[number];
export type MemoryModality = (typeof MEMORY_MODALITIES)[number];
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
export type RememberMemoryType = (typeof REMEMBER_MEMORY_TYPES)[number];

export interface MemoryMedia {
  kind: "inline_image";
  mime_type: string;
}

export interface MemoryMetadata {
  artifact_type: ArtifactType;
  memory_type: RememberMemoryType;
  module_name: string;
  branch_state: BranchState;
  created_at: number;
  updated_at: number;
  modality: MemoryModality;
  artifact_refs?: string[];
  superseded_by?: string;
}

export interface MemoryDocument {
  id: string;
  content: string;
  retrieval_text: string;
  metadata: MemoryMetadata;
  media?: MemoryMedia;
  distance?: number;
}

export interface StoreContextInput {
  content?: string;
  artifact_type: ArtifactType;
  memory_type?: RememberMemoryType;
  module_name: string;
  branch_state: BranchState;
  artifact_refs?: string[];
  image_base64?: string;
  image_mime_type?: string;
}

export interface SearchContextInput {
  query: string;
  filter_module?: string;
  filter_state?: BranchState;
  limit?: number;
}

export interface RememberContextInput {
  content?: string;
  topic?: string;
  memory_type?: RememberMemoryType;
  draft?: boolean;
  artifact_refs?: string[];
  image_base64?: string;
  image_mime_type?: string;
}

export interface StoreContextResult {
  id: string;
  content: string;
  retrieval_text: string;
  metadata: MemoryMetadata;
  media?: MemoryMedia;
  was_duplicate: boolean;
}

export interface SearchContextResult {
  matches: MemoryDocument[];
  appliedFilters: {
    filter_module?: string;
    filter_state: BranchState;
  };
}

export interface FetchContextInput {
  document_id: string;
}

export interface FetchContextResult {
  item: MemoryDocument;
}

export interface DeprecateContextInput {
  document_id: string;
  superseding_document_id: string;
}

export interface DeprecateContextResult {
  document_id: string;
  superseding_document_id: string;
  previous_state: BranchState;
}

export interface ConsolidationQueueInput {
  module_name?: string;
}

export interface ConsolidationQueueItem {
  id: string;
  content: string;
  metadata: MemoryMetadata;
}

export interface ConsolidationQueueResult {
  items: ConsolidationQueueItem[];
  filter_module?: string;
}
