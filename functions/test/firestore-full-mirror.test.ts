import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DOCUMENT_ID_FIELD } from "../scripts/support/firestore-codec.js";
import {
  encodedDocumentIds,
  idsToPrune,
  removeStaleNdjsonFiles
} from "../scripts/support/firestore-full-mirror.js";

describe("encodedDocumentIds", () => {
  it("collects archive ids", () => {
    expect(
      encodedDocumentIds([
        { [DOCUMENT_ID_FIELD]: "a" },
        { [DOCUMENT_ID_FIELD]: "b" }
      ])
    ).toEqual(new Set(["a", "b"]));
  });

  it("rejects documents without an id", () => {
    expect(() => encodedDocumentIds([{ content: "no id" }])).toThrow(
      /archive document missing _id/
    );
  });
});

describe("idsToPrune", () => {
  it("returns target ids absent from the archive", () => {
    expect(idsToPrune(["keep", "extra", "also-keep"], new Set(["keep", "also-keep"]))).toEqual([
      "extra"
    ]);
  });

  it("returns nothing when target is a subset of the archive", () => {
    expect(idsToPrune(["a"], new Set(["a", "b"]))).toEqual([]);
  });
});

describe("removeStaleNdjsonFiles", () => {
  it("deletes ndjson for collections no longer in the snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "full-backup-"));
    fs.writeFileSync(path.join(dir, "keep.ndjson"), "{}\n");
    fs.writeFileSync(path.join(dir, "gone.ndjson"), "{}\n");
    fs.writeFileSync(path.join(dir, "AUDIT.md"), "leave me");

    expect(removeStaleNdjsonFiles(dir, ["keep"])).toEqual(["gone.ndjson"]);
    expect(fs.existsSync(path.join(dir, "keep.ndjson"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "gone.ndjson"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "AUDIT.md"), "utf8")).toBe("leave me");
  });
});
