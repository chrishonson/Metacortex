import { describe, expect, it, vi } from "vitest";

import { formatSearchResults, OpenBrainService } from "../src/service.js";
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
    expect(storedRecord?.metadata.module_name).toBe("kmp-networking");
    expect(storedRecord?.metadata.timestamp).toBe(1_700_000_000_000);
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
    expect(formatSearchResults(result)).toContain("Ktor");
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

    expect(result.metadata.modality).toBe("text_image");
    expect(result.media?.mime_type).toBe("image/png");
    expect(storedRecord?.content).toContain("Visual memory summary");
  });
});
