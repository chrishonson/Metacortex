import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createVertexClient } from "../src/gemini.js";
import type { TieringCorpus } from "../src/tieringEvaluation.js";

export const GENERATION_MODEL = "gemini-3.5-flash";
export const VERTEX_LOCATION = "global";
export const VERTEX_PROJECT = "my-brain-88870";
export const GENERATION_TEMPERATURE = 0;
export const GENERATION_PROMPT =
  "Write a search-result summary of the memory content below that keeps the decisive fact, in at most 220 characters. Return only the summary text without preamble or quotes.";

export interface GeneratedSummaryEntry {
  key: string;
  summary: string;
  prompt_tokens: number;
  output_tokens: number;
  thought_tokens: number;
}

export interface GeneratedSummariesFixture {
  schema_version: string;
  corpus_id: string;
  corpus_sha256: string;
  model: string;
  location: string;
  generated_at: string;
  prompt: string;
  temperature: number;
  summaries: GeneratedSummaryEntry[];
  totals: {
    prompt_tokens: number;
    output_tokens: number;
    thought_tokens: number;
    total_tokens: number;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const corpusUrl = new URL("../eval/tiering/corpus.json", import.meta.url);
  const corpusRaw = readFileSync(corpusUrl);
  const corpusSha256 = createHash("sha256").update(corpusRaw).digest("hex");
  const corpus = JSON.parse(corpusRaw.toString("utf8")) as TieringCorpus;

  const ai = createVertexClient({
    vertexai: true,
    project: VERTEX_PROJECT,
    location: VERTEX_LOCATION
  });

  const summaries: GeneratedSummaryEntry[] = [];

  for (let i = 0; i < corpus.memories.length; i += 1) {
    const memory = corpus.memories[i]!;
    process.stderr.write(`[${i + 1}/${corpus.memories.length}] Generating summary for: ${memory.key}...\n`);

    const contents = `${GENERATION_PROMPT}\n\n${memory.content}`;

    let response;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        response = await ai.models.generateContent({
          model: GENERATION_MODEL,
          contents,
          config: {
            temperature: GENERATION_TEMPERATURE
          }
        });
        break;
      } catch (err: unknown) {
        const isRateLimit =
          String(err).includes("429") ||
          String(err).includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && attempt < 4) {
          const waitSec = attempt * 20;
          process.stderr.write(
            `[Rate limit on ${memory.key}, waiting ${waitSec}s before attempt ${attempt + 1}...]\n`
          );
          await sleep(waitSec * 1000);
        } else {
          throw err;
        }
      }
    }

    if (!response) {
      throw new Error(`Failed to obtain response for memory: ${memory.key}`);
    }

    const summaryText = response.text?.trim() ?? "";
    if (!summaryText) {
      throw new Error(`Empty generation output for memory: ${memory.key}`);
    }

    const usage = response.usageMetadata;
    const promptTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const thoughtTokens = usage?.thoughtsTokenCount ?? 0;

    summaries.push({
      key: memory.key,
      summary: summaryText,
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      thought_tokens: thoughtTokens
    });

    // Pacing delay between generation calls to stay well within quotas
    if (i < corpus.memories.length - 1) {
      await sleep(4000);
    }
  }

  const totals = summaries.reduce(
    (acc, entry) => {
      acc.prompt_tokens += entry.prompt_tokens;
      acc.output_tokens += entry.output_tokens;
      acc.thought_tokens += entry.thought_tokens;
      acc.total_tokens += entry.prompt_tokens + entry.output_tokens + entry.thought_tokens;
      return acc;
    },
    { prompt_tokens: 0, output_tokens: 0, thought_tokens: 0, total_tokens: 0 }
  );

  const fixture: GeneratedSummariesFixture = {
    schema_version: "tiering-generated-summaries.v1",
    corpus_id: corpus.corpus_id,
    corpus_sha256: corpusSha256,
    model: GENERATION_MODEL,
    location: VERTEX_LOCATION,
    generated_at: new Date().toISOString(),
    prompt: GENERATION_PROMPT,
    temperature: GENERATION_TEMPERATURE,
    summaries,
    totals
  };

  const fixturePath = fileURLToPath(new URL("../eval/tiering/generated-summaries.json", import.meta.url));
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  process.stderr.write(`Wrote fixture with ${summaries.length} summaries to ${fixturePath}\n`);
}

main().catch(err => {
  process.stderr.write(`Generation failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
