> Historical archive design/implementation record, retained from the completed archive branch. The current roadmap is [metacortexplan.md](../../../metacortexplan.md). Current behavior and limitations are in [MEMORY_ARCHIVE.md](../../MEMORY_ARCHIVE.md) and [FULL_BACKUP.md](../../FULL_BACKUP.md). Old task checkboxes are not the active backlog.

# Memory Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive the MetaCortex memory store to deterministic NDJSON in a private git repository outside GCP, and restore it into Firestore with document ids and retrieval behavior intact.

**Architecture:** Pure logic lives in `functions/src/archive.ts` (serialization, manifest, guardrails) and `functions/src/archiveFirestore.ts` (Firestore adapters), so vitest covers it under the existing `src/**/*.ts` coverage rule. Two thin `tsx` CLI drivers in `functions/scripts/` handle env loading, argument parsing, and git. Embeddings are never archived — restore regenerates them from `retrieval_text`.

**Tech Stack:** TypeScript (ES2022, NodeNext), Node 22, firebase-admin 13, vitest 3, tsx.

**Spec:** [docs/superpowers/specs/2026-08-17-memory-checkpoint-design.md](../specs/2026-08-17-memory-checkpoint-design.md)

## Global Constraints

- **Document ids must be preserved on restore.** `metadata.superseded_by` holds document ids; restore writes via `.doc(id).set(...)` with the archived id and never allocates a new one.
- **Restore must not go through `MetaCortexService.remember()`.** That path allocates ids, applies write-fingerprint dedup, and re-derives metadata defaults.
- **Embeddings are never archived.** Restore re-embeds `retrieval_text` with `taskType: "RETRIEVAL_DOCUMENT"` and `title: metadata.module_name`, matching [service.ts:55-59](../../../functions/src/service.ts) exactly. Any deviation changes the vector.
- **Serialization must be byte-deterministic.** Documents sorted by id; object keys emitted in a fixed order at every level; `undefined` fields omitted rather than serialized as `null`.
- **Truncation guardrail:** refuse to write when the new document count is more than 10% below the previous manifest's, unless `--force`.
- **Staleness threshold:** 3 days.
- **`schema_version` is `1`.**
- **Excluded collections:** `memory_events`, `memory_vectors_write_fingerprints`.
- **Flag convention:** writes to the local archive happen by default (`--dry-run` to inspect); writes to Firestore require an explicit `--write`, matching `backfill-firestore-provenance.mjs`.
- New source files are TypeScript under `functions/src/`; CLI drivers are TypeScript under `functions/scripts/` run via `tsx`, following `scripts/retrieval-eval.ts`.
- Tests are `functions/test/*.test.ts` (vitest `include: ["test/**/*.test.ts"]`).

## File Structure

| File | Responsibility |
|------|----------------|
| `functions/src/archive.ts` | Create. Pure logic: archive types, canonical key ordering, NDJSON serialize/parse, manifest construction, truncation guardrail, embedding-mismatch description, restore orchestration over a port. |
| `functions/src/archiveFirestore.ts` | Create. Firestore adapters: read collection into `ArchivedMemory[]` (dropping `embedding`), and a `RestoreTarget` that writes by explicit id. |
| `functions/test/archive.test.ts` | Create. Covers everything in `archive.ts`. |
| `functions/test/archiveFirestore.test.ts` | Create. Covers the pure document-mapping function. |
| `functions/scripts/support/cli.ts` | Create. Shared CLI helpers: argument parsing, `.env`/`.env.prod` loading, `.firebaserc` project resolution. |
| `functions/scripts/backup-memories.ts` | Create. CLI: read Firestore, write NDJSON + manifest, commit and push. |
| `functions/scripts/restore-memories.ts` | Create. CLI: read NDJSON, re-embed, write to a target collection. |
| `functions/package.json` | Modify. Add `backup:memories` and `restore:memories` scripts. |
| `functions/.env.example` | Modify. Document `METACORTEX_ARCHIVE_DIR`. |
| `scripts/deploy-session-preflight.sh` | Modify. Add a `== Memory archive ==` staleness section. |
| `docs/MEMORY_ARCHIVE.md` | Create. Runbook: setup, launchd agent, restore procedure. |
| `CLAUDE.md` | Modify. Add the two commands to Common Commands. |

---

### Task 1: Archive serialization core

Deterministic NDJSON is the foundation everything else rests on. If serialization is not byte-stable, the git diffs that justify this whole design become noise.

**Files:**
- Create: `functions/src/archive.ts`
- Test: `functions/test/archive.test.ts`

**Interfaces:**
- Consumes: `MemoryMetadata`, `MemoryMedia` from `functions/src/types.ts`
- Produces:
  - `ARCHIVE_SCHEMA_VERSION: 1`
  - `interface ArchivedMemory { id: string; content: string; retrieval_text: string; metadata: MemoryMetadata; media?: MemoryMedia }`
  - `canonicalizeArchivedMemory(memory: ArchivedMemory): Record<string, unknown>`
  - `serializeArchive(memories: readonly ArchivedMemory[]): string`
  - `parseArchive(ndjson: string): ArchivedMemory[]`

- [ ] **Step 1: Write the failing test**

