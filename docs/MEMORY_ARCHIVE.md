# Portable memory archive

Integrated from completed archive work on `worktree-memory-archive-task1` (`932f730`, cards 58–65). This is existing operator tooling, not the future owner dashboard. See [full backup](FULL_BACKUP.md) for top-level operational collections and [the roadmap](../metacortexplan.md) for recovery hardening.

## Format and behavior

Deterministic NDJSON preserves IDs, canonical/retrieval text, supported metadata/provenance, and media descriptors. It includes deprecated memories. It omits embeddings and re-embeds every record during restore. Raw image bytes are never in the memory store; separately stored artifacts are not copied. Audit/fingerprint/evaluation collections are outside this portable format.

Use a dedicated **private** Git archive repository. The archive is plaintext. Never point it at the source repository or a folder with unrelated staged changes. Use a different directory from a full Firestore backup: the manifest formats are distinct.

## Inspect and export

Supply an explicit project and archive path even though the legacy script has environment/alias/maintainer fallbacks:

```bash
npm --prefix functions run backup:memories -- --project <project-id> --archive-dir <private-archive-path> --dry-run
npm --prefix functions run backup:memories -- --project <project-id> --archive-dir <private-archive-path> --no-push
```

Without `--dry-run`, this writes archive files and commits them. Without `--no-push`, it also pushes to the archive repository. No scheduling or upload is enabled by baseline integration. Operators can explicitly arrange a private schedule; cross-platform scheduling/setup is future work.

The 10% document-count-drop guard rejects suspicious truncation; `--force` overrides it after operator investigation. `METACORTEX_ARCHIVE_DIR` can select the archive path. The deployment preflight warns about portable manifests more than three days old.

## Restore

The script requires `--collection` and defaults to dry-run. Use an explicit scratch project/collection:

```bash
npm --prefix functions run restore:memories -- --project <target-project-id> --archive-dir <private-archive-path> --collection memory_vectors_restore
```

After inspecting the archive and target, add `--write` to re-embed/write. IDs and supported metadata are preserved. The script requires the current config environment, including API-key access for re-embedding; it does not automatically resolve Secret Manager. Provide secrets privately. Ensure the target collection has a matching vector index before querying it.

## Current limitations

- Re-embedding requires model availability and does not promise bit-identical vectors.
- A dimension/model mismatch and a manifest count mismatch currently warn rather than abort.
- Canonical serialization preserves known metadata fields, not arbitrary future fields.
- Reading/writing the whole corpus is not a point-in-time or streaming recovery protocol.
- The script requires a collection name but does **not** prohibit a live collection. Scratch-only restore is operator guidance, not enforced protection.
- Environment loading includes `.env` and `.env.prod`; always explicitly review the target and model settings.

RECOVERY tracks stronger validation, completeness/fidelity gates, compatibility checks, and safer targeting. Do not describe those controls as implemented. Verify restored IDs/content/lineage and retrieval independently; counts alone are insufficient.
