import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { bundleHash, corpusHash, parseBundle, sha256 } from "../src/providerEvaluation.js";

const directories: string[] = [];
const root = path.resolve(import.meta.dirname, "..");
const bundlePath = path.join(root, "eval/s4/bundle.json");
const bundle = parseBundle(JSON.parse(fs.readFileSync(bundlePath, "utf8")));
const directory = () => {const d = fs.mkdtempSync(path.join(os.tmpdir(), "s4-cli-")); directories.push(d); return d;};
function cli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/retrieval-eval.ts", ...args], {
    cwd: root, encoding: "utf8", timeout: 15000,
    env: {PATH: process.env.PATH, HOME: directory(), GCLOUD_PROJECT: "invalid-no-cloud-access"}
  });
}
function runFile(file: string, candidate = false) {
  const cases = bundle.cases.filter(c => c.query !== null);
  const rows = cases.map((c, i) => ({case_id: c.case_id, repetition: 1,
    response: {status: "success", ranked_source_ids: candidate && i === 1 ? [] : c.required_ids,
      synthesized_answer: null, error_code: null, latency_ms: null}}));
  fs.writeFileSync(file, JSON.stringify({schema_version: "provider-eval-run.v1", run_id: "scripted",
    bundle_sha256: bundleHash(bundle), provider: {name: "scripted-contract-test", version: "v1", mode: "recorded",
      config_sha256: sha256("fixture"), corpus_sha256: corpusHash(bundle)},
    protocol: {kind: "retrieval-only", repetitions: 1, cutoffs: [1, 5]}, rows}));
}
afterEach(() => {for (const d of directories.splice(0)) fs.rmSync(d, {recursive: true, force: true});});

describe("existing eval CLI file commands", () => {
  it("validates and freezes without credentials or a Firebase connection", () => {
    const output = path.join(directory(), "bundle.json");
    const result = cli(["freeze-bundle", "--input", "eval/s4/definition.json", "--out", output]);
    expect(result.status, result.stderr).toBe(0);
    expect(parseBundle(JSON.parse(fs.readFileSync(output, "utf8")))).toEqual(bundle);
    const validated = cli(["validate-bundle", "--bundle", output]);
    expect(validated.status, validated.stderr).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({scenarios: 8, retrieval_cases: 5, review_pending: 8});
    const again = cli(["freeze-bundle", "--input", "eval/s4/definition.json", "--out", output]);
    expect(again.status).not.toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe(fs.readFileSync(bundlePath, "utf8"));
  });

  it("writes a per-case regression report and returns exit code 2", () => {
    const d = directory(), before = path.join(d, "before.json"), after = path.join(d, "after.json"), output = path.join(d, "report.json");
    runFile(before); runFile(after, true);
    const result = cli(["compare-files", "--bundle", bundlePath, "--baseline", before, "--candidate", after, "--out", output]);
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({status: "regression", regression_count: 1, adoption_eligible: false});
  });

  it("refuses incomplete imports without creating an output artifact", () => {
    const d = directory(), input = path.join(d, "input.json"), output = path.join(d, "output.json");
    runFile(input);
    const raw = JSON.parse(fs.readFileSync(input, "utf8")); raw.rows.pop(); fs.writeFileSync(input, JSON.stringify(raw));
    const result = cli(["import-recorded", "--bundle", bundlePath, "--input", input, "--out", output]);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("does not relabel an imported fixture as live execution", () => {
    const d = directory(), input = path.join(d, "input.json"), output = path.join(d, "output.json"); runFile(input);
    const raw = JSON.parse(fs.readFileSync(input, "utf8")); raw.provider.mode = "live"; fs.writeFileSync(input, JSON.stringify(raw));
    const result = cli(["import-recorded", "--bundle", bundlePath, "--input", input, "--out", output]);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(output)).toBe(false);
  });
});
