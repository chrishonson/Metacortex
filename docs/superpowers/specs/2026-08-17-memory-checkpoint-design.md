> Historical archive design/implementation record, retained from the completed archive branch. The current roadmap is [metacortexplan.md](../../../metacortexplan.md). Current behavior and limitations are in [MEMORY_ARCHIVE.md](../../MEMORY_ARCHIVE.md) and [FULL_BACKUP.md](../../FULL_BACKUP.md). Old task checkboxes are not the active backlog.

# Memory Checkpoint: Portable Off-GCP Archive

Date: 2026-08-17
Status: Approved design, pending implementation plan

## Problem

Firestore is the only copy of the MetaCortex memory store. The collection holds roughly 150 documents (~52 active, ~91 deprecated as of the 2026-07-13 coherence review) accumulated over months, and none of it is reproducible. Loss of the `my-brain-88870` project — deletion, billing lapse, compromised service account, or Google-side failure — is total and permanent.

The store is also, by design, append-only in spirit: `deprecate_context` is a soft supersession and nothing is ever hard-deleted. That protects against bad *logical* writes, but offers nothing against loss of the underlying database.

## Goals

Produce a portable, self-describing, version-controlled archive of the memory store that lives outside GCP entirely and can be restored into a fresh Firebase project — or read by something that is not MetaCortex at all.

## Non-goals

- **Firestore-native backups and PITR.** Explicitly out of scope. The archive is the only recovery layer.
- **Backing up `memory_events`.** An unbounded observability audit trail, not durable state.
- **Backing up `memory_vectors_write_fingerprints`.** Ephemeral TTL data with a 30-day expiry; regenerating it is a no-op.
- **Point-in-time granularity finer than a run.** Recovery granularity is "last successful archive run." See Risks.

## Accepted consequence

With no Firestore-native layer, recovery granularity is the archive cadence. A bad `consolidate_context` on Tuesday is unrecoverable if the last run was Sunday. This is why the cadence is daily rather than weekly, and why the staleness check is part of the deliverable rather than a nice-to-have.

## Architecture

Two scripts plus a manifest, following the established `functions/scripts/*.mjs` pattern (`backfill-firestore-provenance.mjs` is the reference: firebase-admin over ADC, `.env` / `.env.prod` loading, `--write` style flags).

```
functions/scripts/backup-memories.mjs    →  $METACORTEX_ARCHIVE_DIR/memories.ndjson
                                            $METACORTEX_ARCHIVE_DIR/manifest.json
functions/scripts/restore-memories.mjs   ←  reads both, re-embeds, writes to Firestore
```

The archive directory is a **separate private git repository**, not this one. `metacortex` is shared and carries PRs; memory content is personal. Git history is the retention policy — no lifecycle rules, no bucket configuration, and diffs that show exactly which memories changed between runs.

### Why the embedding is not archived

`service.ts:55` embeds `preparedContent.retrieval_text`, and `retrieval_text` is persisted verbatim on the document. The embedding is therefore a pure function of archived data plus the configured model and dimensions. Re-embedding on restore reproduces the same vector when the model is unchanged, so retrieval behavior is preserved exactly.

Archiving 768 floats per document would multiply file size roughly fivefold, make git diffs unreadable, and pin the cold archive to a single vector space — the one thing the project's own constraints say never to mix. Re-embedding is also mandatory on any model or dimension change, so restore needs the capability regardless.

Cost of the tradeoff: restore requires a working `GEMINI_API_KEY` and takes minutes rather than seconds, for roughly 150 embed calls.

### Why image bytes are not archived

`FirestoreMemoryRepository.store` persists `media` as `{kind, mime_type}` only (`memoryRepository.ts:110`). Source images are normalized to text by `GeminiMultimodalPreparer` at write time and the bytes are discarded before storage. Text plus metadata is therefore complete fidelity — there is nothing else to lose.

## Data format

`memories.ndjson` — one JSON object per line, sorted by document id, with keys emitted in a fixed order at every level. Determinism is a hard requirement: an unchanged store must produce a byte-identical file, or the git diff stops carrying signal.

```json
{
  "id": "DSFBIyUni6OGhySMkbHw",
  "content": "...",
  "retrieval_text": "...",
  "metadata": {
    "module_name": "archive",
    "branch_state": "active",
    "created_at": 1768329964448,
    "updated_at": 1768329964448,
    "modality": "text",
    "provenance": { "origin": "agent_inferred", "confidence": 0.97 }
  },
  "media": { "kind": "inline_image", "mime_type": "image/png" }
}
```

Optional fields are omitted when absent rather than emitted as `null`, matching how the documents are actually stored. Every field of `MemoryMetadata` round-trips: `artifact_refs`, `superseded_by`, `valid_from`, `valid_until`, `supersession_reason`, `initiator`, and the full `provenance` object.

