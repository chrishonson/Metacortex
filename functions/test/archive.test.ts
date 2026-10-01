import { describe, expect, it } from "vitest";

import {
  buildManifest,
  checkTruncation,
  describeEmbeddingMismatch,
  parseArchive,
  restoreMemories,
  serializeArchive,
  type ArchivedMemory
} from "../src/archive.js";
import type { EmbeddingClient, EmbeddingRequest } from "../src/embeddings.js";

function memory(overrides: Partial<ArchivedMemory> = {}): ArchivedMemory {
  return {
    id: "doc-b",
    content: "Nick prefers MVI for Android",
    retrieval_text: "Nick prefers MVI for Android",
    metadata: {
      module_name: "android",
      branch_state: "active",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      modality: "text"
    },
    ...overrides
  };
}

describe("serializeArchive", () => {
  it("emits one JSON object per line, sorted by document id", () => {
    const output = serializeArchive([
      memory({ id: "doc-c" }),
      memory({ id: "doc-a" }),
      memory({ id: "doc-b" })
    ]);

    const ids = output
      .trimEnd()
      .split("\n")
      .map(line => JSON.parse(line).id);

    expect(ids).toEqual(["doc-a", "doc-b", "doc-c"]);
  });

  it("terminates the final line with a newline", () => {
    expect(serializeArchive([memory()]).endsWith("\n")).toBe(true);
  });

  it("is byte-identical regardless of key insertion order", () => {
    const straightforward = serializeArchive([memory()]);

    const scrambled = serializeArchive([
      {
        metadata: {
          modality: "text",
          updated_at: 1_700_000_000_000,
          branch_state: "active",
          created_at: 1_700_000_000_000,
          module_name: "android"
        },
        retrieval_text: "Nick prefers MVI for Android",
        id: "doc-b",
        content: "Nick prefers MVI for Android"
      } as ArchivedMemory
    ]);

    expect(scrambled).toBe(straightforward);
  });

  it("omits absent optional fields rather than emitting null", () => {
    const line = serializeArchive([memory()]).trimEnd();

    expect(line).not.toContain("null");
    expect(line).not.toContain("media");
    expect(line).not.toContain("superseded_by");
  });

  it("round-trips every optional metadata field", () => {
    const full = memory({
      id: "doc-full",
      metadata: {
        module_name: "metacortex-product",
        branch_state: "deprecated",
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_100_000,
        modality: "mixed",
        artifact_refs: ["gs://bucket/diagram.png"],
        superseded_by: "doc-successor",
        valid_from: 1_699_000_000_000,
        valid_until: 1_701_000_000_000,
        supersession_reason: "corrected",
        initiator: "user",
        provenance: {
          origin: "user_asserted",
          source_session: "session-42",
          derived_from: ["doc-a", "doc-b"],
          confidence: 0.97
        }
      },
      media: { kind: "inline_image", mime_type: "image/png" }
    });

    expect(parseArchive(serializeArchive([full]))).toEqual([full]);
  });
});

describe("parseArchive", () => {
  it("ignores blank lines and tolerates CRLF", () => {
    const ndjson = serializeArchive([memory()]).trimEnd();

    expect(parseArchive(`\r\n${ndjson}\r\n\r\n`)).toHaveLength(1);
  });

  it("reports the line number of malformed content", () => {
    const ndjson = `${serializeArchive([memory()]).trimEnd()}\nnot-json\n`;

    expect(() => parseArchive(ndjson)).toThrow(/line 2/);
  });
});

describe("buildManifest", () => {
  it("counts documents and tallies branch states", () => {
    const manifest = buildManifest({
      memories: [
        memory({ id: "a" }),
        memory({
          id: "b",
          metadata: { ...memory().metadata, branch_state: "deprecated" }
        }),
        memory({
          id: "c",
          metadata: { ...memory().metadata, branch_state: "deprecated" }
        })
      ],
      generatedAt: 1_771_286_400_000,
      projectId: "my-brain-88870",
      collection: "memory_vectors",
      embeddingModel: "text-embedding-004",
      embeddingDimensions: 768
    });

    expect(manifest.document_count).toBe(3);
    expect(manifest.state_histogram).toEqual({ active: 1, deprecated: 2 });
    expect(manifest.schema_version).toBe(1);
    expect(manifest.generated_at).toBe(1_771_286_400_000);
  });

  it("orders histogram keys so the manifest serializes deterministically", () => {
    const manifest = buildManifest({
      memories: [
        memory({
          id: "a",
          metadata: { ...memory().metadata, branch_state: "wip" }
        }),
        memory({
          id: "b",
          metadata: { ...memory().metadata, branch_state: "active" }
        })
      ],
      generatedAt: 1,
      projectId: "p",
      collection: "c",
      embeddingModel: "m",
      embeddingDimensions: 768
    });

    expect(Object.keys(manifest.state_histogram)).toEqual(["active", "wip"]);
  });
});