Create `functions/test/archive.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  parseArchive,
  serializeArchive,
  type ArchivedMemory
} from "../src/archive.js";

function memory(overrides: Partial<ArchivedMemory> = {}): ArchivedMemory {
  return {
    id: "doc-b",
    content: "Nick prefers MVI for Android",
    retrieval_text: "Nick prefers MVI for Android",
    metadata: {
      module_name: "android",
      branch_state: "active",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      modality: "text"
    },
    ...overrides
  };
}

describe("serializeArchive", () => {
  it("emits one JSON object per line, sorted by document id", () => {
    const output = serializeArchive([
      memory({ id: "doc-c" }),
      memory({ id: "doc-a" }),
      memory({ id: "doc-b" })
    ]);

    const ids = output
      .trimEnd()
      .split("\n")
      .map(line => JSON.parse(line).id);

    expect(ids).toEqual(["doc-a", "doc-b", "doc-c"]);
  });

  it("terminates the final line with a newline", () => {
    expect(serializeArchive([memory()]).endsWith("\n")).toBe(true);
  });

  it("is byte-identical regardless of key insertion order", () => {
    const straightforward = serializeArchive([memory()]);

    const scrambled = serializeArchive([
      {
        metadata: {
          modality: "text",
          updated_at: 1_700_000_000_000,
          branch_state: "active",
          created_at: 1_700_000_000_000,
          module_name: "android"
        },
        retrieval_text: "Nick prefers MVI for Android",
        id: "doc-b",
        content: "Nick prefers MVI for Android"
      } as ArchivedMemory
    ]);

    expect(scrambled).toBe(straightforward);
  });

  it("omits absent optional fields rather than emitting null", () => {
    const line = serializeArchive([memory()]).trimEnd();

    expect(line).not.toContain("null");
    expect(line).not.toContain("media");
    expect(line).not.toContain("superseded_by");
  });

  it("round-trips every optional metadata field", () => {
    const full = memory({
      id: "doc-full",
      metadata: {
        module_name: "metacortex-product",
        branch_state: "deprecated",
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_100_000,
        modality: "mixed",
        artifact_refs: ["gs://bucket/diagram.png"],
        superseded_by: "doc-successor",
        valid_from: 1_699_000_000_000,
        valid_until: 1_701_000_000_000,
        supersession_reason: "corrected",
        initiator: "user",
        provenance: {
          origin: "user_asserted",
          source_session: "session-42",
          derived_from: ["doc-a", "doc-b"],
          confidence: 0.97
        }
      },
      media: { kind: "inline_image", mime_type: "image/png" }
    });

    expect(parseArchive(serializeArchive([full]))).toEqual([full]);
  });
});

describe("parseArchive", () => {
  it("ignores blank lines and tolerates CRLF", () => {
    const ndjson = serializeArchive([memory()]).trimEnd();

    expect(parseArchive(`\r\n${ndjson}\r\n\r\n`)).toHaveLength(1);
  });

  it("reports the line number of malformed content", () => {
    const ndjson = `${serializeArchive([memory()]).trimEnd()}\nnot-json\n`;

    expect(() => parseArchive(ndjson)).toThrow(/line 2/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --prefix functions vitest run test/archive.test.ts`
Expected: FAIL — cannot resolve `../src/archive.js`.

- [ ] **Step 3: Write the implementation**

Create `functions/src/archive.ts`:

```typescript
import type { MemoryMedia, MemoryMetadata } from "./types.js";

export const ARCHIVE_SCHEMA_VERSION = 1;

export interface ArchivedMemory {
  id: string;
  content: string;
  retrieval_text: string;
  metadata: MemoryMetadata;
  media?: MemoryMedia;
}

const MEMORY_KEY_ORDER = [
  "id",
  "content",
  "retrieval_text",
  "metadata",
  "media"
] as const;

const METADATA_KEY_ORDER = [
  "module_name",
  "branch_state",
  "created_at",
  "updated_at",
  "modality",
  "artifact_refs",
  "superseded_by",
  "valid_from",
  "valid_until",
  "supersession_reason",
  "initiator",
  "provenance"
] as const;

const PROVENANCE_KEY_ORDER = [
  "origin",
  "source_session",
  "derived_from",
  "confidence"
] as const;

const MEDIA_KEY_ORDER = ["kind", "mime_type"] as const;

function orderKeys(
  source: Record<string, unknown>,
  keyOrder: readonly string[]
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};

  for (const key of keyOrder) {
    if (typeof source[key] !== "undefined" && source[key] !== null) {
      ordered[key] = source[key];
    }
  }

  return ordered;
}

export function canonicalizeArchivedMemory(
  memory: ArchivedMemory
): Record<string, unknown> {
  const metadata = orderKeys(
    memory.metadata as unknown as Record<string, unknown>,
    METADATA_KEY_ORDER
  );

  if (memory.metadata.provenance) {
    metadata.provenance = orderKeys(
      memory.metadata.provenance as unknown as Record<string, unknown>,
      PROVENANCE_KEY_ORDER
    );
  }

  const canonical = orderKeys(
    memory as unknown as Record<string, unknown>,
    MEMORY_KEY_ORDER
  );

  canonical.metadata = metadata;

  if (memory.media) {
    canonical.media = orderKeys(
      memory.media as unknown as Record<string, unknown>,
      MEDIA_KEY_ORDER
    );
  }

  return canonical;
}

export function serializeArchive(
  memories: readonly ArchivedMemory[]
): string {
  const sorted = [...memories].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );

  return sorted
    .map(memory => JSON.stringify(canonicalizeArchivedMemory(memory)))
    .map(line => `${line}\n`)
    .join("");
}

export function parseArchive(ndjson: string): ArchivedMemory[] {
  const memories: ArchivedMemory[] = [];
  const lines = ndjson.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      continue;
    }

    try {
      memories.push(JSON.parse(line) as ArchivedMemory);
    } catch {
      throw new Error(`archive is malformed at line ${index + 1}`);
    }
  }

  return memories;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx --prefix functions vitest run test/archive.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add functions/src/archive.ts functions/test/archive.test.ts
git commit -m "feat(archive): deterministic NDJSON serialization for memory archive"
```

