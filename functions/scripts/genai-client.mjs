import { GoogleGenAI } from "@google/genai";

export function createVertexClient(options) {
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
