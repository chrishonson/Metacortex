export const ARTIFACT_TYPES = [
  "SPEC",
  "DECISION",
  "PATTERN",
  "REQUIREMENT"
] as const;

export const MCP_TOOL_NAMES = [
  "store_context",
  "search_context",
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
  "text_image"
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type BranchState = (typeof BRANCH_STATES)[number];
export type MemoryModality = (typeof MEMORY_MODALITIES)[number];
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export interface MemoryMedia {
  kind: "inline_image";
  mime_type: string;
}

export interface MemoryMetadata {
  artifact_type: ArtifactType;
  module_name: string;
  branch_state: BranchState;
  timestamp: number;
  modality: MemoryModality;
  artifact_refs?: string[];
  superseded_by?: string;
}

export interface MemoryDocument {
  id: string;
  content: string;
  metadata: MemoryMetadata;
  media?: MemoryMedia;
  distance?: number;
}

export interface StoreContextInput {
  content?: string;
  artifact_type: ArtifactType;
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

export interface StoreContextResult {
  id: string;
  metadata: MemoryMetadata;
  media?: MemoryMedia;
}

export interface SearchContextResult {
  matches: MemoryDocument[];
  appliedFilters: {
    filter_module?: string;
    filter_state: BranchState;
  };
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
