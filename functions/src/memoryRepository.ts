import { FieldValue, Firestore } from "firebase-admin/firestore";

import type {
  MemoryDocument,
  MemoryMetadata
} from "./types.js";

export interface StoreMemoryParams {
  content: string;
  embedding: number[];
  metadata: MemoryMetadata;
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
}

interface FirestoreMemoryDocument {
  content: string;
  embedding: unknown;
  metadata: MemoryMetadata;
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
      metadata: params.metadata
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
        distance: typeof data.distance === "number" ? data.distance : undefined
      };
    });
  }
}
