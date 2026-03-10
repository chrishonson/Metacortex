import { BRANCH_STATES, type BranchState } from "./types.js";

export interface AppConfig {
  serviceName: string;
  serviceVersion: string;
  authToken: string;
  openAiApiKey: string;
  openAiBaseUrl?: string;
  embeddingModel: string;
  embeddingDimensions: number;
  memoryCollection: string;
  topK: number;
  defaultFilterState: BranchState;
}

export class MissingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingConfigurationError";
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new MissingConfigurationError(
      `Missing required environment variable: ${key}`
    );
  }

  return value;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  key: string
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new MissingConfigurationError(
      `${key} must be a positive integer when provided`
    );
  }

  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const defaultFilterState = env.DEFAULT_FILTER_STATE ?? "active";

  if (!BRANCH_STATES.includes(defaultFilterState as BranchState)) {
    throw new MissingConfigurationError(
      `DEFAULT_FILTER_STATE must be one of: ${BRANCH_STATES.join(", ")}`
    );
  }

  return {
    serviceName: env.SERVICE_NAME ?? "firebase-open-brain",
    serviceVersion: env.SERVICE_VERSION ?? "0.1.0",
    authToken: requireEnv(env, "MCP_AUTH_TOKEN"),
    openAiApiKey: requireEnv(env, "OPENAI_API_KEY"),
    openAiBaseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
    embeddingModel: env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    embeddingDimensions: parsePositiveInteger(
      env.OPENAI_EMBEDDING_DIMENSIONS,
      1536,
      "OPENAI_EMBEDDING_DIMENSIONS"
    ),
    memoryCollection: env.MEMORY_COLLECTION?.trim() || "memory_vectors",
    topK: parsePositiveInteger(env.SEARCH_RESULT_LIMIT, 5, "SEARCH_RESULT_LIMIT"),
    defaultFilterState: defaultFilterState as BranchState
  };
}
