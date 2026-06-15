import { GoogleGenAI } from "@google/genai";

export interface VertexClientOptions {
  vertexai: true;
  project?: string;
  location: string;
}

export function createVertexClient(options: VertexClientOptions): GoogleGenAI {
  const originalGeminiApiKey = process.env.GEMINI_API_KEY;

  delete process.env.GEMINI_API_KEY;

  try {
    return new GoogleGenAI(options);
  } finally {
    if (typeof originalGeminiApiKey === "string") {
      process.env.GEMINI_API_KEY = originalGeminiApiKey;
    }
  }
}
