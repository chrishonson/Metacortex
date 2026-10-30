# Full recursive Firestore backup and recovery

Operator tooling for recursive disaster-recovery backups, integrity validation, and safe content-fidelity restore across all Firestore collections. Distinct from [MEMORY_ARCHIVE.md](MEMORY_ARCHIVE.md), which archives only `memory_vectors` without vectors and re-embeds during restore.

Prod `my-brain-88870` is read-only. Restore refuses that project id.

## Format and discovery

Backups use manifest schema `metacortex-firestore-full-backup-v2`.

Discovery is recursive: it discovers top-level collections, subcollections, and subcollections under phantom parents (documents that have subcollections but no parent document payload).

Each collection path is dumped to a deterministic NDJSON file named `encodeURIComponent(path) + ".ndjson"`. Each entry in `manifest.json` records:

- Collection path (odd number of segments).
- Document count.
- NDJSON file name and size in bytes.
- Exact SHA256 hex checksum of the NDJSON file bytes.
- Vector dimensions observed across the collection documents.
- Archive-level embedding space metadata (model and dimensions), or null when no vectors are present.

The manifest is written last so an interrupted backup never leaves an incomplete manifest pointing to partial snapshots.

## Backup

```bash
npm --prefix functions run backup:firestore-full -- \
  --project my-brain-88870 \
  --archive-dir /path/to/archive
```

Pass `--dry-run` to discover paths and counts without writing any files.

Backup discovers collections recursively, verifies that dumped document counts match live counts, encodes typed Firestore values (Timestamps, VectorValues, GeoPoints, Buffers, DocumentReferences, and non-finite numbers), computes checksums, writes NDJSON files, writes `manifest.json`, and cleans up stale NDJSON files from prior runs.

## Archive validation before writes

Before any target mutation or live restoration, `validateArchive` verifies the archive on disk:

1. Manifest readability, valid schema (`metacortex-firestore-full-backup-v2` or legacy `v1`), and consistent path ordering.
2. File existence, derived file names, and byte SHA256 checksum matches against manifest entries.
3. NDJSON JSON syntax, non-empty string `_id` presence, id uniqueness, and document count equality.
4. Structural decoding of all documents and tags via `decodeDocument`. Unknown `__fs` tags or malformed tag payloads are rejected immediately.
5. Observed vector dimensions equal manifest entries, and observed vector dimensions match the manifest embedding space.

Validation failures abort immediately with a complete list of detected problems before any write operations occur.

## Restore

Restore defaults to dry-run mode. `--write` is required to mutate the target database.

```bash
npm --prefix functions run restore:firestore-full -- \
  --project metacortex-qa \
  --archive-dir /path/to/archive \
  --write
```

### Safety and target guards

- **Separate-target default:** Restoring directly into the source project is refused unless `--target-prefix <prefix>` is provided or explicit replacement confirmation is passed.
- **Upsert-only default:** Restore defaults to safe upserts (create or overwrite documents by id). Existing extra documents on the target are left untouched.
- **Explicit replacement confirmation:** `--prune` (deleting target documents whose ids are absent from the archive) and `--clear-target-collections` (wiping collections before restore) require `--confirm-project <target-project-id>`.
- **Target prefixing:** `--target-prefix <prefix>` prepends `<prefix>` to the root collection segment of each path (e.g. `memory_vectors/doc1/notes` becomes `test_memory_vectors/doc1/notes`), allowing safe testing inside an existing project.
- **Vector compatibility guard:** If the archive contains vectors, restore checks that target embedding model and dimensions match the archive. On mismatch or unknown embedding space, restore aborts before any write and recommends portable import (`npm run restore:memories`), which re-embeds records with the current model into a separate collection. Passing `--accept-unknown-embedding-space` overrides this check for legacy v1 archives.

### Interruption and recovery

If a write failure occurs during restore, the command halts and prints `RESTORE INCOMPLETE: <underlying error>. re-run the same command to finish; upserts are idempotent`.

Because document writes are keyed by id, re-running the same restore command resumes and completes recovery safely.

### Content-fidelity verification

After writing, restore runs verification across every archived collection:

- Reads back the stored documents from the target.
- Verifies document equality and field content against the archive using stable JSON stringification.
- For v2 archives, verifies that the target content SHA256 matches the archive SHA256 checksum.
- When prune is not requested, extra target documents are reported as `extra_target_docs` rather than a failure. When prune is requested, extra target documents cause a verification failure.
- Reports differing document IDs (missing, extra, changed, capped at 20 IDs each).

A restore run is considered complete only when verification passes for all collections.

## Legacy v1 archive compatibility

The restore engine supports legacy v1 manifests (`metacortex-firestore-full-backup-v1`). Legacy manifests are normalized in memory, collection IDs are treated as paths, checksums and vector dimensions are computed during validation, and per-document equality verification is performed using canonical stable stringification.

## Inventory gate

The inventory gate verifies recursive collection discovery, matching document counts, and matching content SHA256 hashes across source and target projects:

```bash
npm --prefix functions run gate:firestore-inventory -- \
  --source-project my-brain-88870 \
  --target-project metacortex-qa \
  --out /path/to/inventory-gate.json
```

The gate succeeds only when all source collections exist on the target with equal document counts and identical content SHA256 checksums.

## Known limitations

1. Firestore integer vs double distinction is not preserved by the Admin SDK read path.
2. DocumentReference values are restored with their original absolute paths and are not remapped by `--target-prefix`.
3. Field transforms, composite indexes, rules, TTL policies, and security rules are not part of the document archive.
4. Verification covers Firestore documents, not Cloud Storage objects or Firebase Authentication users.
5. Restore is not atomic across collections. In the event of an interruption, resume by re-running the restore command.
6. Live production restore was not exercised.
