import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GoogleGenAI } from "@google/genai";

import { createVertexClient } from "./genai-client.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(functionsDir, "..");
const explicitEnvKeys = new Set(Object.keys(process.env));
const loadedEnv = {};

for (const fileName of [".env", ".env.prod"]) {
  loadEnvFile(path.join(functionsDir, fileName), loadedEnv);
}

for (const [key, value] of Object.entries(loadedEnv)) {
  if (!explicitEnvKeys.has(key)) {
    process.env[key] = value;
  }
}

const apiKey = requiredEnv("GEMINI_API_KEY");
const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL?.trim() || "text-embedding-004";
const multimodalModel = process.env.GEMINI_MULTIMODAL_MODEL?.trim() || "gemini-3.1-flash-lite";
const mergeModel = process.env.GEMINI_MERGE_MODEL?.trim() || "gemini-3.1-flash-lite";
const projectId =
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.GCLOUD_PROJECT ??
  readFirebaseProject(repoRoot);
const embeddingVertexLocation =
  process.env.GEMINI_VERTEX_LOCATION?.trim() || "us-central1";
const generationVertexLocation =
  process.env.GEMINI_GENERATION_VERTEX_LOCATION?.trim() || "global";
const embeddingDimensions = positiveInt(
  process.env.GEMINI_EMBEDDING_DIMENSIONS,
  768,
  "GEMINI_EMBEDDING_DIMENSIONS"
);

const embeddingClient = projectId
  ? createVertexClient({
      vertexai: true,
      project: projectId,
      location: embeddingVertexLocation
    })
  : new GoogleGenAI({ apiKey });
const generationClient = projectId
  ? createVertexClient({
      vertexai: true,
      project: projectId,
      location: generationVertexLocation
    })
  : new GoogleGenAI({ apiKey });

console.log("Validating Gemini model configuration...");
console.log(`embedding model: ${embeddingModel}`);
console.log(`embedding provider: ${projectId ? `Vertex AI (${projectId}, ${embeddingVertexLocation})` : "Gemini API key"}`);
console.log(`embedding dimensions: ${embeddingDimensions}`);
console.log(`multimodal model: ${multimodalModel}`);
console.log(`merge model: ${mergeModel}`);
console.log(`generation provider: ${projectId ? `Vertex AI (${projectId}, ${generationVertexLocation})` : "Gemini API key"}`);

try {
  const embeddingResponse = await embeddingClient.models.embedContent({
    model: embeddingModel,
    contents: "MetaCortex deployment model validation.",
    config: {
      taskType: "RETRIEVAL_DOCUMENT",
      title: "metacortex",
      outputDimensionality: embeddingDimensions
    }
  });

  const embedding = embeddingResponse.embeddings?.[0]?.values;

  if (!embedding) {
    throw new Error("Gemini embedding validation returned no embedding data");
  }

  if (embedding.length !== embeddingDimensions) {
    throw new Error(
      `Embedding dimension mismatch. Expected ${embeddingDimensions}, received ${embedding.length}`
    );
  }
} catch (error) {
  if (!isMissingAdcError(error)) {
    throw error;
  }

  console.warn(
    "Skipping Vertex embedding validation because Application Default Credentials are not configured locally. Production smoke tests must validate remember/search after deploy."
  );
}

try {
  const imageResponse = await generationClient.models.generateContent({
    model: multimodalModel,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Return exactly: ok"
          },
          {
            inlineData: {
              data:
                "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4o6FBEmIY1TCqYfhqAAAyBCwQhvh37QAAAABJRU5ErkJggg==",
              mimeType: "image/png"
            }
          }
        ]
      }
    ],
    config: {
      responseMimeType: "text/plain",
      temperature: 0,
      maxOutputTokens: 8
    }
  });

  if (!imageResponse.text?.trim()) {
    throw new Error("Gemini multimodal validation returned no text output");
  }
} catch (error) {
  if (!isMissingAdcError(error)) {
    throw error;
  }

  console.warn(
    "Skipping Vertex multimodal validation because Application Default Credentials are not configured locally. Production multimodal smoke tests must validate image-backed memories after deploy."
  );
}

try {
  const mergeResponse = await generationClient.models.generateContent({
    model: mergeModel,
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Merge these memories into one sentence: [1] MetaCortex stores memories. [2] MetaCortex searches memories."
          }
        ]
      }
    ],
    config: {
      responseMimeType: "text/plain",
      temperature: 0,
      maxOutputTokens: 32
    }
  });

  if (!mergeResponse.text?.trim()) {
    throw new Error("Gemini merge model validation returned no text output");
  }
} catch (error) {
  if (!isMissingAdcError(error)) {
    throw error;
  }

  console.warn(
    "Skipping Vertex merge-model validation because Application Default Credentials are not configured locally. Production consolidation smoke tests should validate merge behavior after deploy."
  );
}

console.log("Model validation completed.");

function loadEnvFile(filePath, target) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    target[key] = value;
  }
}

function requiredEnv(key) {
  const value = process.env[key]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function positiveInt(value, fallback, key) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return parsed;
}

function isMissingAdcError(error) {
  return error instanceof Error && error.message.includes("default credentials");
}

function readFirebaseProject(rootDir) {
  const firebaseRcPath = path.join(rootDir, ".firebaserc");

  if (!fs.existsSync(firebaseRcPath)) {
    return undefined;
  }

  const firebaseRc = JSON.parse(fs.readFileSync(firebaseRcPath, "utf8"));
  const project = firebaseRc.projects?.prod ?? firebaseRc.projects?.default;

  return typeof project === "string" && project.trim() ? project.trim() : undefined;
}
