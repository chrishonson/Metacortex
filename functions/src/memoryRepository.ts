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
  retrievalText: string;
  embedding: number[];
  idempotencyKey: string;
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
  store(params: StoreMemoryParams): Promise<{ document: MemoryDocument; created: boolean }>;
  search(params: SearchMemoryParams): Promise<MemoryDocument[]>;
  get(documentId: string): Promise<MemoryDocument | null>;
  deprecate(documentId: string, supersedingDocumentId: string): Promise<{ previousState: BranchState }>;
  getConsolidationQueue(moduleName?: string): Promise<MemoryDocument[]>;
}

interface FirestoreMemoryDocument {
  content: string;
  retrieval_text: string;
  embedding: unknown;
  metadata: MemoryMetadata;
  media?: MemoryMedia;
  distance?: number;
}

interface FirestoreWriteFingerprintDocument {
  document_id: string;
  expires_at: number;
  updated_at: number;
}

const WRITE_FINGERPRINT_WINDOW_MS = 15 * 60 * 1000;

export class FirestoreMemoryRepository implements MemoryRepository {
  private readonly fingerprintCollectionName: string;

  constructor(
    private readonly firestore: Firestore,
    private readonly collectionName: string
  ) {
    this.fingerprintCollectionName = `${collectionName}_write_fingerprints`;
  }

  async store(params: StoreMemoryParams): Promise<{ document: MemoryDocument; created: boolean }> {
    const fingerprintRef = this.firestore
      .collection(this.fingerprintCollectionName)
      .doc(params.idempotencyKey);
    const now = params.metadata.created_at;

    return this.firestore.runTransaction(async transaction => {
      const fingerprintSnapshot = await transaction.get(fingerprintRef);

      if (fingerprintSnapshot.exists) {
        const fingerprint = fingerprintSnapshot.data() as FirestoreWriteFingerprintDocument;

        if (fingerprint.expires_at >= now) {
          const existingSnapshot = await transaction.get(
            this.firestore.collection(this.collectionName).doc(fingerprint.document_id)
          );

          if (existingSnapshot.exists) {
            return {
              document: mapFirestoreDocument(
                existingSnapshot.id,
                existingSnapshot.data() as FirestoreMemoryDocument
              ),
              created: false
            };
          }
        }
      }

      const docRef = this.firestore.collection(this.collectionName).doc();
      transaction.set(docRef, {
        content: params.content,
        retrieval_text: params.retrievalText,
        embedding: FieldValue.vector(params.embedding),
        metadata: params.metadata,
        ...(params.media ? { media: params.media } : {})
      });
      transaction.set(fingerprintRef, {
        document_id: docRef.id,
        expires_at: now + WRITE_FINGERPRINT_WINDOW_MS,
        updated_at: now
      });

      return {
        document: {
          id: docRef.id,
          content: params.content,
          retrieval_text: params.retrievalText,
          metadata: params.metadata,
          media: params.media
        },
        created: true
      };
    });
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

      return mapFirestoreDocument(doc.id, data);
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

    return mapFirestoreDocument(snapshot.id, data);
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
      "metadata.superseded_by": supersedingDocumentId,
      "metadata.updated_at": Date.now()
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
        retrieval_text:
          typeof data.retrieval_text === "string"
            ? data.retrieval_text
            : data.content,
        metadata: data.metadata,
        media: data.media
      };
    });
  }
}

function mapFirestoreDocument(
  id: string,
  data: FirestoreMemoryDocument
): MemoryDocument {
  return {
    id,
    content: data.content,
    retrieval_text:
      typeof data.retrieval_text === "string"
        ? data.retrieval_text
        : data.content,
    metadata: data.metadata,
    media: data.media,
    distance: typeof data.distance === "number" ? data.distance : undefined
  };
}
