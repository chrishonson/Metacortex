import { afterEach, describe, expect, it, vi } from "vitest";

import { MetaCortexService, buildDeprecatePayload } from "../src/service.js";
import {
  createTestConfig,
  FakeLlmMergeClient,
  FakeMemoryContentPreparer,
  InMemoryMemoryRepository,
  KeywordEmbeddingClient
} from "./support/fakes.js";

const T0 = 1_700_000_000_000;

describe("memory lifecycle correctness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createService() {
    const repository = new InMemoryMemoryRepository();
    const mergeClient = new FakeLlmMergeClient();
    const service = new MetaCortexService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig(),
      mergeClient
    );

    return { service, repository, mergeClient };
  }

  describe("saving after a memory was retired", () => {
    it("creates a new memory instead of returning the deprecated one as a duplicate", async () => {
      const { service } = createService();
      const first = await service.saveContext({ content: "Ktor is the networking layer.", topic: "kmp" });
      const replacement = await service.saveContext({ content: "Ktor 3 is the networking layer.", topic: "kmp" });
      await service.deprecateContext({ id: first.id, superseding_id: replacement.id });

      const again = await service.saveContext({ content: "Ktor is the networking layer.", topic: "kmp" });

      expect(again.was_duplicate).toBe(false);
      expect(again.id).not.toBe(first.id);
      expect(again.metadata.branch_state).toBe("active");
    });

    it("still reports a duplicate while the memory is in the requested state", async () => {
      const { service } = createService();
      const first = await service.saveContext({ content: "Ktor is the networking layer.", topic: "kmp" });

      const again = await service.saveContext({ content: "Ktor is the networking layer.", topic: "kmp" });

      expect(again.was_duplicate).toBe(true);
      expect(again.id).toBe(first.id);
    });
  });

  describe("deprecateContext", () => {
    it("retires a memory with no replacement", async () => {
      const { service } = createService();
      const old = await service.saveContext({ content: "Ktor is the networking layer.", topic: "kmp" });

      const result = await service.deprecateContext({ id: old.id });

      expect(result.superseding_id).toBeUndefined();
      const fetched = await service.fetchContext({ id: old.id });
      expect(fetched.item.metadata.branch_state).toBe("deprecated");
      expect(fetched.item.metadata.superseded_by).toBeUndefined();
      expect(JSON.parse(JSON.stringify(buildDeprecatePayload(result)))).toEqual({
        item: { id: old.id, branch_state: "deprecated", supersession_reason: "changed" },
        previous_state: "active"
      });
    });

    it("rejects a memory that supersedes itself", async () => {
      const { service } = createService();
      const old = await service.saveContext({ content: "Ktor is the networking layer.", topic: "kmp" });

      await expect(service.deprecateContext({ id: old.id, superseding_id: old.id })).rejects.toMatchObject({
        statusCode: 400
      });
    });

    it("rejects a replacement that does not exist and leaves the memory active", async () => {
      const { service } = createService();
      const old = await service.saveContext({ content: "Ktor is the networking layer.", topic: "kmp" });

      await expect(
        service.deprecateContext({ id: old.id, superseding_id: "no-such-memory" })
      ).rejects.toMatchObject({ statusCode: 404 });
      expect((await service.fetchContext({ id: old.id })).item.metadata.branch_state).toBe("active");
    });

    it("rejects a supersession that would form a cycle", async () => {
      const { service } = createService();
      const a = await service.saveContext({ content: "Ktor is the networking layer.", topic: "kmp" });
      const b = await service.saveContext({ content: "Ktor 3 is the networking layer.", topic: "kmp" });
      const c = await service.saveContext({ content: "Ktor 4 is the networking layer.", topic: "kmp" });
      await service.deprecateContext({ id: a.id, superseding_id: b.id });
      await service.deprecateContext({ id: b.id, superseding_id: c.id });

      await expect(service.deprecateContext({ id: c.id, superseding_id: a.id })).rejects.toMatchObject({
        statusCode: 409
      });
      expect((await service.fetchContext({ id: c.id })).item.metadata.branch_state).toBe("active");
    });

    it("changes nothing when the same deprecation is repeated", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const { service } = createService();
      const old = await service.saveContext({ content: "Ktor is the networking layer.", topic: "kmp" });
      const replacement = await service.saveContext({ content: "Ktor 3 is the networking layer.", topic: "kmp" });
      await service.deprecateContext({ id: old.id, superseding_id: replacement.id });
      const before = (await service.fetchContext({ id: old.id })).item.metadata;

      vi.setSystemTime(T0 + 600_000);
      const again = await service.deprecateContext({ id: old.id, superseding_id: replacement.id });

      expect(again.previous_state).toBe("deprecated");
      expect((await service.fetchContext({ id: old.id })).item.metadata).toEqual(before);
    });

    it("refuses to overwrite a deprecation that has different details", async () => {
      const { service } = createService();
      const old = await service.saveContext({ content: "Ktor is the networking layer.", topic: "kmp" });
      const first = await service.saveContext({ content: "Ktor 3 is the networking layer.", topic: "kmp" });
      const second = await service.saveContext({ content: "Ktor 4 is the networking layer.", topic: "kmp" });
      await service.deprecateContext({ id: old.id, superseding_id: first.id });

      await expect(
        service.deprecateContext({ id: old.id, superseding_id: second.id })
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await service.fetchContext({ id: old.id })).item.metadata.superseded_by).toBe(first.id);
    });
  });

  describe("consolidateContext when a step fails", () => {
    it("names the merged memory and the unfinished sources, and a retry on them succeeds", async () => {
      const { service, repository } = createService();
      const a = await service.saveContext({ content: "Note A about networking.", topic: "kmp" });
      const b = await service.saveContext({ content: "Note B about networking.", topic: "kmp" });
      const c = await service.saveContext({ content: "Note C about networking.", topic: "kmp" });
      const realDeprecate = repository.deprecate.bind(repository);
      const failing = vi.spyOn(repository, "deprecate").mockImplementation((id, ...rest) => {
        if (id === b.id) {
          return Promise.reject(new Error("firestore unavailable"));
        }
        return realDeprecate(id, ...rest);
      });

      const attempt = service.consolidateContext({ topic: "kmp", source_ids: [a.id, b.id, c.id] });

      await expect(attempt).rejects.toThrow(/merged memory memory-4/);
      await expect(attempt).rejects.toThrow(new RegExp(b.id));
      await expect(attempt).rejects.toThrow(/deprecate_context/);
      const states = async () =>
        Promise.all([a.id, b.id, c.id].map(async id => (await service.fetchContext({ id })).item.metadata.branch_state));
      expect(await states()).toEqual(["deprecated", "active", "active"]);

      failing.mockRestore();
      await service.deprecateContext({ id: b.id, superseding_id: "memory-4" });
      await service.deprecateContext({ id: c.id, superseding_id: "memory-4" });
      expect(await states()).toEqual(["deprecated", "deprecated", "deprecated"]);
    });

    it("rejects a source that is already deprecated before merging anything", async () => {
      const { service, repository } = createService();
      const a = await service.saveContext({ content: "Note A about networking.", topic: "kmp" });
      const b = await service.saveContext({ content: "Note B about networking.", topic: "kmp" });
      await service.deprecateContext({ id: a.id });
      const recordsBefore = repository.listRecords().length;

      await expect(
        service.consolidateContext({ topic: "kmp", source_ids: [a.id, b.id] })
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(a.id) });
      expect(repository.listRecords()).toHaveLength(recordsBefore);
    });
  });

  describe("searchContext with filters applied after the vector search", () => {
    it("looks past closer expired memories when valid_at is set", async () => {
      const { service } = createService();
      for (let i = 0; i < 4; i++) {
        await service.storeContext({
          content: `Ktor networking note ${i}`,
          module_name: "kmp",
          branch_state: "active",
          valid_until: 1_000
        });
      }
      const valid = await service.storeContext({
        content: "Ktor networking with Android and iOS and Firebase",
        module_name: "kmp",
        branch_state: "active"
      });

      const result = await service.searchContext({ query: "ktor networking", valid_at: Date.now(), limit: 1 });

      expect(result.matches.map(match => match.id)).toEqual([valid.id]);
    });

    it("looks past closer memories of another origin when filter_origin is set", async () => {
      const { service } = createService();
      for (let i = 0; i < 4; i++) {
        await service.storeContext({
          content: `Ktor networking note ${i}`,
          module_name: "kmp",
          branch_state: "active",
          origin: "agent_inferred"
        });
      }
      const wanted = await service.storeContext({
        content: "Ktor networking with Android and iOS and Firebase",
        module_name: "kmp",
        branch_state: "active",
        origin: "user_asserted"
      });

      const result = await service.searchContext({
        query: "ktor networking",
        filter_origin: "user_asserted",
        limit: 1
      });

      expect(result.matches.map(match => match.id)).toEqual([wanted.id]);
    });

    it("never returns more than the requested limit", async () => {
      const { service } = createService();
      for (let i = 0; i < 6; i++) {
        await service.storeContext({
          content: `Ktor networking note ${i}`,
          module_name: "kmp",
          branch_state: "active",
          origin: "user_asserted"
        });
      }

      const result = await service.searchContext({
        query: "ktor networking",
        filter_origin: "user_asserted",
        limit: 2
      });

      expect(result.matches).toHaveLength(2);
    });
  });

  describe("listContext pagination", () => {
    async function storeNewestLast(service: MetaCortexService, count: number, originOf: (n: number) => "user_asserted" | "agent_inferred") {
      vi.useFakeTimers({ toFake: ["Date"] });
      const ids: string[] = [];
      for (let n = 1; n <= count; n++) {
        vi.setSystemTime(T0 + n * 1000);
        const stored = await service.storeContext({
          content: `item ${n}`,
          module_name: "general",
          branch_state: "active",
          origin: originOf(n)
        });
        ids.push(stored.id);
      }
      return ids;
    }

    it("returns a null next_cursor when the page ends exactly at the last item", async () => {
      const { service } = createService();
      await storeNewestLast(service, 4, () => "agent_inferred");

      const page1 = await service.listContext({ limit: 2 });
      const page2 = await service.listContext({ limit: 2, cursor: page1.next_cursor! });

      expect(page1.next_cursor).not.toBeNull();
      expect(page2.items).toHaveLength(2);
      expect(page2.next_cursor).toBeNull();
    });

    it("fills a page by scanning past documents of another origin, without skipping or repeating", async () => {
      const { service } = createService();
      const ids = await storeNewestLast(service, 12, n => (n % 4 === 3 ? "user_asserted" : "agent_inferred"));
      const wantedNewestFirst = [ids[10], ids[6], ids[2]];

      const page1 = await service.listContext({ limit: 2, filter_origin: "user_asserted" });
      const page2 = await service.listContext({
        limit: 2,
        filter_origin: "user_asserted",
        cursor: page1.next_cursor!
      });

      expect(page1.items.map(item => item.id)).toEqual(wantedNewestFirst.slice(0, 2));
      expect(page1.next_cursor).not.toBeNull();
      expect(page2.items.map(item => item.id)).toEqual(wantedNewestFirst.slice(2));
      expect(page2.next_cursor).toBeNull();
    });

    it("returns an empty final page with no cursor when nothing matches the origin", async () => {
      const { service } = createService();
      await storeNewestLast(service, 5, () => "agent_inferred");

      const page = await service.listContext({ limit: 2, filter_origin: "user_asserted" });

      expect(page.items).toEqual([]);
      expect(page.next_cursor).toBeNull();
    });
  });
});
