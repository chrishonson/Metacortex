import { FieldValue, GeoPoint, Timestamp } from "firebase-admin/firestore";

import {
  isBytes,
  isDocumentReference,
  isGeoPoint,
  isVectorValue
} from "../../scripts/support/firestore-codec.js";
import {
  assertValidCollectionPath,
  assertWritableProject,
  type MirrorDocument,
  type MirrorStore
} from "../../scripts/support/mirror-store.js";

export class DocumentReference {
  constructor(
    readonly path: string,
    readonly firestore: object = {}
  ) {}
}

export function deepCopyValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Timestamp) {
    return new Timestamp(value.seconds, value.nanoseconds);
  }

  if (isVectorValue(value)) {
    return FieldValue.vector(value.toArray());
  }

  if (isGeoPoint(value)) {
    return new GeoPoint(value.latitude, value.longitude);
  }

  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (isDocumentReference(value)) {
    return new DocumentReference(value.path, value.firestore);
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (Array.isArray(value)) {
    return value.map(deepCopyValue);
  }

  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = deepCopyValue(nested);
  }
  return copy;
}

export class InMemoryMirrorStore implements MirrorStore {
  private readonly collections = new Map<string, Map<string, Record<string, unknown>>>();
  // Fault injection: number of writeDocuments calls allowed before throwing.
  // One call = one batch/collection chunk.
  private writesRemainingBeforeFailure: number | null = null;

  constructor(readonly projectId: string) {}

  failAfterWrites(n: number): void {
    this.writesRemainingBeforeFailure = n;
  }

  clearFaults(): void {
    this.writesRemainingBeforeFailure = null;
  }

  ensurePath(path: string): void {
    assertValidCollectionPath(path);
    const segments = path.split("/");
    for (let i = 1; i <= segments.length; i += 2) {
      const subPath = segments.slice(0, i).join("/");
      if (!this.collections.has(subPath)) {
        this.collections.set(subPath, new Map());
      }
    }
  }

  async discoverCollectionPaths(): Promise<string[]> {
    return Array.from(this.collections.keys()).sort((left, right) =>
      left.localeCompare(right)
    );
  }

  async readCollection(path: string): Promise<MirrorDocument[]> {
    assertValidCollectionPath(path);
    const col = this.collections.get(path);
    if (!col) {
      return [];
    }
    const docs: MirrorDocument[] = [];
    for (const [id, data] of col.entries()) {
      docs.push({
        id,
        data: deepCopyValue(data) as Record<string, unknown>
      });
    }
    docs.sort((left, right) => left.id.localeCompare(right.id));
    return docs;
  }

  async countDocuments(path: string): Promise<number> {
    assertValidCollectionPath(path);
    return this.collections.get(path)?.size ?? 0;
  }

  async listDocumentIds(path: string): Promise<string[]> {
    assertValidCollectionPath(path);
    const col = this.collections.get(path);
    if (!col) {
      return [];
    }
    return Array.from(col.keys()).sort((left, right) => left.localeCompare(right));
  }

  async writeDocuments(path: string, docs: MirrorDocument[]): Promise<number> {
    assertValidCollectionPath(path);
    assertWritableProject(this.projectId);

    // One call = one batch/collection chunk.
    if (this.writesRemainingBeforeFailure !== null) {
      if (this.writesRemainingBeforeFailure <= 0) {
        throw new Error("injected failure");
      }
      this.writesRemainingBeforeFailure -= 1;
    }

    this.ensurePath(path);
    const col = this.collections.get(path)!;
    for (const doc of docs) {
      col.set(doc.id, deepCopyValue(doc.data) as Record<string, unknown>);
    }
    return docs.length;
  }

  async deleteDocuments(path: string, ids: string[]): Promise<number> {
    assertValidCollectionPath(path);
    assertWritableProject(this.projectId);
    const col = this.collections.get(path);
    if (!col) {
      return 0;
    }
    let deleted = 0;
    for (const id of ids) {
      if (col.delete(id)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  referenceFor(path: string): unknown {
    return new DocumentReference(path);
  }
}