---

### Task 2: Manifest and truncation guardrail

The manifest is what makes the archive self-describing; the guardrail is what stops a partial read from overwriting a good archive.

**Files:**
- Modify: `functions/src/archive.ts` (append)
- Test: `functions/test/archive.test.ts` (append)

**Interfaces:**
- Consumes: `ArchivedMemory`, `ARCHIVE_SCHEMA_VERSION` from Task 1
- Produces:
  - `interface ArchiveManifest { generated_at: number; project_id: string; collection: string; document_count: number; state_histogram: Record<string, number>; embedding_model: string; embedding_dimensions: number; schema_version: number }`
  - `buildManifest(params: BuildManifestParams): ArchiveManifest`
  - `interface BuildManifestParams { memories: readonly ArchivedMemory[]; generatedAt: number; projectId: string; collection: string; embeddingModel: string; embeddingDimensions: number }`
  - `checkTruncation(previousCount: number | undefined, nextCount: number): TruncationVerdict`
  - `interface TruncationVerdict { allowed: boolean; reason?: string }`
  - `describeEmbeddingMismatch(manifest: ArchiveManifest, current: { embeddingModel: string; embeddingDimensions: number }): string | null`

- [ ] **Step 1: Write the failing test**

Append to `functions/test/archive.test.ts` (and extend the existing import from `../src/archive.js` to include `buildManifest`, `checkTruncation`, and `describeEmbeddingMismatch`):

```typescript
describe("buildManifest", () => {
  it("counts documents and tallies branch states", () => {
    const manifest = buildManifest({
      memories: [
        memory({ id: "a" }),
        memory({
          id: "b",
          metadata: { ...memory().metadata, branch_state: "deprecated" }
        }),
        memory({
          id: "c",
          metadata: { ...memory().metadata, branch_state: "deprecated" }
        })
      ],
      generatedAt: 1_771_286_400_000,
      projectId: "my-brain-88870",
      collection: "memory_vectors",
      embeddingModel: "text-embedding-004",
      embeddingDimensions: 768
    });

    expect(manifest.document_count).toBe(3);
    expect(manifest.state_histogram).toEqual({ active: 1, deprecated: 2 });
    expect(manifest.schema_version).toBe(1);
    expect(manifest.generated_at).toBe(1_771_286_400_000);
  });

  it("orders histogram keys so the manifest serializes deterministically", () => {
    const manifest = buildManifest({
      memories: [
        memory({
          id: "a",
          metadata: { ...memory().metadata, branch_state: "wip" }
        }),
        memory({
          id: "b",
          metadata: { ...memory().metadata, branch_state: "active" }
        })
      ],
      generatedAt: 1,
      projectId: "p",
      collection: "c",
      embeddingModel: "m",
      embeddingDimensions: 768
    });

    expect(Object.keys(manifest.state_histogram)).toEqual(["active", "wip"]);
  });
});

describe("checkTruncation", () => {
  it("allows the first run when there is no previous manifest", () => {
    expect(checkTruncation(undefined, 0).allowed).toBe(true);
  });

  it("allows growth", () => {
    expect(checkTruncation(100, 143).allowed).toBe(true);
  });

  it("allows a drop within 10 percent", () => {
    expect(checkTruncation(100, 90).allowed).toBe(true);
  });

  it("blocks a drop beyond 10 percent and explains why", () => {
    const verdict = checkTruncation(100, 89);

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/89/);
    expect(verdict.reason).toMatch(/100/);
  });

  it("blocks an empty read against a non-empty previous archive", () => {
    expect(checkTruncation(143, 0).allowed).toBe(false);
  });
});

describe("describeEmbeddingMismatch", () => {
  const manifest = {
    generated_at: 1,
    project_id: "p",
    collection: "c",
    document_count: 1,
    state_histogram: { active: 1 },
    embedding_model: "text-embedding-004",
    embedding_dimensions: 768,
    schema_version: 1
  };

  it("returns null when the vector space matches", () => {
    expect(
      describeEmbeddingMismatch(manifest, {
        embeddingModel: "text-embedding-004",
        embeddingDimensions: 768
      })
    ).toBeNull();
  });

  it("describes a dimension change", () => {
    const message = describeEmbeddingMismatch(manifest, {
      embeddingModel: "text-embedding-004",
      embeddingDimensions: 1536
    });

    expect(message).toMatch(/768/);
    expect(message).toMatch(/1536/);
  });

  it("describes a model change", () => {
    const message = describeEmbeddingMismatch(manifest, {
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: 768
    });

    expect(message).toMatch(/text-embedding-004/);
    expect(message).toMatch(/gemini-embedding-001/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --prefix functions vitest run test/archive.test.ts`
Expected: FAIL — `buildManifest` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `functions/src/archive.ts`:

