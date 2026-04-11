import { describe, expect, it } from "vitest";

import { MetaCortexService } from "../src/service.js";
import {
  createTestConfig,
  FakeMemoryContentPreparer,
  FakeLlmMergeClient,
  InMemoryMemoryRepository,
  KeywordEmbeddingClient
} from "./support/fakes.js";

describe("MetaCortexService", () => {
  function createService(overrides = {}) {
    const config = createTestConfig(overrides);
    const repository = new InMemoryMemoryRepository();
    const embeddings = new KeywordEmbeddingClient();
    const contentPreparer = new FakeMemoryContentPreparer();
    const mergeClient = new FakeLlmMergeClient();
    const service = new MetaCortexService(contentPreparer, embeddings, repository, config, mergeClient);

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
      filter_topic: "kmp-networking"
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
      filter_topic: "kmp-networking"
    });

    expect(result.appliedFilters).toEqual({
      filter_topic: "kmp-networking",
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

  it("remembers with explicit branch_state when provided", async () => {
    const { service } = createService();
    const result = await service.rememberContext({
      content: "Old networking decision retained for history.",
      topic: "kmp-networking",
      branch_state: "merged"
    });

    expect(result.metadata.branch_state).toBe("merged");
  });

  it("rejects conflicting draft and branch_state inputs", async () => {
    const { service } = createService();

    await expect(
      service.rememberContext({
        content: "Conflicting lifecycle fields.",
        topic: "kmp-networking",
        draft: true,
        branch_state: "active"
      })
    ).rejects.toThrow("Provide either draft or branch_state, not both");
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
      id: stored.id,
      superseding_id: replacement.id
    });

    expect(result.id).toBe(stored.id);
    expect(result.superseding_id).toBe(replacement.id);
    expect(result.previous_state).toBe("active");
  });

  it("fetches a stored document by id", async () => {
    const { service } = createService();
    const stored = await service.storeContext({
      content: "Ktor networking pattern.",
      module_name: "kmp-networking",
      branch_state: "active"
    });
    const fetched = await service.fetchContext({ id: stored.id });

    expect(fetched.item.id).toBe(stored.id);
    expect(fetched.item.content).toBe(stored.content);
  });

  it("fetches rejects unknown id", async () => {
    const { service } = createService();

    await expect(service.fetchContext({ id: "nonexistent" })).rejects.toThrow(
      "Document not found"
    );
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
      topic: "kmp-networking"
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0]?.content).toContain("Draft networking");
    expect(result.filter_topic).toBe("kmp-networking");
  });

  describe("consolidateContext", () => {
    it("merges wip memories for a topic and deprecates the sources", async () => {
      const { service } = createService();

      await service.storeContext({
        content: "Draft note A about networking.",
        module_name: "kmp-networking",
        branch_state: "wip"
      });
      await service.storeContext({
        content: "Draft note B about networking.",
        module_name: "kmp-networking",
        branch_state: "wip"
      });

      const result = await service.consolidateContext({ topic: "kmp-networking" });

      expect(result.topic).toBe("kmp-networking");
      expect(result.source_count).toBe(2);
      expect(result.deprecated_ids).toHaveLength(2);
      expect(result.merged_content).toContain("Draft note A");
      expect(result.merged_content).toContain("Draft note B");

      const merged = await service.fetchContext({ id: result.merged_id });
      expect(merged.item.metadata.branch_state).toBe("active");
      expect(merged.item.metadata.module_name).toBe("kmp-networking");

      for (const id of result.deprecated_ids) {
        const deprecated = await service.fetchContext({ id });
        expect(deprecated.item.metadata.branch_state).toBe("deprecated");
        expect(deprecated.item.metadata.superseded_by).toBe(result.merged_id);
      }
    });

    it("merges explicit source_ids regardless of branch_state", async () => {
      const { service } = createService();

      const a = await service.storeContext({
        content: "Active learning goal: Xcode literacy.",
        module_name: "learning",
        branch_state: "active"
      });
      const b = await service.storeContext({
        content: "Active learning goal: Kubernetes basics.",
        module_name: "learning",
        branch_state: "active"
      });

      const result = await service.consolidateContext({
        topic: "learning",
        source_ids: [a.id, b.id]
      });

      expect(result.source_count).toBe(2);
      expect(result.deprecated_ids).toContain(a.id);
      expect(result.deprecated_ids).toContain(b.id);
      expect(result.merged_content).toContain("Xcode");
      expect(result.merged_content).toContain("Kubernetes");
    });

    it("defaults topic to general when not provided", async () => {
      const { service } = createService();

      await service.storeContext({
        content: "General draft note 1.",
        module_name: "general",
        branch_state: "wip"
      });
      await service.storeContext({
        content: "General draft note 2.",
        module_name: "general",
        branch_state: "wip"
      });

      const result = await service.consolidateContext({});

      expect(result.topic).toBe("general");
      expect(result.source_count).toBe(2);
    });

    it("throws 422 when fewer than 2 sources are available", async () => {
      const { service } = createService();

      await service.storeContext({
        content: "Only one draft.",
        module_name: "kmp-networking",
        branch_state: "wip"
      });

      await expect(
        service.consolidateContext({ topic: "kmp-networking" })
      ).rejects.toThrow("At least 2 source memories are required");
    });

    it("throws 422 when topic queue is empty", async () => {
      const { service } = createService();

      await expect(
        service.consolidateContext({ topic: "kmp-networking" })
      ).rejects.toThrow("At least 2 source memories are required");
    });

    it("throws 404 when an explicit source_id does not exist", async () => {
      const { service } = createService();

      const a = await service.storeContext({
        content: "Real memory.",
        module_name: "general",
        branch_state: "active"
      });

      await expect(
        service.consolidateContext({
          topic: "general",
          source_ids: [a.id, "nonexistent-id"]
        })
      ).rejects.toThrow("Document not found");
    });
  });
});
