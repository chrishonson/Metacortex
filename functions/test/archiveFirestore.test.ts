import { describe, expect, it } from "vitest";

import { toArchivedMemory } from "../src/archiveFirestore.js";

describe("toArchivedMemory", () => {
  const data = {
    content: "Nick prefers MVI for Android",
    retrieval_text: "Nick prefers MVI for Android",
    embedding: { _values: [0.1, 0.2, 0.3] },
    metadata: {
      module_name: "android",
      branch_state: "active",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      modality: "text"
    }
  };

  it("keeps the document id", () => {
    expect(toArchivedMemory("doc-a", data).id).toBe("doc-a");
  });

  it("drops the embedding field", () => {
    expect(toArchivedMemory("doc-a", data)).not.toHaveProperty("embedding");
  });

  it("falls back to content when retrieval_text is missing", () => {
    const { retrieval_text: _omitted, ...withoutRetrievalText } = data;

    expect(toArchivedMemory("doc-a", withoutRetrievalText).retrieval_text).toBe(
      "Nick prefers MVI for Android"
    );
  });

  it("preserves media when present", () => {
    const withMedia = {
      ...data,
      media: { kind: "inline_image", mime_type: "image/png" }
    };

    expect(toArchivedMemory("doc-a", withMedia).media).toEqual({
      kind: "inline_image",
      mime_type: "image/png"
    });
  });

  it("omits media when absent", () => {
    expect(toArchivedMemory("doc-a", data).media).toBeUndefined();
  });
});