```typescript
const TRUNCATION_TOLERANCE = 0.9;

export interface ArchiveManifest {
  generated_at: number;
  project_id: string;
  collection: string;
  document_count: number;
  state_histogram: Record<string, number>;
  embedding_model: string;
  embedding_dimensions: number;
  schema_version: number;
}

export interface BuildManifestParams {
  memories: readonly ArchivedMemory[];
  generatedAt: number;
  projectId: string;
  collection: string;
  embeddingModel: string;
  embeddingDimensions: number;
}

export function buildManifest(params: BuildManifestParams): ArchiveManifest {
  const tally = new Map<string, number>();

  for (const memory of params.memories) {
    const state = memory.metadata.branch_state;
    tally.set(state, (tally.get(state) ?? 0) + 1);
  }

  const stateHistogram: Record<string, number> = {};

  for (const state of [...tally.keys()].sort()) {
    stateHistogram[state] = tally.get(state)!;
  }

  return {
    generated_at: params.generatedAt,
    project_id: params.projectId,
    collection: params.collection,
    document_count: params.memories.length,
    state_histogram: stateHistogram,
    embedding_model: params.embeddingModel,
    embedding_dimensions: params.embeddingDimensions,
    schema_version: ARCHIVE_SCHEMA_VERSION
  };
}

export interface TruncationVerdict {
  allowed: boolean;
  reason?: string;
}

export function checkTruncation(
  previousCount: number | undefined,
  nextCount: number
): TruncationVerdict {
  if (typeof previousCount !== "number" || previousCount === 0) {
    return { allowed: true };
  }

  if (nextCount >= previousCount * TRUNCATION_TOLERANCE) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason:
      `read ${nextCount} documents but the previous archive held ${previousCount}; ` +
      "a drop beyond 10% looks like a partial read. Re-run with --force if this is expected."
  };
}

export function describeEmbeddingMismatch(
  manifest: ArchiveManifest,
  current: { embeddingModel: string; embeddingDimensions: number }
): string | null {
  const differences: string[] = [];

  if (manifest.embedding_model !== current.embeddingModel) {
    differences.push(
      `model ${manifest.embedding_model} -> ${current.embeddingModel}`
    );
  }

  if (manifest.embedding_dimensions !== current.embeddingDimensions) {
    differences.push(
      `dimensions ${manifest.embedding_dimensions} -> ${current.embeddingDimensions}`
    );
  }

  if (differences.length === 0) {
    return null;
  }

  return (
    `archive was taken from a different vector space (${differences.join(", ")}); ` +
    "restored vectors will not match the archived ones"
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx --prefix functions vitest run test/archive.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add functions/src/archive.ts functions/test/archive.test.ts
git commit -m "feat(archive): manifest, truncation guardrail, and vector-space mismatch check"
```

---

### Task 3: Firestore read adapter and backup CLI

**Files:**
- Create: `functions/src/archiveFirestore.ts`
- Create: `functions/test/archiveFirestore.test.ts`
- Create: `functions/scripts/support/cli.ts`
- Create: `functions/scripts/backup-memories.ts`
- Modify: `functions/package.json`
- Modify: `functions/.env.example`

**Interfaces:**
- Consumes: `ArchivedMemory`, `serializeArchive`, `buildManifest`, `checkTruncation`, `ArchiveManifest` from Tasks 1-2
- Produces:
  - `toArchivedMemory(id: string, data: Record<string, unknown>): ArchivedMemory`
  - `readMemoriesForArchive(firestore: Firestore, collectionName: string): Promise<ArchivedMemory[]>`
  - `readArg(args: string[], name: string): string | undefined`
  - `loadEnvironment(directory: string): void`
  - `readFirebaseProject(rootDir: string): string | undefined`

- [ ] **Step 1: Write the failing test**

Create `functions/test/archiveFirestore.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { toArchivedMemory } from "../src/archiveFirestore.js";

describe("toArchivedMemory", () => {
  const data = {
    content: "Nick prefers MVI for Android",
    retrieval_text: "Nick prefers MVI for Android",
    embedding: { _values: [0.1, 0.2, 0.3] },
    metadata: {
      module_name: "android",
      branch_state: "active",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      modality: "text"
    }
  };

  it("keeps the document id", () => {
    expect(toArchivedMemory("doc-a", data).id).toBe("doc-a");
  });

  it("drops the embedding field", () => {
    expect(toArchivedMemory("doc-a", data)).not.toHaveProperty("embedding");
  });

  it("falls back to content when retrieval_text is missing", () => {
    const { retrieval_text: _omitted, ...withoutRetrievalText } = data;

    expect(toArchivedMemory("doc-a", withoutRetrievalText).retrieval_text).toBe(
      "Nick prefers MVI for Android"
    );
  });

  it("preserves media when present", () => {
    const withMedia = {
      ...data,
      media: { kind: "inline_image", mime_type: "image/png" }
    };

    expect(toArchivedMemory("doc-a", withMedia).media).toEqual({
      kind: "inline_image",
      mime_type: "image/png"
    });
  });

  it("omits media when absent", () => {
    expect(toArchivedMemory("doc-a", data).media).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --prefix functions vitest run test/archiveFirestore.test.ts`
Expected: FAIL — cannot resolve `../src/archiveFirestore.js`.

- [ ] **Step 3: Write the adapter**

Create `functions/src/archiveFirestore.ts`:

```typescript
import type { Firestore } from "firebase-admin/firestore";

import type { ArchivedMemory } from "./archive.js";
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx --prefix functions vitest run test/archiveFirestore.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the shared CLI helpers**

Both CLI drivers need identical env loading and argument parsing. Extract once rather than duplicating.

Create `functions/scripts/support/cli.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";

export function readArg(args: string[], name: string): string | undefined {
  const index = args.findIndex(arg => arg === `--${name}`);

  return index === -1 ? undefined : args[index + 1];
}

