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

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type BranchState = (typeof BRANCH_STATES)[number];

export interface MemoryMetadata {
  artifact_type: ArtifactType;
  module_name: string;
  branch_state: BranchState;
  timestamp: number;
}

export interface MemoryDocument {
  id: string;
  content: string;
  metadata: MemoryMetadata;
  distance?: number;
}

export interface StoreContextInput {
  content: string;
  artifact_type: ArtifactType;
  module_name: string;
  branch_state: BranchState;
}

export interface SearchContextInput {
  query: string;
  filter_module?: string;
  filter_state?: BranchState;
}

export interface StoreContextResult {
  id: string;
  metadata: MemoryMetadata;
}

export interface SearchContextResult {
  matches: MemoryDocument[];
  appliedFilters: {
    filter_module?: string;
    filter_state: BranchState;
  };
}
