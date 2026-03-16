import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { loadConfig, type AppConfig } from "./config.js";
import {
  GeminiEmbeddingClient,
  GeminiMultimodalPreparer,
  type EmbeddingClient,
  type MemoryContentPreparer
} from "./embeddings.js";
import {
  FirestoreToolCallObserver,
  type ToolCallObserver
} from "./observability.js";
import {
  FirestoreMemoryRepository,
  type MemoryRepository
} from "./memoryRepository.js";
import { OpenBrainService } from "./service.js";

export interface RuntimeDependencies {
  config: AppConfig;
  service: OpenBrainService;
  observer: ToolCallObserver;
}

let cachedConfig: AppConfig | undefined;
let cachedRuntime: RuntimeDependencies | undefined;
let cachedObserver: ToolCallObserver | undefined;

export function createRuntime(env: NodeJS.ProcessEnv = process.env): RuntimeDependencies {
  const config = loadConfig(env);
  return createRuntimeFromConfig(config);
}

function createRuntimeFromConfig(config: AppConfig): RuntimeDependencies {
  const app = getApps().length === 0 ? initializeApp() : getApp();
  const firestore = getFirestore(app);
  const embeddings: EmbeddingClient = new GeminiEmbeddingClient({
    apiKey: config.geminiApiKey,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions
  });
  const contentPreparer: MemoryContentPreparer = new GeminiMultimodalPreparer({
    apiKey: config.geminiApiKey,
    model: config.multimodalModel
  });
  const repository: MemoryRepository = new FirestoreMemoryRepository(
    firestore,
    config.memoryCollection
  );
  const observer = cachedObserver ?? new FirestoreToolCallObserver(firestore);
  cachedObserver = observer;
  const service = new OpenBrainService(
    contentPreparer,
    embeddings,
    repository,
    config
  );

  return {
    config,
    service,
    observer
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
    cachedRuntime = createRuntimeFromConfig(config);
  }

  return cachedRuntime;
}

export function getObserver(): ToolCallObserver {
  if (!cachedObserver) {
    const app = getApps().length === 0 ? initializeApp() : getApp();
    const firestore = getFirestore(app);
    cachedObserver = new FirestoreToolCallObserver(firestore);
  }

  return cachedObserver;
}