`manifest.json` — what makes the archive self-describing and drives the staleness check:

```json
{
  "generated_at": 1771286400000,
  "project_id": "my-brain-88870",
  "collection": "memory_vectors",
  "document_count": 143,
  "state_histogram": { "active": 52, "deprecated": 91 },
  "embedding_model": "text-embedding-004",
  "embedding_dimensions": 768,
  "schema_version": 1
}
```

`embedding_model` and `embedding_dimensions` record the vector space the archive was taken *from*, so a restore into a different configuration is a visible, deliberate act rather than a silent one.

## Export behavior

Read the whole collection in one pass, drop `embedding`, normalize key order, write both files, then commit and push from the archive directory.

**Truncation guardrail.** If `document_count` is more than 10% below the previous manifest's, refuse to write and exit non-zero unless `--force` is passed. A partial read committed over a good archive is the one failure mode that turns the backup into the problem. The count is monotonic in normal operation because deprecation is soft and nothing is deleted, so any decrease is worth a human look.

**Dry run.** `--dry-run` reports what would be written and the delta against the previous manifest without touching the working tree, mirroring the `--write` opt-in convention of the existing backfill scripts.

## Restore behavior

`restore-memories.mjs` reads the NDJSON, re-embeds each `retrieval_text` with the currently configured embedding client, and writes to Firestore.

**Document ids must be preserved.** `metadata.superseded_by` holds document ids, so the supersession graph is only meaningful if restore writes to `.doc(id).set(...)` with the archived id. Generating fresh ids would silently destroy every correction and consolidation link in the store. This is the single most important correctness property of the restore path.

For the same reason restore writes documents directly rather than going through `MetaCortexService.remember()`: the service path allocates new ids, applies write-fingerprint deduplication, and re-derives metadata defaults. Restore must reproduce archived state exactly, not re-infer it.

`--collection <name>` targets an arbitrary collection so a restore can land in a scratch collection and be diffed against the live one before anything is trusted. `--project` follows the same resolution order as the existing backfill scripts.

Restore warns loudly when the manifest's `embedding_model` or `embedding_dimensions` differ from the current configuration, since that means the restored vectors occupy a different space than the archive was taken from. It proceeds — that is a legitimate migration path — but it says so.

## Staleness detection

A backup that depends on a laptop being awake fails silently, and a silent backup failure is indistinguishable from a working one until the day it matters.

- A launchd agent runs the export daily.
- `scripts/deploy-session-preflight.sh` gains a `== Memory archive ==` section that reads `manifest.json` and warns when `generated_at` is more than 3 days old, following the existing warning-not-failure convention of that script.

The preflight check is deliberately a warning rather than a hard failure: it should surface rot at a moment attention is already on the system, not block unrelated deploys.

## Testing

Both scripts factor their logic into importable modules so behavior is testable without hitting Firestore or Gemini, matching how the existing suite uses in-memory fakes.

- **Round-trip.** Seed `InMemoryMemoryRepository` with documents covering every optional metadata field, export, restore into a second repository, assert content, `retrieval_text`, ids, and all metadata are identical and embeddings were regenerated.
- **Supersession graph.** A deprecated document whose `superseded_by` points at another archived document still resolves after restore. This is the regression test for the id-preservation requirement.
- **Determinism.** Exporting the same fixture twice yields byte-identical output; exporting with keys inserted in a different order yields the same bytes.
- **Truncation guardrail.** An export reporting materially fewer documents than the previous manifest exits non-zero without writing, and `--force` overrides it.
- **Model mismatch.** A manifest recording different embedding dimensions than the current config produces a warning on restore.

Coverage target follows the project minimum of 60%.

## Configuration

| Variable | Purpose |
|----------|---------|
| `METACORTEX_ARCHIVE_DIR` | Path to the private archive repository. Required by the export script. |

New npm scripts in `functions/package.json`, alongside the existing `backfill:*` entries:

```
"backup:memories": "node scripts/backup-memories.mjs",
"restore:memories": "node scripts/restore-memories.mjs"
```

## Risks

**Cadence gap.** Recovery is only as good as the last run, and the run depends on a laptop being awake. Mitigated by daily scheduling plus the preflight staleness warning, not eliminated. If this proves insufficient in practice, the escalation path is a scheduled Cloud Function writing the same NDJSON to an off-project bucket — the exporter logic would be reusable as-is.

**Untested restores.** A backup never restored is a hypothesis, not a backup. The scratch-collection restore path exists so this can be exercised cheaply; doing so periodically should be an explicit habit, not an assumption.

**Archive repository confidentiality.** The archive contains everything MetaCortex knows, in plaintext, in git. The repository must be private. At-rest encryption of the dump was considered and rejected for v1: it would defeat the readable-diff property that motivates a git-backed archive, and the threat model here is loss of availability, not disclosure. Revisit if the archive ever leaves a personal machine.
