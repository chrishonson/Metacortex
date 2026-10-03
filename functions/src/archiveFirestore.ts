import { FieldValue, type Firestore } from "firebase-admin/firestore";

import type { ArchivedMemory, RestoreTarget } from "./archive.js";
import type { MemoryMedia, MemoryMetadata } from "./types.js";

export function toArchivedMemory(
  id: string,
  data: Record<string, unknown>
): ArchivedMemory {
  const content = typeof data.content === "string" ? data.content : "";
  const retrievalText =
    typeof data.retrieval_text === "string" ? data.retrieval_text : content;

  return {
    id,
    content,
    retrieval_text: retrievalText,
    metadata: data.metadata as MemoryMetadata,
    ...(data.media ? { media: data.media as MemoryMedia } : {})
  };
}

export async function readMemoriesForArchive(
  firestore: Firestore,
  collectionName: string
): Promise<ArchivedMemory[]> {
  const snapshot = await firestore.collection(collectionName).get();

  return snapshot.docs.map(doc =>
    toArchivedMemory(doc.id, doc.data() as Record<string, unknown>)
  );
}

export class FirestoreRestoreTarget implements RestoreTarget {
  constructor(
    private readonly firestore: Firestore,
    private readonly collectionName: string
  ) {}

  async writeMemory(
    memory: ArchivedMemory,
    embedding: number[]
  ): Promise<void> {
    await this.firestore
      .collection(this.collectionName)
      .doc(memory.id)
      .set({
        content: memory.content,
        retrieval_text: memory.retrieval_text,
        embedding: FieldValue.vector(embedding),
        metadata: memory.metadata,
        ...(memory.media ? { media: memory.media } : {})
      });
  }
}
