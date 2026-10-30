export {
  ArchiveValidationError,
  computeSha256,
  extractVectorDimensions,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  MANIFEST_SCHEMA_V1,
  ndjsonFileName,
  parseNdjsonLines,
  readManifest,
  validateArchive,
  type FullBackupCollectionEntry,
  type FullBackupManifest,
  type ValidatedArchive,
  type ValidatedArchiveCollection
} from "./firestore-full-mirror.js";