export function loadEnvironment(directory: string): void {
  const explicitKeys = new Set(Object.keys(process.env));

  for (const fileName of [".env", ".env.prod"]) {
    const filePath = path.join(directory, fileName);

    if (!fs.existsSync(filePath)) {
      continue;
    }

    for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();

      if (explicitKeys.has(key)) {
        continue;
      }

      let value = line.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}

export function readFirebaseProject(rootDir: string): string | undefined {
  const firebaseRcPath = path.join(rootDir, ".firebaserc");

  if (!fs.existsSync(firebaseRcPath)) {
    return undefined;
  }

  const firebaseRc = JSON.parse(fs.readFileSync(firebaseRcPath, "utf8"));
  const project = firebaseRc.projects?.prod ?? firebaseRc.projects?.default;

  return typeof project === "string" && project.trim()
    ? project.trim()
    : undefined;
}
```

- [ ] **Step 6: Write the backup CLI**

Create `functions/scripts/backup-memories.ts`:

```typescript
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  buildManifest,
  checkTruncation,
  serializeArchive,
  type ArchiveManifest
} from "../src/archive.js";
import { readMemoriesForArchive } from "../src/archiveFirestore.js";
import { loadEnvironment, readArg, readFirebaseProject } from "./support/cli.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const functionsDirectory = path.resolve(scriptDirectory, "..");
const repoRoot = path.resolve(functionsDirectory, "..");

loadEnvironment(functionsDirectory);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const noPush = args.includes("--no-push");
const archiveDir =
  readArg(args, "archive-dir") ?? process.env.METACORTEX_ARCHIVE_DIR;
const projectId =
  readArg(args, "project") ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.GCLOUD_PROJECT ??
  readFirebaseProject(repoRoot) ??
  "my-brain-88870";
const collectionName =
  readArg(args, "memory-collection") ??
  process.env.MEMORY_COLLECTION?.trim() ??
  "memory_vectors";
const embeddingModel =
  process.env.GEMINI_EMBEDDING_MODEL?.trim() || "text-embedding-004";
const embeddingDimensions = Number.parseInt(
  process.env.GEMINI_EMBEDDING_DIMENSIONS?.trim() || "768",
  10
);

if (!archiveDir) {
  console.error(
    "METACORTEX_ARCHIVE_DIR is not set. Point it at your private archive repository, or pass --archive-dir."
  );
  process.exit(1);
}

if (!fs.existsSync(archiveDir)) {
  console.error(`archive directory does not exist: ${archiveDir}`);
  process.exit(1);
}

const archivePath = path.join(archiveDir, "memories.ndjson");
const manifestPath = path.join(archiveDir, "manifest.json");

const app = getApps().length === 0 ? initializeApp({ projectId }) : getApp();
const firestore = getFirestore(app);

console.log(`project: ${projectId}`);
console.log(`collection: ${collectionName}`);
console.log(`archive: ${archiveDir}`);
console.log(`mode: ${dryRun ? "dry-run" : "write"}`);

const memories = await readMemoriesForArchive(firestore, collectionName);
const previousManifest = readManifest(manifestPath);
const verdict = checkTruncation(previousManifest?.document_count, memories.length);

console.log(
  `documents: ${memories.length}` +
    (previousManifest ? ` (previous: ${previousManifest.document_count})` : "")
);

if (!verdict.allowed && !force) {
  console.error(`refusing to write: ${verdict.reason}`);
  process.exit(1);
}

if (!verdict.allowed) {
  console.warn(`--force overriding guardrail: ${verdict.reason}`);
}

const manifest = buildManifest({
  memories,
  generatedAt: Date.now(),
  projectId,
  collection: collectionName,
  embeddingModel,
  embeddingDimensions
});

console.log(`states: ${JSON.stringify(manifest.state_histogram)}`);

if (dryRun) {
  console.log("Dry run complete. Nothing written.");
  process.exit(0);
}

fs.writeFileSync(archivePath, serializeArchive(memories), "utf8");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const status = git(["status", "--porcelain"], archiveDir).trim();

if (!status) {
  console.log("Archive unchanged; nothing to commit.");
  process.exit(0);
}

git(["add", "memories.ndjson", "manifest.json"], archiveDir);
git(
  [
    "commit",
    "-m",
    `chore(archive): ${manifest.document_count} memories from ${collectionName}`
  ],
  archiveDir
);

if (noPush) {
  console.log("Committed. Skipping push (--no-push).");
  process.exit(0);
}

git(["push"], archiveDir);
console.log("Committed and pushed.");

function git(gitArgs: string[], cwd: string): string {
  return execFileSync("git", gitArgs, { cwd, encoding: "utf8" });
}

function readManifest(filePath: string): ArchiveManifest | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as ArchiveManifest;
}
```

- [ ] **Step 7: Register the npm script**

In `functions/package.json`, add after the `backfill:provenance` line:

```json
    "backup:memories": "tsx scripts/backup-memories.ts",
