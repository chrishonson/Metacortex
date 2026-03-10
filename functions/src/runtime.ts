import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { loadConfig, type AppConfig } from "./config.js";
import {
  OpenAiEmbeddingClient,
  type EmbeddingClient
} from "./embeddings.js";
import {
  FirestoreMemoryRepository,
  type MemoryRepository
} from "./memoryRepository.js";
import { OpenBrainService } from "./service.js";

export interface RuntimeDependencies {
  config: AppConfig;
  service: OpenBrainService;
}

let cachedConfig: AppConfig | undefined;
let cachedRuntime: RuntimeDependencies | undefined;

export function createRuntime(env: NodeJS.ProcessEnv = process.env): RuntimeDependencies {
  const config = loadConfig(env);
  const app = getApps().length === 0 ? initializeApp() : getApp();
  const firestore = getFirestore(app);
  const embeddings: EmbeddingClient = new OpenAiEmbeddingClient({
    apiKey: config.openAiApiKey,
    baseUrl: config.openAiBaseUrl,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions
  });
  const repository: MemoryRepository = new FirestoreMemoryRepository(
    firestore,
    config.memoryCollection
  );
  const service = new OpenBrainService(embeddings, repository, config);

  return {
    config,
    service
  };
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }

  return cachedConfig;
}

export function getRuntime(): RuntimeDependencies {
  if (!cachedRuntime) {
    const config = getConfig();
    cachedRuntime = createRuntime({
      ...process.env,
      OPENAI_API_KEY: config.openAiApiKey,
      MCP_AUTH_TOKEN: config.authToken,
      OPENAI_BASE_URL: config.openAiBaseUrl,
      OPENAI_EMBEDDING_MODEL: config.embeddingModel,
      OPENAI_EMBEDDING_DIMENSIONS: String(config.embeddingDimensions),
      MEMORY_COLLECTION: config.memoryCollection,
      SEARCH_RESULT_LIMIT: String(config.topK),
      DEFAULT_FILTER_STATE: config.defaultFilterState,
      SERVICE_NAME: config.serviceName,
      SERVICE_VERSION: config.serviceVersion
    });
  }

  return cachedRuntime;
}
