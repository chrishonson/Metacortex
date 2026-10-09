# Full top-level Firestore backup

Existing operator tooling integrated from `932f730` (cards 64–65); no fresh live recovery is claimed by this integration.

As-is clone of every top-level Firestore collection discovered by
`listCollections()`. Distinct from [MEMORY_ARCHIVE.md](MEMORY_ARCHIVE.md),
which archives only `memory_vectors` and strips embeddings.

Inventory is live discovery. Do not hardcode collection names.

Vectors and timestamps round-trip via `__fs` tags. No re-embed.

Prod `my-brain-88870` is read-only. Restore refuses that project id.

## Backup

```bash
npm --prefix functions run backup:firestore-full -- \
  --project my-brain-88870 \
  --archive-dir /path/to/archive
```

`--dry-run` lists collections and counts without writing.

Each run calls `listCollections()` on the source, then rewrites every
collection NDJSON file and `manifest.json`. This is a full snapshot, not an
incremental delta. NDJSON files for collections that disappeared from the
source are removed. Non-NDJSON files in the archive directory are left alone.

## Restore

Dry-run by default. `--write` is required to mutate the target.

`--write` converges each archived collection to the snapshot:

- upsert every archive document by id (create or overwrite)
- prune target documents whose ids are absent from the archive
- create collections that exist in the archive but not yet on the target

```bash
npm --prefix functions run restore:firestore-full -- \
  --project metacortex-qa \
  --archive-dir /path/to/archive \
  --write
```

`--clear-target-collections` is optional. It wipes each archived collection
before the upsert. Converge does not need it; prune already removes extras.

Restore does not delete target collections that are absent from the archive.
The inventory gate checks source-to-target parity for source collections only.

## Re-run semantics

What happens if more docs (or collections) are added on prod and backup runs
again:

- New collections on prod: the next backup includes them via a fresh
  `listCollections()`. Restore creates them on QA when it upserts their docs.
- New or updated docs: the backup rewrites the collection NDJSON. Restore
  upserts those ids on QA.
- Deleted docs on prod: they are absent from the new snapshot. Restore prunes
  those ids from the matching QA collection.
- Deleted collections on prod: their NDJSON is dropped from the archive.
  Restore does not delete the leftover QA collection. The gate still passes
  because it only requires source collections to exist on the target with
  matching counts.
- Always re-run the inventory gate after backup plus restore. Success only
  when the gate exits 0.

## Inventory gate

Exit 0 only when every collection from source `listCollections()` exists on
the target with equal `count()`.

```bash
npm --prefix functions run gate:firestore-inventory -- \
  --source-project my-brain-88870 \
  --target-project metacortex-qa \
  --out /path/to/inventory-gate.json
```

A backup is not complete until this gate exits 0. Prior #60/#62 runs hardcoded
four collection names and missed live collections.

## Current limits and future recovery work

The implementation does not recursively discover subcollections, establish one consistent read timestamp, or compare content hashes. The inventory gate checks source collection presence and counts; it reports target-only collections without failing on them. Equal counts are not proof of content equality. The script name "full" denotes its current top-level inventory scope, not a complete recursive disaster-recovery guarantee.

Restore is dry-run unless `--write` is supplied. With `--write`, it prunes extra documents in archived target collections before upserting. That can leave a partial target if later writes fail. The hardcoded refusal of the maintainer's production project is not a general source/target protection for other installations. Always inspect the explicit target and restore to isolated QA first. Use a dedicated archive directory separate from portable memory archives.

Retain historical inventory evidence from cards 64–65, but strengthen snapshot consistency, archive integrity, source/target guards, and content/lineage verification under RECOVERY in the [roadmap](../metacortexplan.md). These are future work, not changes introduced by this baseline. Physical pruning remains an operator recovery action, not an agent or product deletion feature.