```

- [ ] **Step 8: Document the environment variable**

Append to `functions/.env.example`:

```
# Absolute path to the private git repository holding the memory archive.
# Required by `npm run backup:memories`.
METACORTEX_ARCHIVE_DIR=
```

- [ ] **Step 9: Verify the CLI runs end to end against production, without writing**

```bash
mkdir -p /tmp/metacortex-archive-check && npm --prefix functions run backup:memories -- --dry-run --archive-dir /tmp/metacortex-archive-check
```

Expected: prints project, collection, a document count in the low hundreds, a state histogram containing `active` and `deprecated`, then "Dry run complete. Nothing written." Confirm `/tmp/metacortex-archive-check` is still empty.

- [ ] **Step 10: Run the full suite**

Run: `npm --prefix functions test`
Expected: PASS, coverage reported.

- [ ] **Step 11: Commit**

```bash
git add functions/src/archiveFirestore.ts functions/test/archiveFirestore.test.ts functions/scripts/support/cli.ts functions/scripts/backup-memories.ts functions/package.json functions/.env.example
git commit -m "feat(archive): export memory store to NDJSON in a private git repo"
```

---

### Task 4: Restore path

Where correctness matters most. Restore must reproduce ids exactly, or the supersession graph is silently destroyed.

**Files:**
- Modify: `functions/src/archive.ts` (append)
- Modify: `functions/src/archiveFirestore.ts` (append)
- Modify: `functions/test/archive.test.ts` (append)
- Create: `functions/scripts/restore-memories.ts`
- Modify: `functions/package.json`

**Interfaces:**
- Consumes: `ArchivedMemory`, `parseArchive` from Task 1; `EmbeddingClient` from `functions/src/embeddings.ts`
- Produces:
  - `interface RestoreTarget { writeMemory(memory: ArchivedMemory, embedding: number[]): Promise<void> }`
  - `restoreMemories(params: RestoreParams): Promise<RestoreResult>`
  - `interface RestoreParams { memories: readonly ArchivedMemory[]; embeddings: EmbeddingClient; target: RestoreTarget }`
  - `interface RestoreResult { restored: number }`
  - `class FirestoreRestoreTarget implements RestoreTarget` (constructor: `(firestore: Firestore, collectionName: string)`)

- [ ] **Step 1: Write the failing test**

Append to `functions/test/archive.test.ts` (extend the `../src/archive.js` import with `restoreMemories`, and add `import type { EmbeddingClient, EmbeddingRequest } from "../src/embeddings.js";`):

```typescript
class RecordingEmbeddingClient implements EmbeddingClient {
  readonly requests: EmbeddingRequest[] = [];

  async embed(request: EmbeddingRequest): Promise<number[]> {
    this.requests.push(request);

    return [request.text.length, 0, 0];
  }
}

class RecordingRestoreTarget {
  readonly written: { memory: ArchivedMemory; embedding: number[] }[] = [];

  async writeMemory(memory: ArchivedMemory, embedding: number[]): Promise<void> {
    this.written.push({ memory, embedding });
  }
}

