import { FieldValue, Firestore } from "firebase-admin/firestore";

import { HttpError } from "./errors.js";
import type {
  BranchState,
  MemoryDocument,
  MemoryMedia,
  MemoryMetadata
} from "./types.js";

export interface StoreMemoryParams {
  content: string;
  embedding: number[];
  metadata: MemoryMetadata;
  media?: MemoryMedia;
}

export interface SearchMemoryParams {
  queryVector: number[];
  limit: number;
  filterModule?: string;
  filterState: string;
}

export interface MemoryRepository {
  store(params: StoreMemoryParams): Promise<{ id: string }>;
  search(params: SearchMemoryParams): Promise<MemoryDocument[]>;
  get(documentId: string): Promise<MemoryDocument | null>;
  deprecate(documentId: string, supersedingDocumentId: string): Promise<{ previousState: BranchState }>;
  getConsolidationQueue(moduleName?: string): Promise<MemoryDocument[]>;
}

interface FirestoreMemoryDocument {
  content: string;
  embedding: unknown;
  metadata: MemoryMetadata;
  media?: MemoryMedia;
  distance?: number;
}

export class FirestoreMemoryRepository implements MemoryRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly collectionName: string
  ) {}

  async store(params: StoreMemoryParams): Promise<{ id: string }> {
    const docRef = await this.firestore.collection(this.collectionName).add({
      content: params.content,
      embedding: FieldValue.vector(params.embedding),
      metadata: params.metadata,
      ...(params.media ? { media: params.media } : {})
    });

    return { id: docRef.id };
  }

  async search(params: SearchMemoryParams): Promise<MemoryDocument[]> {
    let query = this.firestore
      .collection(this.collectionName)
      .where("metadata.branch_state", "==", params.filterState);

    if (params.filterModule) {
      query = query.where("metadata.module_name", "==", params.filterModule);
    }

    const vectorQuery = query.findNearest({
      vectorField: "embedding",
      queryVector: params.queryVector,
      limit: params.limit,
      distanceMeasure: "COSINE",
      distanceResultField: "distance"
    });

    const snapshot = await vectorQuery.get();

    return snapshot.docs.map(doc => {
      const data = doc.data() as FirestoreMemoryDocument;

      return {
        id: doc.id,
        content: data.content,
        metadata: data.metadata,
        media: data.media,
        distance: typeof data.distance === "number" ? data.distance : undefined
      };
    });
  }

  async get(documentId: string): Promise<MemoryDocument | null> {
    const snapshot = await this.firestore
      .collection(this.collectionName)
      .doc(documentId)
      .get();

    if (!snapshot.exists) {
      return null;
    }

    const data = snapshot.data() as FirestoreMemoryDocument;

    return {
      id: snapshot.id,
      content: data.content,
      metadata: data.metadata,
      media: data.media,
      distance: typeof data.distance === "number" ? data.distance : undefined
    };
  }

  async deprecate(
    documentId: string,
    supersedingDocumentId: string
  ): Promise<{ previousState: BranchState }> {
    const docRef = this.firestore
      .collection(this.collectionName)
      .doc(documentId);

    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      throw new HttpError(404, "Document not found");
    }

    const data = snapshot.data() as FirestoreMemoryDocument;
    const previousState = data.metadata.branch_state;

    await docRef.update({
      "metadata.branch_state": "deprecated",
      "metadata.superseded_by": supersedingDocumentId
    });

    return { previousState };
  }

  async getConsolidationQueue(moduleName?: string): Promise<MemoryDocument[]> {
    let query = this.firestore
      .collection(this.collectionName)
      .where("metadata.branch_state", "==", "wip");

    if (moduleName) {
      query = query.where("metadata.module_name", "==", moduleName);
    }

    const snapshot = await query.get();

    return snapshot.docs.map(doc => {
      const data = doc.data() as FirestoreMemoryDocument;

      return {
        id: doc.id,
        content: data.content,
        metadata: data.metadata,
        media: data.media
      };
    });
  }
}
