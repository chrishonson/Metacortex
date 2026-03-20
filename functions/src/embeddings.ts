import { GoogleGenAI, type Part } from "@google/genai";

import { HttpError } from "./errors.js";
import type {
  MemoryMedia,
  MemoryModality
} from "./types.js";

export interface EmbeddingRequest {
  text: string;
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";
  title?: string;
}

export interface EmbeddingClient {
  embed(request: EmbeddingRequest): Promise<number[]>;
}

export interface GeminiEmbeddingClientOptions {
  apiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  model: string;
  dimensions: number;
}

export interface MemoryPreparationInput {
  content?: string;
  moduleName: string;
  imageBase64?: string;
  imageMimeType?: string;
}

export interface PreparedMemoryContent {
  content: string;
  retrieval_text: string;
  modality: MemoryModality;
  media?: MemoryMedia;
}

export interface MemoryContentPreparer {
  prepare(input: MemoryPreparationInput): Promise<PreparedMemoryContent>;
}

export interface GeminiMultimodalPreparerOptions {
  apiKey: string;
  model: string;
}

export class GeminiEmbeddingClient implements EmbeddingClient {
  private readonly client: GoogleGenAI;

  constructor(private readonly options: GeminiEmbeddingClientOptions) {
    this.client = options.vertexai
      ? new GoogleGenAI({
          vertexai: true,
          project: options.project,
          location: options.location ?? "us-central1"
        })
      : new GoogleGenAI({ apiKey: options.apiKey! });
  }

  async embed(request: EmbeddingRequest): Promise<number[]> {
    const response = await this.client.models.embedContent({
      model: this.options.model,
      contents: request.text,
      config: {
        taskType: request.taskType,
        title: request.title,
        outputDimensionality: this.options.dimensions
      }
    });

    const embedding = response.embeddings?.[0]?.values;

    if (!embedding) {
      throw new Error("Gemini embedding provider returned no embedding data");
    }

    if (embedding.length !== this.options.dimensions) {
      throw new Error(
        `Embedding dimension mismatch. Expected ${this.options.dimensions}, received ${embedding.length}`
      );
    }

    return embedding;
  }
}

export class GeminiMultimodalPreparer implements MemoryContentPreparer {
  private readonly client: GoogleGenAI;

  constructor(private readonly options: GeminiMultimodalPreparerOptions) {
    this.client = new GoogleGenAI({
      apiKey: options.apiKey
    });
  }

  async prepare(input: MemoryPreparationInput): Promise<PreparedMemoryContent> {
    const normalizedContent = input.content?.trim();
    const hasImage = Boolean(input.imageBase64);

    if (!normalizedContent && !hasImage) {
      throw new HttpError(
        400,
        "Either content or image_base64 must be provided to store_context"
      );
    }

    if (hasImage !== Boolean(input.imageMimeType)) {
      throw new HttpError(
        400,
        "image_mime_type is required when image_base64 is provided"
      );
    }

    if (!hasImage) {
      return {
        content: normalizedContent!,
        retrieval_text: normalizedContent!,
        modality: "text"
      };
    }

    const parts: Part[] = [
      {
        text: buildImageNormalizationPrompt(
          normalizedContent,
          input.moduleName
        )
      },
      {
        inlineData: {
          data: input.imageBase64!,
          mimeType: input.imageMimeType!
        }
      }
    ];

    const response = await this.client.models.generateContent({
      model: this.options.model,
      contents: [
        {
          role: "user",
          parts
        }
      ],
      config: {
        responseMimeType: "text/plain",
        temperature: 0.1,
        maxOutputTokens: 400
      }
    });

    const imageSummary = response.text?.trim();

    if (!imageSummary) {
      throw new Error("Gemini multimodal normalizer returned no text output");
    }

    const sections = [normalizedContent, `Visual memory summary:\n${imageSummary}`]
      .filter(Boolean)
      .join("\n\n");

    return {
      content: normalizedContent ?? imageSummary,
      retrieval_text: sections,
      modality: normalizedContent ? "mixed" : "image",
      media: {
        kind: "inline_image",
        mime_type: input.imageMimeType!
      }
    };
  }
}

function buildImageNormalizationPrompt(
  content: string | undefined,
  moduleName: string
): string {
  const userContext = content
    ? `User context:\n${content}`
    : "User context:\nNone provided.";

  return [
    "Convert this software-project memory into concise retrieval text.",
    `Module name: ${moduleName}`,
    userContext,
    "Describe only details visible in the image that matter for later semantic retrieval.",
    "Prefer concrete UI labels, architecture labels, code identifiers, error text, and relationships.",
    "Do not speculate beyond the image and provided context.",
    "Return plain text only."
  ].join("\n\n");
}