describe("restoreMemories", () => {
  it("preserves archived document ids", async () => {
    const target = new RecordingRestoreTarget();

    await restoreMemories({
      memories: [memory({ id: "DSFBIyUni6OGhySMkbHw" })],
      embeddings: new RecordingEmbeddingClient(),
      target
    });

    expect(target.written[0].memory.id).toBe("DSFBIyUni6OGhySMkbHw");
  });

  it("keeps the supersession graph resolvable after restore", async () => {
    const target = new RecordingRestoreTarget();

    await restoreMemories({
      memories: [
        memory({ id: "successor" }),
        memory({
          id: "original",
          metadata: {
            ...memory().metadata,
            branch_state: "deprecated",
            superseded_by: "successor"
          }
        })
      ],
      embeddings: new RecordingEmbeddingClient(),
      target
    });

    const ids = new Set(target.written.map(entry => entry.memory.id));
    const deprecated = target.written.find(
      entry => entry.memory.id === "original"
    );

    expect(ids.has(deprecated!.memory.metadata.superseded_by!)).toBe(true);
  });

  it("embeds retrieval_text with the same request shape the service uses", async () => {
    const embeddings = new RecordingEmbeddingClient();

    await restoreMemories({
      memories: [
        memory({
          id: "a",
          content: "canonical content",
          retrieval_text: "normalized retrieval text",
          metadata: { ...memory().metadata, module_name: "android" }
        })
      ],
      embeddings,
      target: new RecordingRestoreTarget()
    });

    expect(embeddings.requests[0]).toEqual({
      text: "normalized retrieval text",
      taskType: "RETRIEVAL_DOCUMENT",
      title: "android"
    });
  });

  it("reports how many documents were restored", async () => {
    const result = await restoreMemories({
      memories: [memory({ id: "a" }), memory({ id: "b" })],
      embeddings: new RecordingEmbeddingClient(),
      target: new RecordingRestoreTarget()
    });

    expect(result.restored).toBe(2);
  });

  it("round-trips an archive without losing metadata", async () => {
    const original = memory({
      id: "doc-full",
      metadata: {
        module_name: "metacortex-product",
        branch_state: "deprecated",
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_100_000,
        modality: "mixed",
        artifact_refs: ["gs://bucket/diagram.png"],
        superseded_by: "doc-successor",
        valid_from: 1_699_000_000_000,
        valid_until: 1_701_000_000_000,
        supersession_reason: "corrected",
        initiator: "user",
        provenance: {
          origin: "user_asserted",
          source_session: "session-42",
          derived_from: ["doc-a"],
          confidence: 0.97
        }
      },
      media: { kind: "inline_image", mime_type: "image/png" }
    });

    const target = new RecordingRestoreTarget();

    await restoreMemories({
      memories: parseArchive(serializeArchive([original])),
      embeddings: new RecordingEmbeddingClient(),
      target
    });

    expect(target.written[0].memory).toEqual(original);
    expect(target.written[0].embedding).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --prefix functions vitest run test/archive.test.ts`
Expected: FAIL — `restoreMemories` is not exported.

- [ ] **Step 3: Write the restore logic**

Append to `functions/src/archive.ts` (and add `import type { EmbeddingClient } from "./embeddings.js";` at the top):

```typescript
export interface RestoreTarget {
  writeMemory(memory: ArchivedMemory, embedding: number[]): Promise<void>;
}

export interface RestoreParams {
  memories: readonly ArchivedMemory[];
  embeddings: EmbeddingClient;
  target: RestoreTarget;
}

export interface RestoreResult {
  restored: number;
}

export async function restoreMemories(
  params: RestoreParams
): Promise<RestoreResult> {
  let restored = 0;

  for (const memory of params.memories) {
    const embedding = await params.embeddings.embed({
      text: memory.retrieval_text,
      taskType: "RETRIEVAL_DOCUMENT",
      title: memory.metadata.module_name
    });

    await params.target.writeMemory(memory, embedding);
    restored += 1;
  }

  return { restored };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx --prefix functions vitest run test/archive.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Write the Firestore restore target**

Append to `functions/src/archiveFirestore.ts` (extend the imports to `import { FieldValue, type Firestore } from "firebase-admin/firestore";` and add `ArchivedMemory`, `RestoreTarget` to the `./archive.js` import):

```typescript
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
```

- [ ] **Step 6: Write the restore CLI**

Create `functions/scripts/restore-memories.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  describeEmbeddingMismatch,
  parseArchive,
  restoreMemories,
  type ArchiveManifest,
  type ArchivedMemory,
  type RestoreTarget
} from "../src/archive.js";
import { FirestoreRestoreTarget } from "../src/archiveFirestore.js";
import { loadConfig } from "../src/config.js";
import { GeminiEmbeddingClient } from "../src/embeddings.js";
import { loadEnvironment, readArg, readFirebaseProject } from "./support/cli.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const functionsDirectory = path.resolve(scriptDirectory, "..");
const repoRoot = path.resolve(functionsDirectory, "..");

loadEnvironment(functionsDirectory);

const args = process.argv.slice(2);
const write = args.includes("--write");
const archiveDir =
  readArg(args, "archive-dir") ?? process.env.METACORTEX_ARCHIVE_DIR;
const projectId =
  readArg(args, "project") ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.GCLOUD_PROJECT ??
  readFirebaseProject(repoRoot) ??
  "my-brain-88870";
const targetCollection = readArg(args, "collection");

if (!archiveDir) {
  console.error("METACORTEX_ARCHIVE_DIR is not set. Pass --archive-dir.");
  process.exit(1);
}

if (!targetCollection) {
  console.error(
    "--collection is required. Restore into a scratch collection first and diff it before touching memory_vectors."
  );
  process.exit(1);
}

const config = loadConfig(process.env);
const memories = parseArchive(
  fs.readFileSync(path.join(archiveDir, "memories.ndjson"), "utf8")
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(archiveDir, "manifest.json"), "utf8")
) as ArchiveManifest;

console.log(`archive: ${archiveDir}`);
console.log(`archived at: ${new Date(manifest.generated_at).toISOString()}`);
console.log(`documents: ${memories.length}`);
console.log(`target: ${projectId}/${targetCollection}`);
console.log(`mode: ${write ? "write" : "dry-run"}`);

if (memories.length !== manifest.document_count) {
  console.warn(
    `warning: archive holds ${memories.length} documents but the manifest records ${manifest.document_count}`
  );
}

const mismatch = describeEmbeddingMismatch(manifest, {
  embeddingModel: config.embeddingModel,
  embeddingDimensions: config.embeddingDimensions
});

if (mismatch) {
  console.warn(`warning: ${mismatch}`);
}

if (!write) {
  console.log("Dry run complete. Re-run with --write to restore.");
  process.exit(0);
}

const app = getApps().length === 0 ? initializeApp({ projectId }) : getApp();
const firestore = getFirestore(app);
const embeddings = new GeminiEmbeddingClient({
  apiKey: config.geminiApiKey,
  model: config.embeddingModel,
  dimensions: config.embeddingDimensions
});
const target: RestoreTarget = new FirestoreRestoreTarget(
  firestore,
  targetCollection
);

let completed = 0;
const result = await restoreMemories({
  memories,
  embeddings,
  target: {
    async writeMemory(memory: ArchivedMemory, embedding: number[]) {
      await target.writeMemory(memory, embedding);
      completed += 1;

      if (completed % 25 === 0) {
        console.log(`restored ${completed}/${memories.length}`);
      }
    }
  }
});

console.log(`Restored ${result.restored} documents into ${targetCollection}.`);
```

- [ ] **Step 7: Register the npm script**

In `functions/package.json`, add after `backup:memories`:

```json
    "restore:memories": "tsx scripts/restore-memories.ts",
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm --prefix functions test && npm --prefix functions run build`
Expected: PASS, and a clean `tsc`. Note that `tsconfig.json` includes only `src/**/*.ts`, so the build type-checks `archive.ts` and `archiveFirestore.ts` but not the CLI drivers — same as the existing `scripts/retrieval-eval.ts`. The drivers are exercised by actually running them in Task 3 Step 9 and the final Verification section.

- [ ] **Step 9: Commit**

```bash
git add functions/src/archive.ts functions/src/archiveFirestore.ts functions/test/archive.test.ts functions/scripts/restore-memories.ts functions/package.json
git commit -m "feat(archive): restore path preserving document ids and vector reproduction"
```

---

### Task 5: Staleness detection and runbook

A backup depending on a laptop being awake fails silently, and a silent backup failure is indistinguishable from a working one until the day it matters.

**Files:**
- Modify: `scripts/deploy-session-preflight.sh`
- Create: `docs/MEMORY_ARCHIVE.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the staleness section to the preflight script**

In `scripts/deploy-session-preflight.sh`, insert before the `== Client profiles ==` section:

```bash
echo
echo "== Memory archive =="
ARCHIVE_DIR="${METACORTEX_ARCHIVE_DIR:-$(read_env_key functions/.env METACORTEX_ARCHIVE_DIR)}"

if [[ -z "$ARCHIVE_DIR" ]]; then
  echo "warning: METACORTEX_ARCHIVE_DIR is not set; the memory store has no off-GCP archive"
elif [[ ! -f "$ARCHIVE_DIR/manifest.json" ]]; then
  echo "warning: no manifest.json in $ARCHIVE_DIR; run 'npm --prefix functions run backup:memories'"
else
  node - "$ARCHIVE_DIR/manifest.json" <<'NODE'
const fs = require("fs");

const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const ageDays = (Date.now() - manifest.generated_at) / 86400000;

console.log(
  `archive: ${manifest.document_count} documents, ${ageDays.toFixed(1)} days old`
);

if (ageDays > 3) {
  console.log(
    `warning: memory archive is ${ageDays.toFixed(1)} days old; run 'npm --prefix functions run backup:memories'`
  );
}
NODE
fi
```

- [ ] **Step 2: Verify the preflight section runs**

Run: `./scripts/deploy-session-preflight.sh 2>&1 | grep -A 2 "Memory archive"`
Expected: the section prints, warning that `METACORTEX_ARCHIVE_DIR` is unset (or reporting archive age once it is). The script must still exit 0 — this check warns, it does not fail.

- [ ] **Step 3: Write the runbook**

Create `docs/MEMORY_ARCHIVE.md`:

````markdown
# Memory Archive

The memory store's only copy outside Firestore. Deterministic NDJSON in a
private git repository, restorable into any Firebase project.

## What is archived

`content`, `retrieval_text`, and the full `metadata` object for every document
in `memory_vectors`, including deprecated ones.

Embeddings are **not** archived. They are a pure function of `retrieval_text`
plus the configured model and dimensions, so restore regenerates them — which
keeps the archive small, keeps diffs readable, and keeps the cold copy
independent of any single vector space.

Image bytes are not archived because they are never stored: images are
normalized to text at write time and only `{kind, mime_type}` persists.

`memory_events` and `memory_vectors_write_fingerprints` are out of scope.

## Setup

1. Create a **private** repository for the archive. It contains everything
   MetaCortex knows, in plaintext.
2. Clone it locally and set `METACORTEX_ARCHIVE_DIR` in `functions/.env` to its
   absolute path.
3. Run a first backup:

   ```bash
   npm --prefix functions run backup:memories
   ```

## Daily run

Install a launchd agent at `~/Library/LaunchAgents/com.metacortex.backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.metacortex.backup</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lc</string>
        <string>cd ~/git/metacortex &amp;&amp; npm --prefix functions run backup:memories</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/metacortex-backup.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/metacortex-backup.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.metacortex.backup.plist
```

`deploy-session-preflight.sh` warns when the archive is more than 3 days old,
so rot surfaces at a moment attention is already on the system.

## Restore

Restore never targets `memory_vectors` directly. Land in a scratch collection,
verify, then decide.

```bash
npm --prefix functions run restore:memories -- --collection memory_vectors_restore --write
```

The restore preserves archived document ids, which is what keeps
`superseded_by` links intact. It re-embeds every document, so it needs a
working `GEMINI_API_KEY` and takes a few minutes.

If the manifest's `embedding_model` or `embedding_dimensions` differ from the
current configuration, restore warns and proceeds — a legitimate migration
path, but the resulting vectors occupy a different space than the archive.

Restoring into a live collection requires a matching vector index. See
`firestore.indexes.json`.

## Guardrails

The backup refuses to write when the document count drops more than 10% below
the previous manifest, since a partial read committed over a good archive is
the failure mode that turns the backup into the problem. Override with
`--force` after confirming the drop is real.

Inspect without writing anything:

```bash
npm --prefix functions run backup:memories -- --dry-run
```

## Test your restores

An archive that has never been restored is a hypothesis. Restore into a scratch
collection periodically and confirm the document count and a few known ids.
````

- [ ] **Step 4: Add the commands to CLAUDE.md**

In the "Common Commands" section of `CLAUDE.md`, after the deploy block, add:

````markdown
Memory archive (see `docs/MEMORY_ARCHIVE.md`):
```bash
npm --prefix functions run backup:memories              # Archive memory_vectors to $METACORTEX_ARCHIVE_DIR
npm --prefix functions run backup:memories -- --dry-run # Inspect without writing
npm --prefix functions run restore:memories -- --collection memory_vectors_restore --write
```
````

- [ ] **Step 5: Run the full suite one last time**

Run: `npm --prefix functions test && npm --prefix functions run build`
Expected: PASS, clean build.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy-session-preflight.sh docs/MEMORY_ARCHIVE.md CLAUDE.md
git commit -m "feat(archive): staleness detection and archive runbook"
```

---

## Verification

After Task 5, confirm the archive works end to end against a real private repo:

1. `npm --prefix functions run backup:memories` — commits and pushes an archive.
2. Re-run it immediately — reports "Archive unchanged; nothing to commit," proving serialization is deterministic against live data, not just fixtures.
3. `npm --prefix functions run restore:memories -- --collection memory_vectors_restore --write` — then compare document counts against the manifest and spot-check that a deprecated document's `superseded_by` still resolves to a document that exists in the restored collection.
