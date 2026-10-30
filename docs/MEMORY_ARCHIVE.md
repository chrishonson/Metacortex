# Portable memory archive

Integrated from completed archive work on `worktree-memory-archive-task1` (`932f730`, cards 58-65) and hardened under RECOVERY (card 71). Distinct from [FULL_BACKUP.md](FULL_BACKUP.md), which captures all collections with original vectors and types.

## Format and behavior

Deterministic NDJSON preserves IDs, canonical/retrieval text, supported metadata/provenance, and media descriptors. It includes deprecated memories. It omits embeddings and re-embeds every record during restore with the current model. Raw image bytes are never in the memory store; separately stored artifacts are not copied. Audit/fingerprint/evaluation collections are outside this portable format.

Use a dedicated **private** Git archive repository. The archive is plaintext. Never point it at the source repository or a folder with unrelated staged changes. Use a different directory from a full Firestore backup: the manifest formats are distinct.

## Inspect and export

Supply an explicit project and archive path even though the legacy script has environment/alias/maintainer fallbacks:

```bash
npm --prefix functions run backup:memories -- --project <project-id> --archive-dir <private-archive-path> --dry-run
npm --prefix functions run backup:memories -- --project <project-id> --archive-dir <private-archive-path> --no-push
```

Without `--dry-run`, this writes archive files and commits them. Without `--no-push`, it also pushes to the archive repository.

The 10% document-count-drop guard rejects suspicious truncation; `--force` overrides it after operator investigation. `METACORTEX_ARCHIVE_DIR` can select the archive path.

## Restore and validation

The restore script requires `--collection` and defaults to dry-run mode:

```bash
npm --prefix functions run restore:memories -- --project <target-project-id> --archive-dir <private-archive-path> --collection memory_vectors_restore
```

### Pre-restore semantic validation

Before any Firestore connection is opened or any writes occur (in both dry-run and write modes), the entire archive is validated via `validatePortableArchive`:

- `schema_version` must equal `ARCHIVE_SCHEMA_VERSION`.
- Document count in `memories.ndjson` must match `document_count` in `manifest.json`.
- Every memory must have a non-empty string `id`, non-empty string `content` and `retrieval_text`, and a valid `metadata` object with string `module_name`, string `branch_state`, and finite numeric timestamps `created_at` and `updated_at`.
- Document IDs must be unique across the archive.
- Every `metadata.superseded_by` pointer must resolve to an ID present in the archive (dangling references fail validation).

Any validation failure aborts execution and prints the detected issues.

### Safety guards and live-collection protection

- **Production project refusal:** Restoring to the production project `my-brain-88870` is refused (`assertWritableProject`).
- **Live collection protection:** Restoring into the active live collection (`config.memoryCollection`, default `memory_vectors`) is refused by default. Operators must explicitly supply both `--replace-live` and `--confirm-collection <collection-name>` matching the collection to write into the live memory collection.
- **Interruption behavior:** If an error occurs during re-embedding or writing, the script reports the number of documents restored so far, prints `RESTORE INCOMPLETE; re-run to finish (writes are idempotent by document id)`, and exits with code 1. Re-running resumes cleanly because document writes are keyed by ID.
- **Embedding notice:** A model or dimension difference between the archive manifest and target configuration produces a warning noting that portable import re-embeds records with the current model into the target collection.

## Current limitations

- Re-embedding requires model availability and does not promise bit-identical vectors across model revisions.
- Canonical serialization preserves known metadata fields, not arbitrary future fields.
- Reading and writing the whole corpus is a batch operation, not a point-in-time snapshot or streaming recovery protocol.
- Environment loading includes `.env` and `.env.prod`; always review target and model settings.
