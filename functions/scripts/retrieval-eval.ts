import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import {
  GeminiEmbeddingClient,
  GeminiMultimodalPreparer
} from "../src/embeddings.js";
import { FirestoreMemoryRepository } from "../src/memoryRepository.js";
import type { RetrievalEvent } from "../src/observability.js";
import {
  buildSyntheticEvalCases,
  computeRetrievalEvalMetrics,
  correlateImplicitFetches,
  FirestoreRetrievalEvalCaseStore,
  replaceRetrievalEvalCases,
  type RetrievalEvalCase,
  type RetrievalEvalObservation,
  type RetrievalEvalTargetMode,
  type SyntheticEvalDefinition
} from "../src/retrievalEvaluation.js";
import { MetaCortexService } from "../src/service.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const functionsDirectory = path.resolve(scriptDirectory, "..");
loadEnvironment(functionsDirectory);

const command = process.argv[2];
const cliArgs = process.argv.slice(3);
const projectId = readArg("project", process.env.GCLOUD_PROJECT ?? "my-brain-88870");
const evalMemoryCollection = readArg(
  "memory-collection",
  process.env.RETRIEVAL_EVAL_MEMORY_COLLECTION ?? "memory_vectors_eval"
);
const app = getApps().length === 0 ? initializeApp({ projectId }) : getApp();
const firestore = getFirestore(app);
const evalCaseStore = new FirestoreRetrievalEvalCaseStore(firestore);

