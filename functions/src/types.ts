export const MCP_TOOL_NAMES = [
  "remember_context",
  "search_context",
  "fetch_context",
  "deprecate_context",
  "consolidate_context",
  "list_context"
] as const;

export const BRANCH_STATES = [
  "active",
  "merged",
  "deprecated",
  "wip"
] as const;

export const SUPERSESSION_REASONS = ["changed", "corrected"] as const;

export const PROVENANCE_ORIGINS = ["user_asserted", "agent_inferred", "legacy_import"] as const;

export const MEMORY_MODALITIES = [
  "text",
  "image",
  "mixed"
] as const;

export type BranchState = (typeof BRANCH_STATES)[number];
export type SupersessionReason = (typeof SUPERSESSION_REASONS)[number];
export type MemoryModality = (typeof MEMORY_MODALITIES)[number];
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
export type ProvenanceOrigin = (typeof PROVENANCE_ORIGINS)[number];

export interface MemoryMedia {
  kind: "inline_image";
  mime_type: string;
}

export interface MemoryProvenance {
  origin: ProvenanceOrigin;
  source_session?: string;
  derived_from?: string[];
  confidence?: number;
}

export interface MemoryMetadata {
  module_name: string;
  branch_state: BranchState;
  created_at: number;
  updated_at: number;
  modality: MemoryModality;
  artifact_refs?: string[];
  superseded_by?: string;
  valid_from?: number;
  valid_until?: number;
  supersession_reason?: SupersessionReason;
  initiator?: "user" | "agent";
  provenance?: MemoryProvenance;
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
  module_name: string;
  branch_state: BranchState;
  artifact_refs?: string[];
  image_base64?: string;
  image_mime_type?: string;
  valid_from?: number;
  valid_until?: number;
  origin?: ProvenanceOrigin;
  source_session?: string;
  derived_from?: string[];
  confidence?: number;
}

export interface SearchContextInput {
  query: string;
  filter_topic?: string;
  filter_state?: BranchState;
  limit?: number;
  valid_at?: number;
  filter_origin?: ProvenanceOrigin;
}

export interface RememberContextInput {
  content?: string;
  topic?: string;
  draft?: boolean;
  branch_state?: BranchState;
  artifact_refs?: string[];
  image_base64?: string;
  image_mime_type?: string;
  valid_from?: number;
  valid_until?: number;
  origin?: ProvenanceOrigin;
  source_session?: string;
  derived_from?: string[];
  confidence?: number;
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
    filter_topic?: string;
    filter_state: BranchState;
  };
}

export interface FetchContextInput {
  id?: string;
  document_id?: string;
}

export interface FetchContextResult {
  item: MemoryDocument;
}

export interface DeprecateContextInput {
  id: string;
  superseding_id: string;
  supersession_reason?: SupersessionReason;
  initiator?: "user" | "agent";
}

export interface DeprecateContextResult {
  id: string;
  superseding_id: string;
  previous_state: BranchState;
  supersession_reason: SupersessionReason;
}

export interface ConsolidationQueueInput {
  topic?: string;
}

export interface ConsolidationQueueItem {
  id: string;
  content: string;
  metadata: MemoryMetadata;
}

export interface ConsolidationQueueResult {
  items: ConsolidationQueueItem[];
  filter_topic?: string;
}

export interface ConsolidateContextInput {
  topic?: string;
  source_ids?: string[];
}

export interface ConsolidateContextResult {
  merged_id: string;
  merged_content: string;
  deprecated_ids: string[];
  topic: string;
  source_count: number;
}

export interface ListContextInput {
  filter_topic?: string;
  filter_state?: BranchState;
  filter_origin?: ProvenanceOrigin;
  created_after?: number;
  created_before?: number;
  limit?: number;
  cursor?: string;
}

export interface ListContextResult {
  items: {
    id: string;
    summary: string;
    metadata: MemoryMetadata;
  }[];
  next_cursor: string | null;
  applied_filters: {
    filter_topic?: string;
    filter_state: BranchState;
    filter_origin?: ProvenanceOrigin;
    created_after?: number;
    created_before?: number;
  };
}
