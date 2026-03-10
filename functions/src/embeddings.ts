import OpenAI from "openai";

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

export interface OpenAiEmbeddingClientOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
}

export class OpenAiEmbeddingClient implements EmbeddingClient {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiEmbeddingClientOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl
    });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.options.model,
      input: text,
      dimensions: this.options.dimensions,
      encoding_format: "float"
    });

    const embedding = response.data[0]?.embedding;

    if (!embedding) {
      throw new Error("Embedding provider returned no embedding data");
    }

    if (embedding.length !== this.options.dimensions) {
      throw new Error(
        `Embedding dimension mismatch. Expected ${this.options.dimensions}, received ${embedding.length}`
      );
    }

    return embedding;
  }
}