describe("checkTruncation", () => {
  it("allows the first run when there is no previous manifest", () => {
    expect(checkTruncation(undefined, 0).allowed).toBe(true);
  });

  it("allows growth", () => {
    expect(checkTruncation(100, 143).allowed).toBe(true);
  });

  it("allows a drop within 10 percent", () => {
    expect(checkTruncation(100, 90).allowed).toBe(true);
  });

  it("blocks a drop beyond 10 percent and explains why", () => {
    const verdict = checkTruncation(100, 89);

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/89/);
    expect(verdict.reason).toMatch(/100/);
  });

  it("blocks an empty read against a non-empty previous archive", () => {
    expect(checkTruncation(143, 0).allowed).toBe(false);
  });
});

describe("describeEmbeddingMismatch", () => {
  const manifest = {
    generated_at: 1,
    project_id: "p",
    collection: "c",
    document_count: 1,
    state_histogram: { active: 1 },
    embedding_model: "text-embedding-004",
    embedding_dimensions: 768,
    schema_version: 1
  };

  it("returns null when the vector space matches", () => {
    expect(
      describeEmbeddingMismatch(manifest, {
        embeddingModel: "text-embedding-004",
        embeddingDimensions: 768
      })
    ).toBeNull();
  });

  it("describes a dimension change", () => {
    const message = describeEmbeddingMismatch(manifest, {
      embeddingModel: "text-embedding-004",
      embeddingDimensions: 1536
    });

    expect(message).toMatch(/768/);
    expect(message).toMatch(/1536/);
  });

  it("describes a model change", () => {
    const message = describeEmbeddingMismatch(manifest, {
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: 768
    });

    expect(message).toMatch(/text-embedding-004/);
    expect(message).toMatch(/gemini-embedding-001/);
  });
});

class RecordingEmbeddingClient implements EmbeddingClient {
  readonly requests: EmbeddingRequest[] = [];

  async embed(request: EmbeddingRequest): Promise<number[]> {
    this.requests.push(request);

    return [request.text.length, 0, 0];
  }
}

class RecordingRestoreTarget {
  readonly written: { memory: ArchivedMemory; embedding: number[] }[] = [];

  async writeMemory(memory: ArchivedMemory, embedding: number[]): Promise<void> {
    this.written.push({ memory, embedding });
  }
}

describe("restoreMemories", () => {
  it("preserves archived document ids", async () => {
    const target = new RecordingRestoreTarget();

    await restoreMemories({
      memories: [memory({ id: "DSFBIyUni6OGhySMkbHw" })],
      embeddings: new RecordingEmbeddingClient(),
      target
    });

    expect(target.written[0].memory.id).toBe("DSFBIyUni6OGhySMkbHw");
  });

  it("keeps the supersession graph resolvable after restore", async () => {
    const target = new RecordingRestoreTarget();

    await restoreMemories({
      memories: [
        memory({ id: "successor" }),
        memory({
          id: "original",
          metadata: {
            ...memory().metadata,
            branch_state: "deprecated",
            superseded_by: "successor"
          }
        })
      ],
      embeddings: new RecordingEmbeddingClient(),
      target
    });

    const ids = new Set(target.written.map(entry => entry.memory.id));
    const deprecated = target.written.find(
      entry => entry.memory.id === "original"
    );

    expect(ids.has(deprecated!.memory.metadata.superseded_by!)).toBe(true);
  });

  it("embeds retrieval_text with the same request shape the service uses", async () => {
    const embeddings = new RecordingEmbeddingClient();

    await restoreMemories({
      memories: [
        memory({
          id: "a",
          content: "canonical content",
          retrieval_text: "normalized retrieval text",
          metadata: { ...memory().metadata, module_name: "android" }
        })
      ],
      embeddings,
      target: new RecordingRestoreTarget()
    });

    expect(embeddings.requests[0]).toEqual({
      text: "normalized retrieval text",
      taskType: "RETRIEVAL_DOCUMENT",
      title: "android"
    });
  });

  it("reports how many documents were restored", async () => {
    const result = await restoreMemories({
      memories: [memory({ id: "a" }), memory({ id: "b" })],
      embeddings: new RecordingEmbeddingClient(),
      target: new RecordingRestoreTarget()
    });

    expect(result.restored).toBe(2);
  });

  it("round-trips an archive without losing metadata", async () => {
    const original = memory({
      id: "doc-full",
      metadata: {
        module_name: "metacortex-product",
        branch_state: "deprecated",
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_100_000,
        modality: "mixed",
        artifact_refs: ["gs://bucket/diagram.png"],
        superseded_by: "doc-successor",
        valid_from: 1_699_000_000_000,
        valid_until: 1_701_000_000_000,
        supersession_reason: "corrected",
        initiator: "user",
        provenance: {
          origin: "user_asserted",
          source_session: "session-42",
          derived_from: ["doc-a"],
          confidence: 0.97
        }
      },
      media: { kind: "inline_image", mime_type: "image/png" }
    });

    const target = new RecordingRestoreTarget();

    await restoreMemories({
      memories: parseArchive(serializeArchive([original])),
      embeddings: new RecordingEmbeddingClient(),
      target
    });

    expect(target.written[0].memory).toEqual(original);
    expect(target.written[0].embedding).toHaveLength(3);
  });
});


