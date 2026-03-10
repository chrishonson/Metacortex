export const ARTIFACT_TYPES = [
  "SPEC",
  "DECISION",
  "PATTERN",
  "REQUIREMENT"
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
  image_base64?: string;
  image_mime_type?: string;
}

export interface SearchContextInput {
  query: string;
  filter_module?: string;
  filter_state?: BranchState;
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
