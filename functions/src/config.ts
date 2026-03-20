import {
  BRANCH_STATES,
  MCP_TOOL_NAMES,
  type BranchState,
  type McpToolName
} from "./types.js";

export interface ClientProfile {
  id: string;
  authToken: string;
  allowedOrigins: string[];
  allowedTools: McpToolName[];
  allowedFilterStates: BranchState[];
}

export interface AppConfig {
  serviceName: string;
  serviceVersion: string;
  authToken: string;
  geminiApiKey: string;
  embeddingModel: string;
  multimodalModel: string;
  embeddingDimensions: number;
  memoryCollection: string;
  topK: number;
  defaultFilterState: BranchState;
  defaultClientProfile: ClientProfile;
  clientProfiles: ClientProfile[];
  maxSseSessions: number;
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

function parseStringList(value: string | undefined): string[] {
  return value
    ?.split(",")
    .map(item => item.trim())
    .filter(Boolean) ?? [];
}

function parseToolList(
  value: string[] | undefined,
  key: string,
  fallback: readonly McpToolName[] = MCP_TOOL_NAMES
): McpToolName[] {
  const items = value && value.length > 0 ? value : [...fallback];

  if (items.length === 0) {
    throw new MissingConfigurationError(`${key} must include at least one tool`);
  }

  const normalized = items.map(item => item.trim()).filter(Boolean);

  for (const item of normalized) {
    if (!MCP_TOOL_NAMES.includes(item as McpToolName)) {
      throw new MissingConfigurationError(
        `${key} contains unsupported tool: ${item}`
      );
    }
  }

  return [...new Set(normalized as McpToolName[])];
}

function parseBranchStateList(
  value: string[] | undefined,
  key: string,
  fallback: readonly BranchState[]
): BranchState[] {
  const items = value && value.length > 0 ? value : [...fallback];

  if (items.length === 0) {
    throw new MissingConfigurationError(
      `${key} must include at least one branch state`
    );
  }

  const normalized = items.map(item => item.trim()).filter(Boolean);

  for (const item of normalized) {
    if (!BRANCH_STATES.includes(item as BranchState)) {
      throw new MissingConfigurationError(
        `${key} contains unsupported branch state: ${item}`
      );
    }
  }

  return [...new Set(normalized as BranchState[])];
}

function parseClientProfiles(
  value: string | undefined,
  defaultFilterState: BranchState
): ClientProfile[] {
  if (!value?.trim()) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MissingConfigurationError(
      "MCP_CLIENT_PROFILES_JSON must be valid JSON"
    );
  }

  if (!Array.isArray(parsed)) {
    throw new MissingConfigurationError(
      "MCP_CLIENT_PROFILES_JSON must be a JSON array"
    );
  }

  const ids = new Set<string>();

  return parsed.map((profile, index) => {
    if (!profile || typeof profile !== "object") {
      throw new MissingConfigurationError(
        `MCP_CLIENT_PROFILES_JSON[${index}] must be an object`
      );
    }

    const candidate = profile as Record<string, unknown>;
    const id =
      typeof candidate.id === "string" ? candidate.id.trim() : "";
    const authToken =
      typeof candidate.token === "string" ? candidate.token.trim() : "";

    if (!id) {
      throw new MissingConfigurationError(
        `MCP_CLIENT_PROFILES_JSON[${index}].id is required`
      );
    }

    if (id === "default") {
      throw new MissingConfigurationError(
        "MCP_CLIENT_PROFILES_JSON cannot reuse the reserved id 'default'"
      );
    }

    if (ids.has(id)) {
      throw new MissingConfigurationError(
        `MCP_CLIENT_PROFILES_JSON contains duplicate id: ${id}`
      );
    }

    if (!authToken) {
      throw new MissingConfigurationError(
        `MCP_CLIENT_PROFILES_JSON[${index}].token is required`
      );
    }

    ids.add(id);

    const allowedOrigins = Array.isArray(candidate.allowedOrigins)
      ? candidate.allowedOrigins
          .filter((origin): origin is string => typeof origin === "string")
          .map(origin => origin.trim())
          .filter(Boolean)
      : [];

    if (!Array.isArray(candidate.allowedTools)) {
      throw new MissingConfigurationError(
        `MCP_CLIENT_PROFILES_JSON[${index}].allowedTools is required`
      );
    }

    const allowedTools = parseToolList(
      candidate.allowedTools.filter(
        (tool): tool is string => typeof tool === "string"
      ),
      `MCP_CLIENT_PROFILES_JSON[${index}].allowedTools`
    );
    const allowedFilterStates = parseBranchStateList(
      Array.isArray(candidate.allowedFilterStates)
        ? candidate.allowedFilterStates.filter(
            (state): state is string => typeof state === "string"
          )
        : undefined,
      `MCP_CLIENT_PROFILES_JSON[${index}].allowedFilterStates`,
      allowedTools.includes("search_context")
        ? [defaultFilterState]
        : [defaultFilterState]
    );

    return {
      id,
      authToken,
      allowedOrigins: [...new Set(allowedOrigins)],
      allowedTools,
      allowedFilterStates
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const defaultFilterState = env.DEFAULT_FILTER_STATE ?? "active";

  if (!BRANCH_STATES.includes(defaultFilterState as BranchState)) {
    throw new MissingConfigurationError(
      `DEFAULT_FILTER_STATE must be one of: ${BRANCH_STATES.join(", ")}`
    );
  }

  const authToken = requireEnv(env, "MCP_ADMIN_TOKEN");
  const defaultClientProfile: ClientProfile = {
    id: "default",
    authToken,
    allowedOrigins: parseStringList(env.MCP_ALLOWED_ORIGINS),
    allowedTools: parseToolList(
      parseStringList(env.MCP_ALLOWED_TOOLS),
      "MCP_ALLOWED_TOOLS"
    ),
    allowedFilterStates: parseBranchStateList(
      parseStringList(env.MCP_ALLOWED_FILTER_STATES),
      "MCP_ALLOWED_FILTER_STATES",
      BRANCH_STATES
    )
  };
  const clientProfiles = parseClientProfiles(
    env.MCP_CLIENT_PROFILES_JSON,
    defaultFilterState as BranchState
  );

  return {
    serviceName: env.SERVICE_NAME ?? "firebase-open-brain",
    serviceVersion: env.SERVICE_VERSION ?? "0.1.0",
    authToken,
    geminiApiKey: requireEnv(env, "GEMINI_API_KEY"),
    embeddingModel: env.GEMINI_EMBEDDING_MODEL?.trim() || "text-embedding-004",
    multimodalModel:
      env.GEMINI_MULTIMODAL_MODEL?.trim() || "gemini-3.1-flash-lite-preview",
    embeddingDimensions: parsePositiveInteger(
      env.GEMINI_EMBEDDING_DIMENSIONS,
      768,
      "GEMINI_EMBEDDING_DIMENSIONS"
    ),
    memoryCollection: env.MEMORY_COLLECTION?.trim() || "memory_vectors",
    topK: parsePositiveInteger(env.SEARCH_RESULT_LIMIT, 5, "SEARCH_RESULT_LIMIT"),
    defaultFilterState: defaultFilterState as BranchState,
    defaultClientProfile,
    clientProfiles,
    maxSseSessions: parsePositiveInteger(
      env.MAX_SSE_SESSIONS,
      25,
      "MAX_SSE_SESSIONS"
    )
  };
}
