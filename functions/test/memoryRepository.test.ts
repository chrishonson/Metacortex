import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

import { FirestoreMemoryRepository } from "../src/memoryRepository.js";
import type { MemoryMetadata } from "../src/types.js";

describe("FirestoreMemoryRepository", () => {
  it("writes separate dedupe and TTL expiration fields for fingerprints", async () => {
    const firestore = new FakeFirestore();
    const repository = new FirestoreMemoryRepository(
      firestore as unknown as Firestore,
      "memory_vectors"
    );
    const now = 1_700_000_000_000;

    await repository.store({
      content: "Ktor networking memory.",
      retrievalText: "Ktor networking memory.",
      embedding: [1, 0, 0],
      idempotencyKey: "fingerprint-1",
      metadata: buildMetadata(now)
    });

    const fingerprint = firestore.getRawDocument(
      "memory_vectors_write_fingerprints",
      "fingerprint-1"
    );

    expect(fingerprint).toMatchObject({
      id: "memory-1",
      dedupe_expires_at: now + 15 * 60 * 1000,
      updated_at: now
    });
    expect(fingerprint?.expires_at).toBeInstanceOf(Date);
    expect((fingerprint?.expires_at as Date).getTime()).toBe(
      now + 30 * 24 * 60 * 60 * 1000
    );
  });

  it("treats legacy numeric fingerprint expires_at as the dedupe window", async () => {
    const firestore = new FakeFirestore();
    const repository = new FirestoreMemoryRepository(
      firestore as unknown as Firestore,
      "memory_vectors"
    );
    const now = 1_700_000_000_000;
    const metadata = buildMetadata(now);

    firestore.setRawDocument("memory_vectors", "memory-existing", {
      content: "Existing Ktor networking memory.",
      retrieval_text: "Existing Ktor networking memory.",
      embedding: [1, 0, 0],
      metadata
    });
    firestore.setRawDocument("memory_vectors_write_fingerprints", "fingerprint-1", {
      id: "memory-existing",
      expires_at: now + 15 * 60 * 1000,
      updated_at: now
    });

    const result = await repository.store({
      content: "New Ktor networking memory.",
      retrievalText: "New Ktor networking memory.",
      embedding: [1, 0, 0],
      idempotencyKey: "fingerprint-1",
      metadata
    });

    expect(result.created).toBe(false);
    expect(result.document.id).toBe("memory-existing");
    expect(result.document.content).toBe("Existing Ktor networking memory.");
  });

  it("does not return a deprecated document as the duplicate of a write in another state", async () => {
    const firestore = new FakeFirestore();
    const repository = new FirestoreMemoryRepository(
      firestore as unknown as Firestore,
      "memory_vectors"
    );
    const now = 1_700_000_000_000;

    firestore.setRawDocument("memory_vectors", "memory-existing", {
      content: "Existing Ktor networking memory.",
      retrieval_text: "Existing Ktor networking memory.",
      embedding: [1, 0, 0],
      metadata: { ...buildMetadata(now), branch_state: "deprecated" }
    });
    firestore.setRawDocument("memory_vectors_write_fingerprints", "fingerprint-1", {
      id: "memory-existing",
      dedupe_expires_at: now + 15 * 60 * 1000,
      updated_at: now
    });

    const result = await repository.store({
      content: "Existing Ktor networking memory.",
      retrievalText: "Existing Ktor networking memory.",
      embedding: [1, 0, 0],
      idempotencyKey: "fingerprint-1",
      metadata: buildMetadata(now)
    });

    expect(result.created).toBe(true);
    expect(result.document.id).not.toBe("memory-existing");
    expect(firestore.getRawDocument("memory_vectors_write_fingerprints", "fingerprint-1")?.id).toBe(
      result.document.id
    );
  });

  describe("deprecate", () => {
    const now = 1_700_000_000_000;

    function seededRepository() {
      const firestore = new FakeFirestore();
      firestore.setRawDocument("memory_vectors", "memory-1", {
        content: "Ktor networking memory.",
        retrieval_text: "Ktor networking memory.",
        embedding: [1, 0, 0],
        metadata: buildMetadata(now)
      });
      const repository = new FirestoreMemoryRepository(
        firestore as unknown as Firestore,
        "memory_vectors"
      );

      return { firestore, repository };
    }

    function storedMetadata(firestore: FakeFirestore): Record<string, unknown> {
      return firestore.getRawDocument("memory_vectors", "memory-1")?.metadata as Record<string, unknown>;
    }

    it("marks the document deprecated and records the replacement and the end of validity", async () => {
      const { firestore, repository } = seededRepository();

      const result = await repository.deprecate("memory-1", "memory-2");

      expect(result.previousState).toBe("active");
      expect(storedMetadata(firestore)).toMatchObject({
        branch_state: "deprecated",
        superseded_by: "memory-2",
        supersession_reason: "changed"
      });
      expect(typeof storedMetadata(firestore).valid_until).toBe("number");
    });

    it("retires a document with no replacement without writing a superseded_by field", async () => {
      const { firestore, repository } = seededRepository();

      await repository.deprecate("memory-1", undefined);

      expect(storedMetadata(firestore).branch_state).toBe("deprecated");
      expect(storedMetadata(firestore)).not.toHaveProperty("superseded_by");
    });

    it("writes nothing when the same deprecation is repeated", async () => {
      const { firestore, repository } = seededRepository();
      const options = { supersessionReason: "corrected", initiator: "user" } as const;
      await repository.deprecate("memory-1", "memory-2", options);
      const before = JSON.stringify(firestore.getRawDocument("memory_vectors", "memory-1"));

      const again = await repository.deprecate("memory-1", "memory-2", options);

      expect(again.previousState).toBe("deprecated");
      expect(JSON.stringify(firestore.getRawDocument("memory_vectors", "memory-1"))).toBe(before);
    });

    it("refuses a deprecation that differs from the one already recorded", async () => {
      const { firestore, repository } = seededRepository();
      await repository.deprecate("memory-1", "memory-2");

      await expect(repository.deprecate("memory-1", "memory-3")).rejects.toMatchObject({ statusCode: 409 });
      expect(storedMetadata(firestore).superseded_by).toBe("memory-2");
    });

    it("reports a missing document as not found", async () => {
      const { repository } = seededRepository();

      await expect(repository.deprecate("missing", "memory-2")).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});

function buildMetadata(now: number): MemoryMetadata {
  return {
    module_name: "kmp-networking",
    branch_state: "active",
    created_at: now,
    updated_at: now,
    modality: "text"
  };
}

class FakeFirestore {
  private readonly collections = new Map<string, Map<string, Record<string, unknown>>>();
  private nextId = 1;

  collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this, name);
  }

  async runTransaction<T>(
    callback: (transaction: FakeTransaction) => Promise<T>
  ): Promise<T> {
    return callback(new FakeTransaction(this));
  }

  getRawDocument(
    collectionName: string,
    documentId: string
  ): Record<string, unknown> | undefined {
    return this.collections.get(collectionName)?.get(documentId);
  }

  setRawDocument(
    collectionName: string,
    documentId: string,
    data: Record<string, unknown>
  ): void {
    this.ensureCollection(collectionName).set(documentId, data);
  }

  createDocumentId(): string {
    return `memory-${this.nextId++}`;
  }

  private ensureCollection(name: string): Map<string, Record<string, unknown>> {
    let collection = this.collections.get(name);

    if (!collection) {
      collection = new Map<string, Record<string, unknown>>();
      this.collections.set(name, collection);
    }

    return collection;
  }
}

class FakeCollectionReference {
  constructor(
    private readonly firestore: FakeFirestore,
    private readonly name: string
  ) {}

  doc(documentId?: string): FakeDocumentReference {
    return new FakeDocumentReference(
      this.firestore,
      this.name,
      documentId ?? this.firestore.createDocumentId()
    );
  }
}

class FakeDocumentReference {
  constructor(
    private readonly firestore: FakeFirestore,
    readonly collectionName: string,
    readonly id: string
  ) {}

  get data(): Record<string, unknown> | undefined {
    return this.firestore.getRawDocument(this.collectionName, this.id);
  }
}

class FakeTransaction {
  constructor(private readonly firestore: FakeFirestore) {}

  async get(ref: FakeDocumentReference): Promise<FakeDocumentSnapshot> {
    return new FakeDocumentSnapshot(ref.id, ref.data);
  }

  set(ref: FakeDocumentReference, data: Record<string, unknown>): void {
    this.firestore.setRawDocument(ref.collectionName, ref.id, data);
  }

  /** Applies Firestore-style updates, where a dotted key such as "metadata.branch_state" reaches a nested field. */
  update(ref: FakeDocumentReference, changes: Record<string, unknown>): void {
    const next = structuredClone(ref.data ?? {}) as Record<string, unknown>;

    for (const [path, value] of Object.entries(changes)) {
      const keys = path.split(".");
      let target = next;

      for (const key of keys.slice(0, -1)) {
        target[key] = { ...((target[key] as Record<string, unknown> | undefined) ?? {}) };
        target = target[key] as Record<string, unknown>;
      }

      target[keys[keys.length - 1]] = value;
    }

    this.firestore.setRawDocument(ref.collectionName, ref.id, next);
  }
}

class FakeDocumentSnapshot {
  constructor(
    readonly id: string,
    private readonly value: Record<string, unknown> | undefined
  ) {}

  get exists(): boolean {
    return Boolean(this.value);
  }

  data(): Record<string, unknown> | undefined {
    return this.value;
  }
}
