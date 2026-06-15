import { GoogleGenAI } from "@google/genai";

import { createVertexClient } from "./gemini.js";

export interface MergeMemoriesRequest {
  topic: string;
  sources: Array<{ id: string; content: string }>;
}

export interface MergeMemoriesResult {
  mergedContent: string;
}

export interface LlmMergeClient {
  merge(request: MergeMemoriesRequest): Promise<MergeMemoriesResult>;
}

export interface GeminiMergeClientOptions {
  apiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  model: string;
}

export class GeminiMergeClient implements LlmMergeClient {
  private readonly client: GoogleGenAI;

  constructor(private readonly options: GeminiMergeClientOptions) {
    this.client = options.vertexai
      ? createVertexClient({
          vertexai: true,
          project: options.project,
          location: options.location ?? "us-central1"
        })
      : new GoogleGenAI({ apiKey: options.apiKey! });
  }

  async merge(request: MergeMemoriesRequest): Promise<MergeMemoriesResult> {
    const response = await this.client.models.generateContent({
      model: this.options.model,
      contents: [
        {
          role: "user",
          parts: [{ text: buildMergePrompt(request) }]
        }
      ],
      config: {
        responseMimeType: "text/plain",
        temperature: 0.1,
        maxOutputTokens: 2000
      }
    });

    const mergedContent = response.text?.trim();

    if (!mergedContent) {
      throw new Error("Gemini merge client returned no text output");
    }

    return { mergedContent };
  }
}

function buildMergePrompt(request: MergeMemoriesRequest): string {
  const sourceList = request.sources
    .map((source, index) => `[${index + 1}]\n${source.content}`)
    .join("\n\n---\n\n");

  return [
    "Merge the following related memories into a single canonical memory.",
    `Topic: ${request.topic}`,
    "",
    "Rules:",
    "- Preserve ALL distinct facts from every source memory",
    "- Keep facts that differ in numeric values, dates, or qualifiers as separate statements — do NOT conflate them",
    "- Remove only true redundancy: statements that express identical or nearly identical information",
    "- Write in a clear, direct, plain-text style",
    "- Return ONLY the merged memory content — no preamble, explanation, labels, or metadata",
    "",
    "SOURCE MEMORIES:",
    "",
    sourceList
  ].join("\n");
}
