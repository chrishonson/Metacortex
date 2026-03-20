import { describe, expect, it } from "vitest";

import { OpenBrainService } from "../src/service.js";
import {
  createTestConfig,
  FakeMemoryContentPreparer,
  InMemoryMemoryRepository,
  KeywordEmbeddingClient
} from "./support/fakes.js";

describe("OpenBrainService", () => {
  function createService(overrides = {}) {
    const config = createTestConfig(overrides);
    const repository = new InMemoryMemoryRepository();
    const embeddings = new KeywordEmbeddingClient();
    const contentPreparer = new FakeMemoryContentPreparer();
    const service = new OpenBrainService(contentPreparer, embeddings, repository, config);

    return { service, repository };
  }

  it("stores context with metadata", async () => {
    const { service } = createService();
    const result = await service.storeContext({
      content:
        "We are using Ktor for the Android/iOS networking layer in the main branch.",
      module_name: "kmp-networking",
      branch_state: "active"
    });

    expect(result.id).toBe("memory-1");
    expect(result.content).toContain("Ktor");
    expect(result.metadata.module_name).toBe("kmp-networking");
    expect(result.metadata.branch_state).toBe("active");
    expect(result.metadata.modality).toBe("text");
    expect(result.was_duplicate).toBe(false);
  });

  it("searches with module filter", async () => {
    const { service } = createService();
    await service.storeContext({
      content:
        "We are using Ktor for the Android/iOS networking layer in the main branch.",
      module_name: "kmp-networking",
      branch_state: "active"
    });
    await service.storeContext({
      content: "Jetpack Compose settings screen screenshot.",
      module_name: "jetpack-compose-ui",
      branch_state: "active"
    });
    const result = await service.searchContext({
      query: "networking layer for Android and iOS",
      filter_module: "kmp-networking"
    });

    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.content).toContain("Ktor");
    expect(result.matches[0]?.metadata.module_name).toBe("kmp-networking");
  });

  it("returns applied filters in search result", async () => {
    const { service } = createService();
    await service.storeContext({
      content: "Ktor networking decision.",
      module_name: "kmp-networking",
      branch_state: "active"
    });
    const result = await service.searchContext({
      query: "networking",
      filter_module: "kmp-networking"
    });

    expect(result.appliedFilters).toEqual({
      filter_module: "kmp-networking",
      filter_state: "active"
    });
  });

  it("remembers context with topic defaults", async () => {
    const { service } = createService();
    const result = await service.rememberContext({
      content: "Add Ktor shared networking module to KMP project.",
      topic: "kmp-networking"
    });

    expect(result.id).toBe("memory-1");
    expect(result.metadata.module_name).toBe("kmp-networking");
    expect(result.metadata.branch_state).toBe("active");
    expect(result.metadata.modality).toBe("text");
  });

  it("remembers as draft when draft=true", async () => {
    const { service } = createService();
    const result = await service.rememberContext({
      content: "Maybe we should switch to OkHttp.",
      topic: "kmp-networking",
      draft: true
    });

    expect(result.metadata.branch_state).toBe("wip");
  });

  it("uses general as default topic", async () => {
    const { service } = createService();
    const result = await service.rememberContext({
      content: "Short note about something."
    });

    expect(result.metadata.module_name).toBe("general");
  });

  it("stores image-backed memories with mixed modality", async () => {
    const { service } = createService();
    const result = await service.storeContext({
      content: "Jetpack Compose settings screen screenshot.",
      module_name: "jetpack-compose-ui",
      branch_state: "active",
      image_base64: "ZmFrZS1pbWFnZS1ieXRlcw==",
      image_mime_type: "image/png",
      artifact_refs: ["gs://bucket/settings-screen.png"]
    });

    expect(result.metadata.modality).toBe("mixed");
    expect(result.media).toEqual({
      kind: "inline_image",
      mime_type: "image/png"
    });
    expect(result.metadata.artifact_refs).toEqual([
      "gs://bucket/settings-screen.png"
    ]);
  });

  it("deprecates a memory and records the previous state", async () => {
    const { service } = createService();
    const stored = await service.storeContext({
      content:
        "We are using Ktor for the Android/iOS networking layer.",
      module_name: "kmp-networking",
      branch_state: "active"
    });
    const replacement = await service.storeContext({
      content:
        "We migrated from Ktor to OkHttp for the Android/iOS networking layer.",
      module_name: "kmp-networking",
      branch_state: "active"
    });
    const result = await service.deprecateContext({
      document_id: stored.id,
      superseding_document_id: replacement.id
    });

    expect(result.document_id).toBe(stored.id);
    expect(result.superseding_document_id).toBe(replacement.id);
    expect(result.previous_state).toBe("active");
  });

  it("fetches a stored document by id", async () => {
    const { service } = createService();
    const stored = await service.storeContext({
      content: "Ktor networking pattern.",
      module_name: "kmp-networking",
      branch_state: "active"
    });
    const fetched = await service.fetchContext({ document_id: stored.id });

    expect(fetched.item.id).toBe(stored.id);
    expect(fetched.item.content).toBe(stored.content);
  });

  it("fetches rejects unknown document id", async () => {
    const { service } = createService();

    await expect(
      service.fetchContext({ document_id: "nonexistent" })
    ).rejects.toThrow("Document not found");
  });

  it("returns empty matches when no documents match", async () => {
    const { service } = createService();
    const result = await service.searchContext({
      query: "Firebase auth setup"
    });

    expect(result.matches).toEqual([]);
  });

  it("returns consolidation queue for wip items", async () => {
    const { service } = createService();
    await service.storeContext({
      content: "Draft networking patterns.",
      module_name: "kmp-networking",
      branch_state: "wip"
    });
    await service.storeContext({
      content: "Active decision.",
      module_name: "kmp-networking",
      branch_state: "active"
    });
    await service.storeContext({
      content: "Another draft for UI.",
      module_name: "jetpack-compose-ui",
      branch_state: "wip"
    });
    const result = await service.getConsolidationQueue({
      module_name: "kmp-networking"
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0]?.content).toContain("Draft networking");
    expect(result.filter_module).toBe("kmp-networking");
  });
});
