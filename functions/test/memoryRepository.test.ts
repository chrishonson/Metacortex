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
