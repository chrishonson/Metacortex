import { describe, expect, it } from "vitest";

import { MetaCortexService, buildFetchPayload } from "../src/service.js";
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

  it("defaults supersession_reason to changed and sets valid_until on deprecate", async () => {
    const { service, repository } = createService();
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

    expect(result.supersession_reason).toBe("changed");

    const deprecatedDoc = await repository.get(stored.id);
    expect(deprecatedDoc).not.toBeNull();
    expect(typeof deprecatedDoc?.metadata.valid_until).toBe("number");
  });

  it("does not set valid_until when supersession_reason is corrected", async () => {
    const { service, repository } = createService();
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
      superseding_id: replacement.id,
      supersession_reason: "corrected"
    });

    expect(result.supersession_reason).toBe("corrected");

    const deprecatedDoc = await repository.get(stored.id);
    expect(deprecatedDoc).not.toBeNull();
    expect(deprecatedDoc?.metadata.valid_until).toBeUndefined();
  });

  it("records initiator on deprecate when provided", async () => {
    const { service, repository } = createService();
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
    await service.deprecateContext({
      id: stored.id,
      superseding_id: replacement.id,
      initiator: "user"
    });

    const deprecatedDoc = await repository.get(stored.id);
    expect(deprecatedDoc).not.toBeNull();
    expect(deprecatedDoc?.metadata.initiator).toBe("user");
  });

  it("search with valid_at excludes documents outside their valid window", async () => {
    const { service } = createService();
    const stored = await service.storeContext({
      content: "We are using Ktor for networking.",
      module_name: "kmp-networking",
      branch_state: "active",
      valid_from: 1000,
      valid_until: 2000
    });

    const inside = await service.searchContext({
      query: "networking",
      valid_at: 1500
    });
    expect(inside.matches.map(m => m.id)).toContain(stored.id);

    const after = await service.searchContext({
      query: "networking",
      valid_at: 2500
    });
    expect(after.matches.map(m => m.id)).not.toContain(stored.id);

    const before = await service.searchContext({
      query: "networking",
      valid_at: 500
    });
    expect(before.matches.map(m => m.id)).not.toContain(stored.id);
  });

  it("search with valid_at excludes corrected documents", async () => {
    const { service } = createService();
    const stored = await service.storeContext({
      content: "We are using Ktor for networking.",
      module_name: "kmp-networking",
      branch_state: "active"
    });
    const replacement = await service.storeContext({
      content: "We migrated to OkHttp.",
      module_name: "kmp-networking",
      branch_state: "active"
    });

    await service.deprecateContext({
      id: stored.id,
      superseding_id: replacement.id,
      supersession_reason: "corrected"
    });

    const result = await service.searchContext({
      query: "networking",
      filter_state: "deprecated",
      valid_at: 1500
    });

    expect(result.matches.map(m => m.id)).not.toContain(stored.id);
  });

  it("search with valid_at includes documents with no temporal fields set", async () => {
    const { service } = createService();
    const stored = await service.storeContext({
      content: "We are using Ktor for networking.",
      module_name: "kmp-networking",
      branch_state: "active"
    });

    const result = await service.searchContext({
      query: "networking",
      valid_at: 1500
    });

    expect(result.matches.map(m => m.id)).toContain(stored.id);
  });

  it("storeContext() defaults origin to agent_inferred when not provided", async () => {
    const { service } = createService();
    const result = await service.storeContext({
      content: "No origin test content",
      module_name: "general",
      branch_state: "active"
    });

    expect(result.metadata.provenance).toBeDefined();
    expect(result.metadata.provenance?.origin).toBe("agent_inferred");
  });

  it("storeContext() preserves explicitly provided origin", async () => {
    const { service } = createService();
    const result = await service.storeContext({
      content: "User asserted content",
      module_name: "general",
      branch_state: "active",
      origin: "user_asserted"
    });

    expect(result.metadata.provenance?.origin).toBe("user_asserted");
  });

  it("storeContext() stores source_session, derived_from, and confidence when provided", async () => {
    const { service } = createService();
    const result = await service.storeContext({
      content: "Complete provenance test content",
      module_name: "general",
      branch_state: "active",
      origin: "agent_inferred",
      source_session: "session-abc",
      derived_from: ["memory-1"],
      confidence: 0.8
    });

    expect(result.metadata.provenance?.origin).toBe("agent_inferred");
    expect(result.metadata.provenance?.source_session).toBe("session-abc");
    expect(result.metadata.provenance?.derived_from).toEqual(["memory-1"]);
    expect(result.metadata.provenance?.confidence).toBe(0.8);
  });

  it("storeContext() does not include source_session, derived_from, or confidence if not provided", async () => {
    const { service } = createService();
    const result = await service.storeContext({
      content: "Only origin test content",
      module_name: "general",
      branch_state: "active"
    });

    expect(result.metadata.provenance?.origin).toBe("agent_inferred");
    expect(result.metadata.provenance?.source_session).toBeUndefined();
    expect(result.metadata.provenance?.derived_from).toBeUndefined();
    expect(result.metadata.provenance?.confidence).toBeUndefined();
  });

  it("searchContext() includes document with matching provenance origin", async () => {
    const { service } = createService();
    const stored = await service.storeContext({
      content: "Match origin search content",
      module_name: "general",
      branch_state: "active",
      origin: "user_asserted"
    });

    const result = await service.searchContext({
      query: "search content",
      filter_origin: "user_asserted"
    });

    expect(result.matches.map(m => m.id)).toContain(stored.id);
  });

  it("searchContext() excludes document with non-matching provenance origin", async () => {
    const { service } = createService();
    const stored = await service.storeContext({
      content: "Non-match origin search content",
      module_name: "general",
      branch_state: "active",
      origin: "agent_inferred"
    });

    const result = await service.searchContext({
      query: "search content",
      filter_origin: "user_asserted"
    });

    expect(result.matches.map(m => m.id)).not.toContain(stored.id);
  });

  it("searchContext() excludes documents without any provenance metadata when filter_origin is set", async () => {
    const { service, repository } = createService();

    const legacyStoreResult = await repository.store({
      content: "Legacy doc with Ktor networking",
      retrievalText: "Legacy doc with Ktor networking",
      embedding: [1, 0, 0, 0, 0, 0],
      idempotencyKey: "legacy-fingerprint-123",
      metadata: {
        module_name: "general",
        branch_state: "active",
        created_at: Date.now(),
        updated_at: Date.now(),
        modality: "text"
      }
    });

    const normalStoreResult = await service.storeContext({
      content: "Normal doc with Ktor networking",
      module_name: "general",
      branch_state: "active",
      origin: "user_asserted"
    });

    const result = await service.searchContext({
      query: "Ktor networking",
      filter_origin: "user_asserted"
    });

    const matchIds = result.matches.map(m => m.id);
    expect(matchIds).toContain(normalStoreResult.id);
    expect(matchIds).not.toContain(legacyStoreResult.document.id);
  });

  it("buildFetchPayload() exposes valid_from, valid_until, supersession_reason, initiator, and provenance", async () => {
    const { service } = createService();

    const doc1 = await service.storeContext({
      content: "Document with temporal and origin info",
      module_name: "general",
      branch_state: "active",
      valid_from: 1000,
      valid_until: 2000,
      origin: "user_asserted"
    });

    const doc2 = await service.storeContext({
      content: "Document to deprecate",
      module_name: "general",
      branch_state: "active"
    });

    const doc3 = await service.storeContext({
      content: "Replacement document",
      module_name: "general",
      branch_state: "active"
    });

    await service.deprecateContext({
      id: doc2.id,
      superseding_id: doc3.id,
      supersession_reason: "changed",
      initiator: "user"
    });

    const fetch1 = await service.fetchContext({ id: doc1.id });
    const fetch2 = await service.fetchContext({ id: doc2.id });

    const payload1 = buildFetchPayload(fetch1);
    const payload2 = buildFetchPayload(fetch2);

    const item1Metadata = (payload1.item as any).metadata;
    expect(item1Metadata.valid_from).toBe(new Date(1000).toISOString());
    expect(item1Metadata.valid_until).toBe(new Date(2000).toISOString());
    expect(item1Metadata.provenance.origin).toBe("user_asserted");

    const item2Metadata = (payload2.item as any).metadata;
    expect(item2Metadata.branch_state).toBe("deprecated");
    expect(item2Metadata.supersession_reason).toBe("changed");
    expect(item2Metadata.initiator).toBe("user");
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

  it("fetches a stored document by document_id compatibility alias", async () => {
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

  it("rejects conflicting fetch id aliases", async () => {
    const { service } = createService();

    await expect(
      service.fetchContext({
        id: "memory-1",
        document_id: "memory-2"
      })
    ).rejects.toThrow("id and document_id must match");
  });

  it("rejects fetch without an id", async () => {
    const { service } = createService();

    await expect(service.fetchContext({})).rejects.toThrow(
      "id or document_id must be provided"
    );
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

    it("deduplicates explicit source_ids before consolidation", async () => {
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
        source_ids: [a.id, a.id, b.id]
      });

      expect(result.source_count).toBe(2);
      expect(result.deprecated_ids).toEqual([a.id, b.id]);
      expect(result.merged_content.match(/Xcode/g)).toHaveLength(1);
    });

    it("throws 422 when explicit source_ids collapse below 2 unique sources", async () => {
      const { service } = createService();

      const a = await service.storeContext({
        content: "Active learning goal: Xcode literacy.",
        module_name: "learning",
        branch_state: "active"
      });

      await expect(
        service.consolidateContext({
          topic: "learning",
          source_ids: [a.id, a.id]
        })
      ).rejects.toThrow("At least 2 source memories are required");
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
