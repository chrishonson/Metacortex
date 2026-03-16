import { describe, expect, it, vi } from "vitest";

import {
  buildFetchPayload,
  buildSearchPayload,
  OpenBrainService
} from "../src/service.js";
import { createTestConfig } from "./support/fakes.js";
import {
  FakeMemoryContentPreparer,
  InMemoryMemoryRepository,
  KeywordEmbeddingClient
} from "./support/fakes.js";

describe("OpenBrainService", () => {
  it("stores normalized content with generated metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    const result = await service.storeContext({
      content: "  Architectural decision: Use Ktor for networking.  ",
      artifact_type: "DECISION",
      module_name: "  kmp-networking  ",
      branch_state: "active"
    });

    const storedRecord = repository.listRecords()[0];

    expect(result.id).toBe("memory-1");
    expect(storedRecord?.content).toBe(
      "Architectural decision: Use Ktor for networking."
    );
    expect(storedRecord?.retrieval_text).toBe(
      "Architectural decision: Use Ktor for networking."
    );
    expect(storedRecord?.metadata.module_name).toBe("kmp-networking");
    expect(storedRecord?.metadata.created_at).toBe(1_700_000_000_000);
    expect(storedRecord?.metadata.updated_at).toBe(1_700_000_000_000);
  });

  it("searches with the default active filter and formats results", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    await service.storeContext({
      content: "We are using Ktor for the Android and iOS networking layer.",
      artifact_type: "DECISION",
      module_name: "kmp-networking",
      branch_state: "active"
    });

    await service.storeContext({
      content: "Jetpack Compose is the UI layer for Android.",
      artifact_type: "PATTERN",
      module_name: "jetpack-compose-ui",
      branch_state: "wip"
    });

    const result = await service.searchContext({
      query: "networking decision for Android and iOS"
    });

    expect(result.appliedFilters.filter_state).toBe("active");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.metadata.module_name).toBe("kmp-networking");
    expect(buildSearchPayload(result)).toMatchObject({
      matches: [
        {
          id: "memory-1",
          summary: expect.stringContaining("Ktor"),
          metadata: {
            module_name: "kmp-networking",
            memory_type: "decision",
            branch_state: "active",
            modality: "text"
          }
        }
      ],
      applied_filters: {
        filter_module: null,
        filter_state: "active"
      }
    });
  });

  it("remembers browser-written context with friendly defaults", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    const result = await service.rememberContext({
      content: "We use Ktor for shared Android and iOS networking."
    });

    expect(result.metadata.module_name).toBe("general");
    expect(result.metadata.branch_state).toBe("active");
    expect(result.metadata.memory_type).toBe("decision");
    expect(result.was_duplicate).toBe(false);
  });

  it("stores drafts as wip when remembering context", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    const result = await service.rememberContext({
      content: "Draft notes about auth rate limiting.",
      topic: "auth",
      draft: true
    });

    expect(result.metadata.module_name).toBe("auth");
    expect(result.metadata.branch_state).toBe("wip");
  });

  it("accepts public memory_type values like preference", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    const result = await service.rememberContext({
      content: "We prefer concise release notes in memory fetches.",
      topic: "nanobot",
      memory_type: "preference"
    });

    expect(result.metadata.memory_type).toBe("preference");
    expect(result.metadata.artifact_type).toBe("DECISION");
  });

  it("stores image-backed memories as multimodal retrieval text", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    const result = await service.storeContext({
      content: "Compose settings screen screenshot",
      artifact_type: "PATTERN",
      module_name: "jetpack-compose-ui",
      branch_state: "active",
      image_base64: "ZmFrZS1pbWFnZS1ieXRlcw==",
      image_mime_type: "image/png"
    });

    const storedRecord = repository.listRecords()[0];

    expect(result.metadata.modality).toBe("mixed");
    expect(result.media?.mime_type).toBe("image/png");
    expect(storedRecord?.content).toBe("Compose settings screen screenshot");
    expect(storedRecord?.retrieval_text).toContain("Visual memory summary");
  });

  it("stores artifact_refs when provided", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    const result = await service.storeContext({
      content: "Architecture diagram for auth module",
      artifact_type: "SPEC",
      module_name: "ui-auth",
      branch_state: "active",
      artifact_refs: ["gs://bucket/arch-diagram.png"]
    });

    const storedRecord = repository.listRecords()[0];
    expect(result.metadata.artifact_refs).toEqual(["gs://bucket/arch-diagram.png"]);
    expect(storedRecord?.metadata.artifact_refs).toEqual(["gs://bucket/arch-diagram.png"]);
  });

  it("includes artifact_refs in formatted search results", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    await service.storeContext({
      content: "Compose settings screen screenshot",
      artifact_type: "PATTERN",
      module_name: "jetpack-compose-ui",
      branch_state: "active",
      artifact_refs: ["gs://bucket/settings-screen.png"]
    });

    const result = await service.searchContext({
      query: "compose settings screenshot"
    });

    expect(buildSearchPayload(result)).toMatchObject({
      matches: [
        {
          metadata: {
            artifact_refs: ["gs://bucket/settings-screen.png"]
          }
        }
      ]
    });
  });

  it("returns an empty search payload on miss", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    const result = await service.searchContext({
      query: "missing memory query"
    });

    expect(buildSearchPayload(result)).toEqual({
      matches: [],
      applied_filters: {
        filter_module: null,
        filter_state: "active"
      }
    });
  });

  it("deprecates a document and records superseding ID", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    await service.storeContext({
      content: "Old networking approach using URLSession.",
      artifact_type: "DECISION",
      module_name: "kmp-networking",
      branch_state: "active"
    });

    const newDoc = await service.storeContext({
      content: "Switched to Ktor for cross-platform networking.",
      artifact_type: "DECISION",
      module_name: "kmp-networking",
      branch_state: "active"
    });

    const result = await service.deprecateContext({
      document_id: "memory-1",
      superseding_document_id: newDoc.id
    });

    expect(result.previous_state).toBe("active");
    expect(result.document_id).toBe("memory-1");
    expect(result.superseding_document_id).toBe(newDoc.id);

    const storedRecord = repository.listRecords()[0];
    expect(storedRecord?.metadata.branch_state).toBe("deprecated");
    expect(storedRecord?.metadata.superseded_by).toBe(newDoc.id);
    expect(storedRecord?.metadata.updated_at).toBe(1_700_000_000_000);
  });

  it("fetches a stored memory by document id", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    const stored = await service.rememberContext({
      content: "We use Firestore vector indexes for retrieval.",
      topic: "memory-infra",
      artifact_refs: ["gs://bucket/vector-notes.md"]
    });

    const result = await service.fetchContext({
      document_id: stored.id
    });

    expect(result.item.id).toBe(stored.id);
    expect(result.item.metadata.module_name).toBe("memory-infra");
    expect(result.item.metadata.artifact_refs).toEqual([
      "gs://bucket/vector-notes.md"
    ]);
    expect(buildFetchPayload(result)).toMatchObject({
      item: {
        id: stored.id,
        content: "We use Firestore vector indexes for retrieval.",
        retrieval_text: "We use Firestore vector indexes for retrieval.",
        metadata: {
          module_name: "memory-infra",
          memory_type: "decision",
          artifact_refs: ["gs://bucket/vector-notes.md"]
        }
      }
    });
  });

  it("reuses the same document for exact duplicate writes within the idempotency window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    const first = await service.rememberContext({
      content: "We use Ktor for shared Android and iOS networking.",
      topic: "kmp-networking"
    });
    const second = await service.rememberContext({
      content: "We use Ktor for shared Android and iOS networking.",
      topic: "kmp-networking"
    });

    expect(first.id).toBe(second.id);
    expect(first.was_duplicate).toBe(false);
    expect(second.was_duplicate).toBe(true);
    expect(repository.listRecords()).toHaveLength(1);
  });

  it("returns WIP items from consolidation queue", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new OpenBrainService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig()
    );

    await service.storeContext({
      content: "Active spec that should not appear.",
      artifact_type: "SPEC",
      module_name: "kmp-networking",
      branch_state: "active"
    });

    await service.storeContext({
      content: "Rough notes about auth flow.",
      artifact_type: "DECISION",
      module_name: "ui-auth",
      branch_state: "wip"
    });

    await service.storeContext({
      content: "Draft networking pattern.",
      artifact_type: "PATTERN",
      module_name: "kmp-networking",
      branch_state: "wip"
    });

    const allWip = await service.getConsolidationQueue({});
    expect(allWip.items).toHaveLength(2);

    const networkingWip = await service.getConsolidationQueue({
      module_name: "kmp-networking"
    });
    expect(networkingWip.items).toHaveLength(1);
    expect(networkingWip.items[0]?.content).toContain("Draft networking pattern");
    expect(networkingWip.filter_module).toBe("kmp-networking");
  });
});