async function main(): Promise<void> {
  switch (command) {
    case "generate-isolated":
      await generateIsolatedCorpus();
      break;
    case "import-production":
      await importProductionEvents();
      break;
    case "run":
      await runEvaluation();
      break;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

async function generateIsolatedCorpus(): Promise<void> {
  if (evalMemoryCollection === "memory_vectors") {
    throw new Error("The isolated eval corpus cannot use the production memory_vectors collection");
  }

  const service = createDirectService(evalMemoryCollection);
  await deleteCollection(evalMemoryCollection);
  await deleteCollection(`${evalMemoryCollection}_write_fingerprints`);

  const memoryIdsByKey = new Map<string, string>();

  for (const memory of SYNTHETIC_MEMORIES) {
    const stored = await service.rememberContext({
      content: memory.content,
      topic: memory.topic,
      branch_state: "active"
    });
    memoryIdsByKey.set(memory.key, stored.id);
  }

  const timestamp = Date.now();
  const cases = buildSyntheticEvalCases({
    definitions: SYNTHETIC_CASES,
    memoryIdsByKey,
    memoryCollection: evalMemoryCollection,
    timestamp
  });

  for (const evalCase of cases) {
    await service.searchContext(toSearchInput(evalCase));

    for (const positiveId of evalCase.positive_ids) {
      await service.fetchContext({ id: positiveId });
    }
  }

  await replaceRetrievalEvalCases(
    evalCaseStore,
    "isolated",
    "synthetic_flow",
    cases
  );
  console.log(
    JSON.stringify(
      {
        generated_cases: cases.length,
        seeded_memories: memoryIdsByKey.size,
        memory_collection: evalMemoryCollection
      },
      null,
      2
    )
  );
}

async function importProductionEvents(): Promise<void> {
  const lookbackHours = Number(readArg("lookback-hours", "168"));

  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error("--lookback-hours must be a positive number");
  }

  const since = Date.now() - lookbackHours * 60 * 60 * 1000;
  const snapshot = await firestore
    .collection("retrieval_query_events")
    .where("timestamp", ">=", since)
    .get();
  const events = snapshot.docs.map(document => document.data() as RetrievalEvent);
  const cases = correlateImplicitFetches(events);

  await replaceRetrievalEvalCases(
    evalCaseStore,
    "production",
    "observed_events",
    cases
  );
  console.log(
    JSON.stringify(
      {
        imported_cases: cases.length,
        scanned_events: events.length,
        lookback_hours: lookbackHours
      },
      null,
      2
    )
  );
}

async function runEvaluation(): Promise<void> {
  const mode = readArg("mode", "isolated") as RetrievalEvalTargetMode;

  if (mode !== "isolated" && mode !== "production") {
    throw new Error("--mode must be isolated or production");
  }

  const cases = await evalCaseStore.listCases(mode);

  if (cases.length === 0) {
    throw new Error(`No ${mode} retrieval eval cases exist`);
  }

  const observations = mode === "isolated"
    ? await runDirectCases(cases)
    : await runProductionCases(cases);
  const cutoffs = readArg("cutoffs", "1,5")
    .split(",")
    .map(value => Number(value.trim()));

  console.log(JSON.stringify(computeRetrievalEvalMetrics(observations, cutoffs), null, 2));
}

async function runDirectCases(
  cases: readonly RetrievalEvalCase[]
): Promise<RetrievalEvalObservation[]> {
  const collections = new Set(cases.map(evalCase => evalCase.memory_collection));

  if (collections.size !== 1) {
    throw new Error("Isolated eval cases must reference one memory collection");
  }

  const service = createDirectService(cases[0]!.memory_collection);
  const observations: RetrievalEvalObservation[] = [];

  for (const evalCase of cases) {
    const startedAt = performance.now();
    const result = await service.searchContext(toSearchInput(evalCase));
    observations.push({
      case_id: evalCase.case_id,
      positive_ids: evalCase.positive_ids,
      returned_ids: result.matches.map(match => match.id),
      latency_ms: performance.now() - startedAt
    });
  }

  return observations;
}

async function runProductionCases(
  cases: readonly RetrievalEvalCase[]
): Promise<RetrievalEvalObservation[]> {
  const url = readArg("url", process.env.MCP_BASE_URL);
  const token = readArg(
    "token",
    process.env.MCP_ADMIN_TOKEN ?? process.env.MCP_AUTH_TOKEN
  );

  if (!url || !token) {
    throw new Error("Production eval requires --url/MCP_BASE_URL and --token/MCP_ADMIN_TOKEN");
  }

  const client = new Client({ name: "metacortex-retrieval-eval", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  const observations: RetrievalEvalObservation[] = [];

  try {
    await client.connect(transport);

    for (const evalCase of cases) {
      const startedAt = performance.now();
      const result = await client.callTool({
        name: "search_context",
        arguments: toSearchInput(evalCase)
      });
      const latencyMs = performance.now() - startedAt;
      const payload = parseToolPayload(result);
      const matches = Array.isArray(payload.matches) ? payload.matches : [];
      observations.push({
        case_id: evalCase.case_id,
        positive_ids: evalCase.positive_ids,
        returned_ids: matches
          .map(match =>
            match && typeof match === "object" && typeof match.id === "string"
              ? match.id
              : undefined
          )
          .filter((id): id is string => Boolean(id)),
        latency_ms: latencyMs
      });
    }
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }

  return observations;
}

function createDirectService(memoryCollection: string): MetaCortexService {
  const config = loadConfig(process.env);
  const embeddings = new GeminiEmbeddingClient({
    vertexai: true,
    project: projectId,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions
  });
  const contentPreparer = new GeminiMultimodalPreparer({
    vertexai: true,
    project: projectId,
    location: config.generationVertexLocation,
    model: config.multimodalModel
  });
  const repository = new FirestoreMemoryRepository(firestore, memoryCollection);

  return new MetaCortexService(
    contentPreparer,
    embeddings,
    repository,
    config,
    {
      merge: async () => {
        throw new Error("Merge is unavailable in retrieval evaluation");
      }
    }
  );
}

function toSearchInput(evalCase: RetrievalEvalCase) {
  return {
    query: evalCase.query,
    filter_topic: evalCase.filters.filter_topic ?? undefined,
    filter_state: evalCase.filters.filter_state,
    limit: evalCase.limit
  };
}

function parseToolPayload(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    throw new Error("search_context returned an invalid MCP result");
  }

  const candidate = result as { isError?: boolean; content?: unknown };

  if (candidate.isError) {
    throw new Error("search_context returned an MCP error");
  }

  if (!Array.isArray(candidate.content)) {
    throw new Error("search_context returned no MCP content array");
  }

  const text = candidate.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        Boolean(
          item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string"
        )
    )
    .map(item => item.text)
    .join("\n");
  const payload: unknown = JSON.parse(text);

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("search_context returned a non-object payload");
  }

  const objectPayload = payload as Record<string, unknown>;

  if (objectPayload.error) {
    throw new Error(
      `search_context returned an error: ${JSON.stringify(objectPayload.error)}`
    );
  }

  return objectPayload;
}

