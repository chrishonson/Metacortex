import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { FieldValue, GeoPoint, Timestamp } from "firebase-admin/firestore";

import {
  ARCHIVE_SCHEMA_VERSION,
  restoreMemories,
  validatePortableArchive,
  type ArchiveManifest,
  type ArchivedMemory
} from "../src/archive.js";
import {
  decodeDocument,
  decodeValue,
  encodeDocument,
  encodeValue,
  stableStringify
} from "../scripts/support/firestore-codec.js";
import {
  backupToArchive,
  MANIFEST_SCHEMA,
  MANIFEST_SCHEMA_V1,
  readManifest,
  writeManifest
} from "../scripts/support/firestore-full-mirror.js";
import {
  ArchiveValidationError,
  validateArchive
} from "../scripts/support/mirror-validate.js";
import {
  IncompatibleVectorsError,
  restoreArchive,
  RestoreIncompleteError,
  RestoreTargetError,
  RestoreVerificationError,
  verifyRestore
} from "../scripts/support/mirror-restore.js";
import {
  DocumentReference,
  InMemoryMirrorStore
} from "./support/inMemoryMirrorStore.js";
import {
  getCorpusData,
  seedInMemoryCorpus
} from "./support/recoveryCorpus.js";
import {
  createTestConfig,
  FakeLlmMergeClient,
  FakeMemoryContentPreparer,
  InMemoryMemoryRepository,
  KeywordEmbeddingClient
} from "./support/fakes.js";
import { MetaCortexService } from "../src/service.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("recovery.test.ts - card 71 backup & restore hardening", () => {
  const targetEmbedding = {
    model: "text-embedding-004",
    dimensions: 6
  };

  // Case 1: Discovery
  it("Case 1: discovers root, subcollection, phantom-parent subcollection, unknown collection without hardcoding", async () => {
    const store = new InMemoryMirrorStore("test-source");
    await seedInMemoryCorpus(store);

    const paths = await store.discoverCollectionPaths();
    expect(paths).toEqual([
      "future_collection",
      "ghost_parent",
      "ghost_parent/ghost-doc-1/children",
      "memory_vectors",
      "memory_vectors_write_fingerprints",
      "memory_vectors/doc-1/notes"
    ]);

    // ghost-doc-1 does not exist in ghost_parent (it is phantom)
    const ghostParentDocs = await store.readCollection("ghost_parent");
    expect(ghostParentDocs).toHaveLength(0);
    const ghostChildDocs = await store.readCollection("ghost_parent/ghost-doc-1/children");
    expect(ghostChildDocs).toHaveLength(1);
    expect(ghostChildDocs[0].id).toBe("child-1");
  });

  // Case 2: Backup -> Validate -> Restore -> Verify with field-by-field equality
  it("Case 2: full backup, validation, and restore into separate project with exact type and lineage preservation", async () => {
    const archiveDir = makeTempDir("rec-case-2-");
    const sourceStore = new InMemoryMirrorStore("source-project");
    await seedInMemoryCorpus(sourceStore);

    const manifest = await backupToArchive(sourceStore, archiveDir, {
      embedding: targetEmbedding
    });
    expect(manifest.schema).toBe(MANIFEST_SCHEMA);
    expect(manifest.discovery).toBe("recursive-listCollections");

    // Validate archive
    const validated = validateArchive(archiveDir);
    expect(validated.manifest.collection_paths).toEqual(manifest.collection_paths);

    // Restore into a different project
    const targetStore = new InMemoryMirrorStore("target-project");
    const report = await restoreArchive(targetStore, archiveDir, {
      write: true,
      targetEmbedding
    });

    expect(report.complete).toBe(true);
    expect(report.collections.every(c => c.status === "verified")).toBe(true);

    // Field-by-field assertions
    // 1. memory_vectors
    const memDocs = await targetStore.readCollection("memory_vectors");
    expect(memDocs).toHaveLength(2);
    const doc1 = memDocs.find(d => d.id === "doc-1")!;
    const doc2 = memDocs.find(d => d.id === "doc-2")!;
    expect(doc1.data.content).toBe("Ktor networking is preferred for Kotlin multiplatform clients.");
    expect(doc1.data.retrieval_text).toBe("ktor networking");
    expect((doc1.data.embedding as any).toArray()).toEqual([1, 0, 0, 0, 0, 0]);
    expect((doc1.data.metadata as any).created_time).toBeInstanceOf(Timestamp);
    expect(((doc1.data.metadata as any).created_time as Timestamp).seconds).toBe(1_700_000_000);
    expect(((doc1.data.metadata as any).created_time as Timestamp).nanoseconds).toBe(0);

    // Lineage check: doc2 superseded_by doc1
    expect((doc2.data.metadata as any).superseded_by).toBe("doc-1");
    expect(memDocs.some(d => d.id === (doc2.data.metadata as any).superseded_by)).toBe(true);

    // 2. future_collection (GeoPoint, Buffer, DocumentReference, NaN, Infinity, nested)
    const futureDocs = await targetStore.readCollection("future_collection");
    expect(futureDocs).toHaveLength(1);
    const futureDoc = futureDocs[0];
    expect(futureDoc.data.geo).toBeInstanceOf(GeoPoint);
    expect((futureDoc.data.geo as GeoPoint).latitude).toBeCloseTo(37.7749);
    expect((futureDoc.data.geo as GeoPoint).longitude).toBeCloseTo(-122.4194);

    expect(Buffer.isBuffer(futureDoc.data.bytes)).toBe(true);
    expect((futureDoc.data.bytes as Buffer).toString("utf8")).toBe("binary-payload-data");

    expect(futureDoc.data.ref).toBeInstanceOf(DocumentReference);
    expect((futureDoc.data.ref as DocumentReference).path).toBe("future_collection/doc-unknown");

    expect(Number.isNaN(futureDoc.data.not_a_number)).toBe(true);
    expect(futureDoc.data.pos_inf).toBe(Number.POSITIVE_INFINITY);
    expect(futureDoc.data.neg_inf).toBe(Number.NEGATIVE_INFINITY);

    expect(futureDoc.data.nested_map).toEqual({
      alpha: "hello",
      beta: 42,
      inner: { deep: true }
    });
    expect(futureDoc.data.nested_array).toEqual([1, 2, "three", { x: 10 }]);

    // 3. Phantom parent: ghost_parent has 0 docs, child exists
    const ghostParentDocs = await targetStore.readCollection("ghost_parent");
    expect(ghostParentDocs).toHaveLength(0);
    const ghostChildren = await targetStore.readCollection("ghost_parent/ghost-doc-1/children");
    expect(ghostChildren).toHaveLength(1);
    expect(ghostChildren[0].id).toBe("child-1");
    expect(ghostChildren[0].data.child_name).toBe("Casper");
  });

  // Case 3: Equal-count/different-content corruption
  it("Case 3: detects corruption with sha mismatch on edit, and detects post-restore corruption in target", async () => {
    const archiveDir = makeTempDir("rec-case-3-");
    const sourceStore = new InMemoryMirrorStore("source-project");
    await seedInMemoryCorpus(sourceStore);
    await backupToArchive(sourceStore, archiveDir, { embedding: targetEmbedding });

    // Variant A: Corrupt one doc inside an ndjson file without updating sha
    const ndjsonPath = path.join(archiveDir, "future_collection.ndjson");
    const originalNdjson = fs.readFileSync(ndjsonPath, "utf8");
    const tampered = originalNdjson.replace("hello", "tampered_value");
    expect(tampered).not.toBe(originalNdjson);
    fs.writeFileSync(ndjsonPath, tampered, "utf8");

    // Validation must fail with sha mismatch
    expect(() => validateArchive(archiveDir)).toThrow(ArchiveValidationError);
    try {
      validateArchive(archiveDir);
    } catch (err) {
      const p = (err as ArchiveValidationError).problems;
      expect(p.some(msg => msg.includes("sha256 mismatch"))).toBe(true);
    }

    // Revert tamper
    fs.writeFileSync(ndjsonPath, originalNdjson, "utf8");
    expect(() => validateArchive(archiveDir)).not.toThrow();

    // Variant B: Target corruption after restore
    const targetStore = new InMemoryMirrorStore("target-project");
    await restoreArchive(targetStore, archiveDir, {
      write: true,
      targetEmbedding
    });

    // Mutate one doc in target while preserving count
    const corruptedDocs = await targetStore.readCollection("memory_vectors");
    const docToCorrupt = corruptedDocs.find(d => d.id === "doc-1")!;
    docToCorrupt.data.content = "Corrupted content after restore";
    await targetStore.writeDocuments("memory_vectors", [{ id: "doc-1", data: docToCorrupt.data }]);

    // verifyRestore reports RestoreVerificationError naming the doc id
    await expect(
      verifyRestore(targetStore, archiveDir)
    ).rejects.toThrow(RestoreVerificationError);

    try {
      await verifyRestore(targetStore, archiveDir);
    } catch (err) {
      expect(err).toBeInstanceOf(RestoreVerificationError);
      expect((err as Error).message).toContain("doc-1");
    }
  });

  // Case 4: Validation failures
  it("Case 4: asserts ArchiveValidationError.problems for all validation rules and ensures zero writes before failure", async () => {
    const dir = makeTempDir("rec-case-4-");
    const store = new InMemoryMirrorStore("source-project");
    await seedInMemoryCorpus(store);
    await backupToArchive(store, dir, { embedding: targetEmbedding });

    // 1. Missing file
    const missingFileDir = makeTempDir("rec-case-4-missing-");
    fs.cpSync(dir, missingFileDir, { recursive: true });
    fs.unlinkSync(path.join(missingFileDir, "future_collection.ndjson"));
    try {
      validateArchive(missingFileDir);
      expect.unreachable("expected error");
    } catch (err) {
      expect((err as ArchiveValidationError).problems.some(p => p.includes("missing ndjson file"))).toBe(true);
    }

    // 2. Duplicate _id
    const dupIdDir = makeTempDir("rec-case-4-dupid-");
    fs.cpSync(dir, dupIdDir, { recursive: true });
    const fpFile = path.join(dupIdDir, "memory_vectors_write_fingerprints.ndjson");
    const fpLines = fs.readFileSync(fpFile, "utf8").trim();
    fs.writeFileSync(fpFile, `${fpLines}\n${fpLines}\n`, "utf8");
    // Also update manifest count so count matches line count, isolating duplicate _id check
    const dupManifest = readManifest(dupIdDir);
    dupManifest.collections.find(c => c.path === "memory_vectors_write_fingerprints")!.document_count = 2;
    dupManifest.collections.find(c => c.path === "memory_vectors_write_fingerprints")!.sha256 = "dummy";
    // We expect sha mismatch and duplicate _id
    try {
      validateArchive(dupIdDir);
      expect.unreachable("expected error");
    } catch (err) {
      expect((err as ArchiveValidationError).problems.some(p => p.includes("duplicate _id"))).toBe(true);
    }

    // 3. Line count != document_count
    const countMismatchDir = makeTempDir("rec-case-4-count-");
    fs.cpSync(dir, countMismatchDir, { recursive: true });
    const countManifest = readManifest(countMismatchDir);
    countManifest.collections[0].document_count = 999;
    writeManifest(countMismatchDir, countManifest);
    try {
      validateArchive(countMismatchDir);
      expect.unreachable("expected error");
    } catch (err) {
      expect((err as ArchiveValidationError).problems.some(p => p.includes("document count mismatch"))).toBe(true);
    }

    // 4. Doc missing _id
    const missingIdDir = makeTempDir("rec-case-4-noid-");
    fs.cpSync(dir, missingIdDir, { recursive: true });
    fs.writeFileSync(path.join(missingIdDir, "future_collection.ndjson"), "{\"alpha\": 1}\n", "utf8");
    try {
      validateArchive(missingIdDir);
      expect.unreachable("expected error");
    } catch (err) {
      expect((err as ArchiveValidationError).problems.some(p => p.includes("missing non-empty string _id"))).toBe(true);
    }

    // 5. Unknown __fs tag
    const unknownTagDir = makeTempDir("rec-case-4-unknowntag-");
    fs.cpSync(dir, unknownTagDir, { recursive: true });
    fs.writeFileSync(
      path.join(unknownTagDir, "future_collection.ndjson"),
      "{\"_id\":\"doc-x\",\"bad\":{\"__fs\":\"alien_type\"}}\n",
      "utf8"
    );
    try {
      validateArchive(unknownTagDir);
      expect.unreachable("expected error");
    } catch (err) {
      expect((err as ArchiveValidationError).problems.some(p => p.includes("unknown __fs tag"))).toBe(true);
    }

    // 6. Even path segments
    const evenPathDir = makeTempDir("rec-case-4-evenpath-");
    fs.cpSync(dir, evenPathDir, { recursive: true });
    const evenManifest = readManifest(evenPathDir);
    evenManifest.collection_paths.push("even/segment");
    evenManifest.collections.push({
      path: "even/segment",
      document_count: 0,
      ndjson: "even%2Fsegment.ndjson",
      bytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      vector_dimensions: []
    });
    fs.writeFileSync(path.join(evenPathDir, "even%2Fsegment.ndjson"), "", "utf8");
    writeManifest(evenPathDir, evenManifest);
    try {
      validateArchive(evenPathDir);
      expect.unreachable("expected error");
    } catch (err) {
      expect((err as ArchiveValidationError).problems.some(p => p.includes("invalid collection path"))).toBe(true);
    }

    // 7. Vector dimension disagreeing with the manifest
    const dimMismatchDir = makeTempDir("rec-case-4-dim-");
    fs.cpSync(dir, dimMismatchDir, { recursive: true });
    const dimManifest = readManifest(dimMismatchDir);
    dimManifest.collections.find(c => c.path === "memory_vectors")!.vector_dimensions = [128];
    writeManifest(dimMismatchDir, dimManifest);
    try {
      validateArchive(dimMismatchDir);
      expect.unreachable("expected error");
    } catch (err) {
      expect((err as ArchiveValidationError).problems.some(p => p.includes("vector dimension"))).toBe(true);
    }

    // 8. Malformed JSON line
    const malformedJsonDir = makeTempDir("rec-case-4-json-");
    fs.cpSync(dir, malformedJsonDir, { recursive: true });
    fs.writeFileSync(path.join(malformedJsonDir, "future_collection.ndjson"), "{not-valid-json\n", "utf8");
    try {
      validateArchive(malformedJsonDir);
      expect.unreachable("expected error");
    } catch (err) {
      expect((err as ArchiveValidationError).problems.some(p => p.includes("malformed JSON line"))).toBe(true);
    }

    // 9. Unsupported manifest schema
    const schemaDir = makeTempDir("rec-case-4-schema-");
    fs.cpSync(dir, schemaDir, { recursive: true });
    const schemaManifest = readManifest(schemaDir);
    (schemaManifest as any).schema = "unsupported-schema-v99";
    writeManifest(schemaDir, schemaManifest);
    try {
      validateArchive(schemaDir);
      expect.unreachable("expected error");
    } catch (err) {
      expect((err as ArchiveValidationError).problems.some(p => p.includes("unsupported manifest schema"))).toBe(true);
    }

    // 10. Validation precedes writes assertion: a corrupt archive plus a store shows zero writes
    let writeCalls = 0;
    const writeSpyStore = new InMemoryMirrorStore("spy-project");
    const origWrite = writeSpyStore.writeDocuments.bind(writeSpyStore);
    writeSpyStore.writeDocuments = async (p, docs) => {
      writeCalls += 1;
      return origWrite(p, docs);
    };

    await expect(
      restoreArchive(writeSpyStore, malformedJsonDir, {
        write: true,
        targetEmbedding
      })
    ).rejects.toThrow(ArchiveValidationError);
    expect(writeCalls).toBe(0);
  });

  // Case 5: Target protection
  it("Case 5: enforces target protections, prefixes, prune rules and extra doc reporting", async () => {
    const dir = makeTempDir("rec-case-5-");
    const sourceStore = new InMemoryMirrorStore("source-project");
    await seedInMemoryCorpus(sourceStore);
    await backupToArchive(sourceStore, dir, { embedding: targetEmbedding });

    // 1. Same project without prefix or confirmation throws RestoreTargetError
    const sameProjectStore = new InMemoryMirrorStore("source-project");
    await expect(
      restoreArchive(sameProjectStore, dir, {
        write: true,
        targetEmbedding
      })
    ).rejects.toThrow(RestoreTargetError);

    // 2. Prod project id refused
    const prodStore = new InMemoryMirrorStore("my-brain-88870");
    await expect(
      restoreArchive(prodStore, dir, {
        write: true,
        targetEmbedding
      })
    ).rejects.toThrow(/refusing writes to prod project/);

    // 3. targetPrefix into same project works and leaves original untouched
    const prefixStore = new InMemoryMirrorStore("source-project");
    // Seed original data
    await seedInMemoryCorpus(prefixStore);
    const origFutureDocs = await prefixStore.readCollection("future_collection");
    expect(origFutureDocs).toHaveLength(1);

    const restorePrefixResult = await restoreArchive(prefixStore, dir, {
      write: true,
      targetPrefix: "backup_",
      targetEmbedding
    });
    expect(restorePrefixResult.complete).toBe(true);

    // Check prefixed collections exist
    const prefixedFuture = await prefixStore.readCollection("backup_future_collection");
    expect(prefixedFuture).toHaveLength(1);
    // Original untouched
    const untouchedFuture = await prefixStore.readCollection("future_collection");
    expect(untouchedFuture).toHaveLength(1);

    // 4. Prune/clear without --confirm-project refused
    const targetStore = new InMemoryMirrorStore("target-project");
    await expect(
      restoreArchive(targetStore, dir, {
        write: true,
        targetEmbedding,
        replace: {
          prune: true,
          clearTarget: false,
          confirmProject: undefined
        }
      })
    ).rejects.toThrow(/replacement requires --confirm-project/);

    // 5. Default upsert leaves extra target docs alone and reports extra_target_docs
    const upsertStore = new InMemoryMirrorStore("target-project");
    // Pre-seed an extra doc in memory_vectors
    await upsertStore.writeDocuments("memory_vectors", [
      { id: "extra-doc", data: { content: "I am an extra document", retrieval_text: "extra" } }
    ]);
    const upsertResult = await restoreArchive(upsertStore, dir, {
      write: true,
      targetEmbedding
    });
    expect(upsertResult.complete).toBe(true);
    const memReport = upsertResult.collections.find(c => c.path === "memory_vectors")!;
    expect(memReport.extra_target_docs).toBe(1);
    // Extra doc is still there
    const memAfter = await upsertStore.readCollection("memory_vectors");
    expect(memAfter.some(d => d.id === "extra-doc")).toBe(true);

    // 6. Prune with confirm removes only extra docs inside archived paths, leaves unrelated alone
    await upsertStore.writeDocuments("unrelated_collection", [
      { id: "keep-me", data: { value: "unrelated" } }
    ]);
    const pruneResult = await restoreArchive(upsertStore, dir, {
      write: true,
      targetEmbedding,
      replace: {
        prune: true,
        clearTarget: false,
        confirmProject: "target-project"
      }
    });
    expect(pruneResult.complete).toBe(true);
    // Extra doc was pruned
    const memAfterPrune = await upsertStore.readCollection("memory_vectors");
    expect(memAfterPrune.some(d => d.id === "extra-doc")).toBe(false);
    // Unrelated collection untouched
    const unrelatedDocs = await upsertStore.readCollection("unrelated_collection");
    expect(unrelatedDocs).toHaveLength(1);
    expect(unrelatedDocs[0].id).toBe("keep-me");
  });

  // Case 6: Vector compatibility
  it("Case 6: validates vector compatibility and throws IncompatibleVectorsError before any writes", async () => {
    const dir = makeTempDir("rec-case-6-");
    const sourceStore = new InMemoryMirrorStore("source-project");
    await seedInMemoryCorpus(sourceStore);
    await backupToArchive(sourceStore, dir, { embedding: targetEmbedding });

    let writes = 0;
    const targetStore = new InMemoryMirrorStore("target-project");
    const origWrite = targetStore.writeDocuments.bind(targetStore);
    targetStore.writeDocuments = async (p, docs) => {
      writes += 1;
      return origWrite(p, docs);
    };

    // 1. Mismatched model
    await expect(
      restoreArchive(targetStore, dir, {
        write: true,
        targetEmbedding: { model: "different-model", dimensions: 6 }
      })
    ).rejects.toThrow(IncompatibleVectorsError);
    expect(writes).toBe(0);

    // 2. Mismatched dimensions
    await expect(
      restoreArchive(targetStore, dir, {
        write: true,
        targetEmbedding: { model: "text-embedding-004", dimensions: 768 }
      })
    ).rejects.toThrow(IncompatibleVectorsError);
    expect(writes).toBe(0);

    // 3. Target embedding null when archive has vectors
    await expect(
      restoreArchive(targetStore, dir, {
        write: true,
        targetEmbedding: null
      })
    ).rejects.toThrow(IncompatibleVectorsError);
    expect(writes).toBe(0);

    // 4. v1 manifest without accept flag
    const v1Dir = makeTempDir("rec-case-6-v1-");
    fs.cpSync(dir, v1Dir, { recursive: true });
    const v1Manifest = readManifest(v1Dir);
    (v1Manifest as any).schema = MANIFEST_SCHEMA_V1;
    (v1Manifest as any).embedding = null;
    writeManifest(v1Dir, v1Manifest);
    await expect(
      restoreArchive(targetStore, v1Dir, {
        write: true,
        targetEmbedding
      })
    ).rejects.toThrow(IncompatibleVectorsError);
    expect(writes).toBe(0);

    // v1 with acceptUnknownEmbeddingSpace works
    const v1Accepted = await restoreArchive(targetStore, v1Dir, {
      write: true,
      targetEmbedding,
      acceptUnknownEmbeddingSpace: true
    });
    expect(v1Accepted.complete).toBe(true);

    // 5. Archive with no vectors restores regardless of target embedding
    const noVectorStore = new InMemoryMirrorStore("no-vector-source");
    await noVectorStore.writeDocuments("simple", [{ id: "doc-1", data: { text: "hello" } }]);
    const noVectorDir = makeTempDir("rec-case-6-novectors-");
    await backupToArchive(noVectorStore, noVectorDir, { embedding: null });

    const noVectorTarget = new InMemoryMirrorStore("no-vector-target");
    const noVectorResult = await restoreArchive(noVectorTarget, noVectorDir, {
      write: true,
      targetEmbedding: null
    });
    expect(noVectorResult.complete).toBe(true);
  });

  // Case 7: Interrupted restore
  it("Case 7: handles interrupted restore with RestoreIncompleteError and succeeds upon idempotent retry", async () => {
    const dir = makeTempDir("rec-case-7-");
    const sourceStore = new InMemoryMirrorStore("source-project");
    await seedInMemoryCorpus(sourceStore);
    await backupToArchive(sourceStore, dir, { embedding: targetEmbedding });

    const targetStore = new InMemoryMirrorStore("target-project");
    // Fail after the 1st writeDocuments call
    targetStore.failAfterWrites(1);

    try {
      await restoreArchive(targetStore, dir, {
        write: true,
        targetEmbedding
      });
      expect.unreachable("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(RestoreIncompleteError);
      expect((err as Error).message).toMatch(/^RESTORE INCOMPLETE:/);
      expect((err as Error).message).toContain("re-run the same command to finish; upserts are idempotent");
      const inc = err as RestoreIncompleteError;
      expect(inc.completedCollections).toHaveLength(1);
    }

    // Verify target is partially populated
    const firstCol = (await sourceStore.discoverCollectionPaths())[0];
    const targetDocs = await targetStore.readCollection(firstCol);
    expect(targetDocs.length).toBeGreaterThan(0);

    // Clear fault and re-run: completes and verifies
    targetStore.clearFaults();
    const resumed = await restoreArchive(targetStore, dir, {
      write: true,
      targetEmbedding
    });
    expect(resumed.complete).toBe(true);
    expect(resumed.collections.every(c => c.status === "verified")).toBe(true);
  });

  // Case 8: Retrieval after restore
  it("Case 8: verifies search retrieval over restored memory_vectors repository", async () => {
    const dir = makeTempDir("rec-case-8-");
    const sourceStore = new InMemoryMirrorStore("source-project");
    await seedInMemoryCorpus(sourceStore);
    await backupToArchive(sourceStore, dir, { embedding: targetEmbedding });

    const targetStore = new InMemoryMirrorStore("target-project");
    await restoreArchive(targetStore, dir, {
      write: true,
      targetEmbedding
    });

    const restoredDocs = await targetStore.readCollection("memory_vectors");
    const repository = new InMemoryMemoryRepository();
    repository.seed(
      restoredDocs.map(d => ({
        id: d.id,
        content: d.data.content as string,
        retrieval_text: d.data.retrieval_text as string,
        embedding: d.data.embedding as any,
        metadata: d.data.metadata as any
      }))
    );

    const service = new MetaCortexService(
      new FakeMemoryContentPreparer(),
      new KeywordEmbeddingClient(),
      repository,
      createTestConfig(),
      new FakeLlmMergeClient()
    );

    const searchResult = await service.searchContext({
      query: "ktor networking",
      filter_state: "active"
    });

    expect(searchResult.matches).toHaveLength(1);
    expect(searchResult.matches[0].id).toBe("doc-1");
    expect(searchResult.matches[0].content).toContain("Ktor networking is preferred");

    // doc-2 was deprecated, so searching active branch does not return it
    expect(searchResult.matches.some(r => r.id === "doc-2")).toBe(false);
  });

  // Case 9: Codec round trip and errors
  it("Case 9: tests codec round-trips, unsupported type errors, reserved keys, and stableStringify", () => {
    // 1. Supported types round-trip
    const ref = new DocumentReference("col/doc-1");
    const testDoc = {
      ts: new Timestamp(1234567, 890),
      vec: FieldValue.vector([0.1, 0.2, 0.3]),
      geo: new GeoPoint(10.5, 20.5),
      buf: Buffer.from("hello world"),
      ref,
      nan: Number.NaN,
      posInf: Number.POSITIVE_INFINITY,
      negInf: Number.NEGATIVE_INFINITY,
      nested: { a: 1, b: [2, 3] }
    };

    const encoded = encodeDocument("doc-test", testDoc);
    const decoded = decodeDocument(encoded, p => new DocumentReference(p));
    expect(decoded.id).toBe("doc-test");
    expect(decoded.data.ts).toBeInstanceOf(Timestamp);
    expect((decoded.data.ts as Timestamp).seconds).toBe(1234567);
    expect((decoded.data.ts as Timestamp).nanoseconds).toBe(890);
    expect((decoded.data.vec as any).toArray()).toEqual([0.1, 0.2, 0.3]);
    expect(decoded.data.geo).toBeInstanceOf(GeoPoint);
    expect((decoded.data.geo as GeoPoint).latitude).toBe(10.5);
    expect((decoded.data.buf as Buffer).toString("utf8")).toBe("hello world");
    expect((decoded.data.ref as DocumentReference).path).toBe("col/doc-1");
    expect(Number.isNaN(decoded.data.nan)).toBe(true);
    expect(decoded.data.posInf).toBe(Number.POSITIVE_INFINITY);
    expect(decoded.data.negInf).toBe(Number.NEGATIVE_INFINITY);
    expect(decoded.data.nested).toEqual({ a: 1, b: [2, 3] });

    // 2. Unsupported class instance throws with field path
    class UnrecognizedClass {}
    expect(() =>
      encodeValue({ details: { custom: new UnrecognizedClass() } })
    ).toThrow(/cannot encode value of type UnrecognizedClass at details\.custom/);

    // 3. Reserved __fs key throws
    expect(() =>
      encodeValue({ payload: { __fs: "fake" } })
    ).toThrow(/reserved key "__fs" in field payload\.__fs/);

    // 4. stableStringify ordering
    const objA = { z: 1, b: 2, a: { y: 10, x: 20 } };
    const objB = { a: { x: 20, y: 10 }, z: 1, b: 2 };
    expect(stableStringify(objA)).toBe(stableStringify(objB));
    expect(stableStringify(objA)).toBe("{\"a\":{\"x\":20,\"y\":10},\"b\":2,\"z\":1}");
  });

  // Case 10: Backup manifest written last, stale ndjson removed, error conditions
  it("Case 10: ensures manifest is written last, removes stale ndjson, and verifies backup constraints", async () => {
    const dir = makeTempDir("rec-case-10-");
    const store = new InMemoryMirrorStore("source-project");
    await seedInMemoryCorpus(store);

    // 1. Simulate failure during readCollection of 2nd collection: manifest must NOT exist in fresh dir
    const failDir = makeTempDir("rec-case-10-fail-");
    let callCount = 0;
    const failingStore = new InMemoryMirrorStore("source-project");
    await seedInMemoryCorpus(failingStore);
    const origRead = failingStore.readCollection.bind(failingStore);
    failingStore.readCollection = async p => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("simulated failure reading second collection");
      }
      return origRead(p);
    };

    await expect(
      backupToArchive(failingStore, failDir, { embedding: targetEmbedding })
    ).rejects.toThrow("simulated failure reading second collection");
    expect(fs.existsSync(path.join(failDir, "manifest.json"))).toBe(false);

    // 2. Successful backup removes stale ndjson
    await backupToArchive(store, dir, { embedding: targetEmbedding });
    fs.writeFileSync(path.join(dir, "obsolete%2Fcollection.ndjson"), "old data\n");
    expect(fs.existsSync(path.join(dir, "obsolete%2Fcollection.ndjson"))).toBe(true);

    // Re-run backup: obsolete ndjson removed
    await backupToArchive(store, dir, { embedding: targetEmbedding });
    expect(fs.existsSync(path.join(dir, "obsolete%2Fcollection.ndjson"))).toBe(false);

    // 3. Zero-collection discovery refuses
    const emptyStore = new InMemoryMirrorStore("empty-project");
    await expect(
      backupToArchive(emptyStore, makeTempDir("rec-case-10-empty-"), { embedding: null })
    ).rejects.toThrow(/discovered zero collections/);

    // 4. Vectors found with embedding: null option throws
    await expect(
      backupToArchive(store, makeTempDir("rec-case-10-null-"), { embedding: null })
    ).rejects.toThrow(/archive contains vectors but no embedding configuration was provided/);

    // 5. Manifest embedding null when no vectors
    const noVecStore = new InMemoryMirrorStore("no-vec");
    await noVecStore.writeDocuments("simple", [{ id: "1", data: { text: "hi" } }]);
    const noVecManifest = await backupToArchive(noVecStore, makeTempDir("rec-case-10-no-vec-"), {
      embedding: null
    });
    expect(noVecManifest.embedding).toBeNull();
  });

  // Case 11: Portable archive validation, restore rejection, and interruption
  it("Case 11: tests validatePortableArchive rules, pre-write rejection, and interrupted portable restore", async () => {
    const validMemory: ArchivedMemory = {
      id: "doc-1",
      content: "Valid memory content",
      retrieval_text: "Valid retrieval text",
      metadata: {
        module_name: "android",
        branch_state: "active",
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        modality: "text"
      }
    };

    const validManifest: ArchiveManifest = {
      schema_version: ARCHIVE_SCHEMA_VERSION,
      document_count: 1,
      generated_at: 1_700_000_000_000,
      project_id: "test-proj",
      collection: "memory_vectors",
      state_histogram: { active: 1 },
      embedding_model: "text-embedding-004",
      embedding_dimensions: 768
    };

    // 1. Schema version mismatch
    const badSchemaProblems = validatePortableArchive([validMemory], {
      ...validManifest,
      schema_version: 99
    });
    expect(badSchemaProblems.some(p => p.includes("schema_version mismatch"))).toBe(true);

    // 2. Count mismatch
    const badCountProblems = validatePortableArchive([validMemory], {
      ...validManifest,
      document_count: 5
    });
    expect(badCountProblems.some(p => p.includes("document count mismatch"))).toBe(true);

    // 3. Dangling superseded_by
    const danglingMemory: ArchivedMemory = {
      ...validMemory,
      metadata: {
        ...validMemory.metadata,
        superseded_by: "non-existent-id"
      }
    };
    const danglingProblems = validatePortableArchive([danglingMemory], validManifest);
    expect(danglingProblems.some(p => p.includes("non-existent-id"))).toBe(true);

    // 4. Duplicate id
    const dupProblems = validatePortableArchive([validMemory, validMemory], {
      ...validManifest,
      document_count: 2
    });
    expect(dupProblems.some(p => p.includes("duplicate id in archive"))).toBe(true);

    // 5. restoreMemories with invalid manifest rejects before any writes
    let writeCount = 0;
    const failTarget = {
      async writeMemory() {
        writeCount += 1;
      }
    };
    await expect(
      restoreMemories({
        memories: [danglingMemory],
        embeddings: new KeywordEmbeddingClient(),
        target: failTarget,
        manifest: validManifest
      })
    ).rejects.toThrow(/archive failed validation/);
    expect(writeCount).toBe(0);

    // 6. Interrupted portable restore (throws on 3rd write), then re-run completes idempotently
    const memList: ArchivedMemory[] = [
      { ...validMemory, id: "mem-1" },
      { ...validMemory, id: "mem-2" },
      { ...validMemory, id: "mem-3" },
      { ...validMemory, id: "mem-4" }
    ];
    const manifest4: ArchiveManifest = {
      ...validManifest,
      document_count: 4
    };

    let attempts = 0;
    const writtenIds = new Map<string, ArchivedMemory>();
    const faultTarget = {
      async writeMemory(memory: ArchivedMemory) {
        attempts += 1;
        if (attempts === 3) {
          throw new Error("injected write failure on 3rd write");
        }
        writtenIds.set(memory.id, memory);
      }
    };

    // First attempt fails on 3rd write
    await expect(
      restoreMemories({
        memories: memList,
        embeddings: new KeywordEmbeddingClient(),
        target: faultTarget,
        manifest: manifest4
      })
    ).rejects.toThrow("injected write failure on 3rd write");

    expect(writtenIds.size).toBe(2);

    // Re-run with clean target
    const secondTarget = {
      async writeMemory(memory: ArchivedMemory) {
        writtenIds.set(memory.id, memory);
      }
    };
    const result = await restoreMemories({
      memories: memList,
      embeddings: new KeywordEmbeddingClient(),
      target: secondTarget,
      manifest: manifest4
    });
    expect(result.restored).toBe(4);
    expect(Array.from(writtenIds.keys()).sort()).toEqual(["mem-1", "mem-2", "mem-3", "mem-4"]);
  });
});
