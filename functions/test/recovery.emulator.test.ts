import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { GeoPoint, Timestamp } from "firebase-admin/firestore";

import {
  backupToArchive,
  openFirestore,
  restoreArchive,
  RestoreVerificationError,
  verifyRestore
} from "../scripts/support/firestore-full-mirror.js";
import { FirestoreMirrorStore } from "../scripts/support/mirror-store.js";
import { FirestoreMemoryRepository } from "../src/memoryRepository.js";
import { seedFirestoreCorpus } from "./support/recoveryCorpus.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function clearEmulatorData(projectId: string): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    return;
  }
  try {
    await fetch(
      `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
      { method: "DELETE" }
    );
  } catch {
    // best-effort cleanup
  }
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  "recovery.emulator.test.ts - Firestore emulator recovery test",
  () => {
    const sourceProjectId = "demo-recovery-source";
    const targetProjectId = "demo-recovery-target";
    const runPrefix = `emu_${Date.now()}_`;

    const sourceDb = openFirestore(sourceProjectId, "emu-source-role");
    const targetDb = openFirestore(targetProjectId, "emu-target-role");

    const sourceStore = new FirestoreMirrorStore(sourceDb);
    const targetStore = new FirestoreMirrorStore(targetDb);

    afterAll(async () => {
      await clearEmulatorData(sourceProjectId);
      await clearEmulatorData(targetProjectId);
    });

    it("runs full recursive discovery, backup, restore, corruption detection, and vector search on emulator", async () => {
      const archiveDir = makeTempDir("emu-recovery-");

      // 1. Seed corpus on source
      const paths = await seedFirestoreCorpus(sourceDb, runPrefix);

      // 2. Recursive discovery including phantom parent
      const discoveredPaths = await sourceStore.discoverCollectionPaths();
      expect(discoveredPaths).toContain(paths.memoryVectorsPath);
      expect(discoveredPaths).toContain(paths.fingerprintsPath);
      expect(discoveredPaths).toContain(paths.futurePath);
      expect(discoveredPaths).toContain(paths.notesPath);
      expect(discoveredPaths).toContain(paths.ghostChildrenPath);

      // Verify phantom parent doc does not exist
      const ghostParentPath = `${runPrefix}ghost_parent`;
      const ghostParentSnap = await sourceDb.collection(ghostParentPath).get();
      expect(ghostParentSnap.empty).toBe(true);
      // But child exists
      const ghostChildSnap = await sourceDb.collection(paths.ghostChildrenPath).get();
      expect(ghostChildSnap.size).toBe(1);

      // 3. Backup to archive
      const manifest = await backupToArchive(sourceStore, archiveDir, {
        embedding: {
          model: "text-embedding-004",
          dimensions: 6
        }
      });
      expect(manifest.discovery).toBe("recursive-listCollections");
      expect(manifest.collection_paths).toContain(paths.memoryVectorsPath);

      // 4. Restore into target project
      const restoreReport = await restoreArchive(targetStore, archiveDir, {
        write: true,
        targetEmbedding: {
          model: "text-embedding-004",
          dimensions: 6
        }
      });
      expect(restoreReport.complete).toBe(true);

      // 5. Verify real Firestore types on target
      const memSnap = await targetDb.collection(paths.memoryVectorsPath).doc("doc-1").get();
      expect(memSnap.exists).toBe(true);
      const memData = memSnap.data()!;
      expect(memData.content).toContain("Ktor networking");
      expect(memData.metadata.created_time).toBeInstanceOf(Timestamp);

      const futureSnap = await targetDb.collection(paths.futurePath).doc("doc-unknown").get();
      expect(futureSnap.exists).toBe(true);
      const futureData = futureSnap.data()!;
      expect(futureData.geo).toBeInstanceOf(GeoPoint);
      expect(futureData.geo.latitude).toBeCloseTo(37.7749);
      expect(futureData.geo.longitude).toBeCloseTo(-122.4194);
      expect(Buffer.isBuffer(futureData.bytes)).toBe(true);
      expect((futureData.bytes as Buffer).toString("utf8")).toBe("binary-payload-data");
      expect(typeof futureData.ref).toBe("object");
      expect(futureData.ref.path).toContain("future_collection/doc-unknown");

      // 6. Content corruption detection on target
      await targetDb.collection(paths.memoryVectorsPath).doc("doc-1").update({
        content: "Corrupted content in live target"
      });
      await expect(
        verifyRestore(targetStore, archiveDir)
      ).rejects.toThrow(RestoreVerificationError);

      // Restore back so vector search can be exercised
      await targetDb.collection(paths.memoryVectorsPath).doc("doc-1").update({
        content: memData.content
      });
      const reverified = await verifyRestore(targetStore, archiveDir);
      expect(reverified.complete).toBe(true);

      // 7. Vector search via FirestoreMemoryRepository without re-embedding
      const repository = new FirestoreMemoryRepository(targetDb, paths.memoryVectorsPath);
      const searchResults = await repository.search({
        queryVector: [1, 0, 0, 0, 0, 0],
        limit: 5,
        filterState: "active"
      });
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0].id).toBe("doc-1");
      expect(searchResults[0].content).toContain("Ktor networking is preferred");
    });
  }
);