async function deleteCollection(collectionName: string): Promise<void> {
  while (true) {
    const snapshot = await firestore.collection(collectionName).limit(450).get();

    if (snapshot.empty) {
      return;
    }

    const batch = firestore.batch();

    for (const document of snapshot.docs) {
      batch.delete(document.ref);
    }

    await batch.commit();
  }
}

function readArg(name: string, fallback?: string): string {
  const index = cliArgs.indexOf(`--${name}`);
  return index === -1 ? fallback ?? "" : cliArgs[index + 1] ?? fallback ?? "";
}

function loadEnvironment(directory: string): void {
  const explicitlySet = new Set(Object.keys(process.env));

  for (const fileName of [".env", ".env.prod"]) {
    const filePath = path.join(directory, fileName);

    if (!fs.existsSync(filePath)) {
      continue;
    }

    for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const separator = line.indexOf("=");

      if (separator === -1) {
        continue;
      }

      const key = line.slice(0, separator).trim();

      if (!explicitlySet.has(key)) {
        process.env[key] = line.slice(separator + 1).trim();
      }
    }
  }
}

function printUsage(): void {
  console.error([
    "Usage:",
    "  npm run eval:generate",
    "  npm run eval:import -- --lookback-hours 168",
    "  npm run eval:run -- --mode isolated",
    "  npm run eval:run -- --mode production --url <mcp-url>"
  ].join("\n"));
}

const SYNTHETIC_MEMORIES = [
  {
    key: "ktor-darwin",
    topic: "eval-networking",
    content: "The shared Kotlin networking layer uses Ktor HttpClient with the Darwin engine on iOS and the OkHttp engine on Android."
  },
  {
    key: "retrofit-legacy",
    topic: "eval-networking",
    content: "The retired Android-only client used Retrofit with Gson and had no iOS implementation."
  },
  {
    key: "vector-dimensions",
    topic: "eval-firestore",
    content: "Firestore vector indexes and GEMINI_EMBEDDING_DIMENSIONS must both use 768 dimensions with cosine distance."
  },
  {
    key: "firestore-mode",
    topic: "eval-firestore",
    content: "The MetaCortex database must use Firestore Native mode rather than Datastore mode."
  },
  {
    key: "client-scoping",
    topic: "eval-security",
    content: "Each custom MCP client profile has its own bearer token, tool allowlist, branch-state allowlist, and browser origin allowlist."
  },
  {
    key: "cors-default",
    topic: "eval-security",
    content: "MCP_ALLOWED_ORIGINS applies only to the default admin endpoint and defaults to denying browser origins."
  },
  {
    key: "write-fingerprint",
    topic: "eval-writes",
    content: "A write fingerprint suppresses duplicate memory writes for fifteen minutes while the fingerprint document is retained for thirty days."
  },
  {
    key: "consolidation",
    topic: "eval-lifecycle",
    content: "Consolidation merges at least two source memories into one active record and deprecates each source with superseded_by set to the merged id."
  }
] as const;

const SYNTHETIC_CASES: readonly SyntheticEvalDefinition[] = [
  {
    case_id: "networking-ios-engine",
    query: "Which HTTP engine does the shared mobile client use on iOS?",
    filter_topic: "eval-networking",
    filter_state: "active",
    limit: 5,
    positive_keys: ["ktor-darwin"]
  },
  {
    case_id: "firestore-vector-dimensions",
    query: "GEMINI_EMBEDDING_DIMENSIONS cosine index size",
    filter_topic: "eval-firestore",
    filter_state: "active",
    limit: 5,
    positive_keys: ["vector-dimensions"]
  },
  {
    case_id: "firestore-native-mode",
    query: "Which Firestore database mode is required?",
    filter_topic: "eval-firestore",
    filter_state: "active",
    limit: 5,
    positive_keys: ["firestore-mode"]
  },
  {
    case_id: "scoped-client-controls",
    query: "How are individual MCP clients restricted?",
    filter_topic: "eval-security",
    filter_state: "active",
    limit: 5,
    positive_keys: ["client-scoping"]
  },
  {
    case_id: "duplicate-write-window",
    query: "How long are repeated memory writes deduplicated?",
    filter_topic: "eval-writes",
    filter_state: "active",
    limit: 5,
    positive_keys: ["write-fingerprint"]
  },
  {
    case_id: "consolidation-effects",
    query: "What happens to source records after consolidation?",
    filter_topic: "eval-lifecycle",
    filter_state: "active",
    limit: 5,
    positive_keys: ["consolidation"]
  }
];

await main();
