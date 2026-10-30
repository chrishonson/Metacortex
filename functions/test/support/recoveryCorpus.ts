import { FieldValue, GeoPoint, Timestamp, type Firestore } from "firebase-admin/firestore";

import type { InMemoryMirrorStore } from "./inMemoryMirrorStore.js";

export function getCorpusData(refResolver: (path: string) => unknown) {
  const memoryDoc1 = {
    content: "Ktor networking is preferred for Kotlin multiplatform clients.",
    retrieval_text: "ktor networking",
    embedding: FieldValue.vector([1, 0, 0, 0, 0, 0]),
    metadata: {
      module_name: "android",
      branch_state: "active",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      created_time: new Timestamp(1_700_000_000, 0),
      modality: "text"
    }
  };

  const memoryDoc2 = {
    content: "Legacy networking using okhttp directly on android.",
    retrieval_text: "ktor networking",
    embedding: FieldValue.vector([1, 0, 0, 0, 0, 0]),
    metadata: {
      module_name: "android",
      branch_state: "deprecated",
      superseded_by: "doc-1",
      supersession_reason: "changed",
      created_at: 1_690_000_000_000,
      updated_at: 1_700_000_000_000,
      created_time: new Timestamp(1_690_000_000, 0),
      modality: "text"
    }
  };

  const fingerprintDoc = {
    fingerprint: "hash-12345",
    expires_at: new Timestamp(1_700_001_000, 0),
    created_at: 1_700_000_000_000
  };

  const futureDoc = {
    geo: new GeoPoint(37.7749, -122.4194),
    bytes: Buffer.from("binary-payload-data", "utf8"),
    ref: refResolver("future_collection/doc-unknown"),
    not_a_number: Number.NaN,
    pos_inf: Number.POSITIVE_INFINITY,
    neg_inf: Number.NEGATIVE_INFINITY,
    nested_map: {
      alpha: "hello",
      beta: 42,
      inner: { deep: true }
    },
    nested_array: [1, 2, "three", { x: 10 }]
  };

  const noteDoc = {
    note_title: "Note about Ktor",
    created_time: new Timestamp(1_700_000_100, 0)
  };

  const ghostChildDoc = {
    child_name: "Casper",
    is_ghost_child: true
  };

  return {
    memoryDoc1,
    memoryDoc2,
    fingerprintDoc,
    futureDoc,
    noteDoc,
    ghostChildDoc
  };
}

export async function seedFirestoreCorpus(
  firestore: Firestore,
  prefix = ""
): Promise<{
  memoryVectorsPath: string;
  fingerprintsPath: string;
  futurePath: string;
  notesPath: string;
  ghostChildrenPath: string;
}> {
  const p = (col: string) => (prefix ? `${prefix}${col}` : col);
  const memoryVectorsPath = p("memory_vectors");
  const fingerprintsPath = p("memory_vectors_write_fingerprints");
  const futurePath = p("future_collection");
  const notesPath = `${memoryVectorsPath}/doc-1/notes`;
  const ghostChildrenPath = `${p("ghost_parent")}/ghost-doc-1/children`;

  const data = getCorpusData(docPath => firestore.doc(docPath));

  await firestore.collection(memoryVectorsPath).doc("doc-1").set(data.memoryDoc1);
  await firestore.collection(memoryVectorsPath).doc("doc-2").set(data.memoryDoc2);
  await firestore.collection(fingerprintsPath).doc("fp-1").set(data.fingerprintDoc);
  await firestore.collection(futurePath).doc("doc-unknown").set(data.futureDoc);
  await firestore.collection(notesPath).doc("note-1").set(data.noteDoc);
  await firestore.collection(ghostChildrenPath).doc("child-1").set(data.ghostChildDoc);

  return {
    memoryVectorsPath,
    fingerprintsPath,
    futurePath,
    notesPath,
    ghostChildrenPath
  };
}

export async function seedInMemoryCorpus(
  store: InMemoryMirrorStore,
  prefix = ""
): Promise<{
  memoryVectorsPath: string;
  fingerprintsPath: string;
  futurePath: string;
  notesPath: string;
  ghostChildrenPath: string;
}> {
  const p = (col: string) => (prefix ? `${prefix}${col}` : col);
  const memoryVectorsPath = p("memory_vectors");
  const fingerprintsPath = p("memory_vectors_write_fingerprints");
  const futurePath = p("future_collection");
  const notesPath = `${memoryVectorsPath}/doc-1/notes`;
  const ghostParentPath = p("ghost_parent");
  const ghostChildrenPath = `${ghostParentPath}/ghost-doc-1/children`;

  const data = getCorpusData(docPath => store.referenceFor(docPath));

  await store.writeDocuments(memoryVectorsPath, [
    { id: "doc-1", data: data.memoryDoc1 },
    { id: "doc-2", data: data.memoryDoc2 }
  ]);
  await store.writeDocuments(fingerprintsPath, [
    { id: "fp-1", data: data.fingerprintDoc }
  ]);
  await store.writeDocuments(futurePath, [
    { id: "doc-unknown", data: data.futureDoc }
  ]);
  await store.writeDocuments(notesPath, [
    { id: "note-1", data: data.noteDoc }
  ]);
  // Note: ghost-doc-1 is never created in ghost_parent
  store.ensurePath(ghostParentPath);
  await store.writeDocuments(ghostChildrenPath, [
    { id: "child-1", data: data.ghostChildDoc }
  ]);

  return {
    memoryVectorsPath,
    fingerprintsPath,
    futurePath,
    notesPath,
    ghostChildrenPath
  };
}
