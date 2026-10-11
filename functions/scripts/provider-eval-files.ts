import fs from "node:fs";
import { parseBundle, parseRun, bundleHash, corpusHash, compareRuns, summarizeRun, sha256 } from "../src/providerEvaluation.js";

const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
// Never overwrite a frozen bundle or a historical result in place.
const write = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", {flag: "wx", mode: 0o600});
export async function runLocalEvaluation(command: string, args: string[]): Promise<void> {
  const allowed: Record<string, string[]> = {
    "freeze-bundle": ["input", "out"], "validate-bundle": ["bundle"],
    "import-recorded": ["bundle", "input", "out"],
    "compare-files": ["bundle", "baseline", "candidate", "out"]
  };
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!.replace(/^--/, ""), value = args[index + 1];
    if (!args[index]!.startsWith("--") || !allowed[command]?.includes(key) || !value || value.startsWith("--") || options.has(key)) {
      throw new Error("Invalid, duplicate or unknown local eval argument");
    }
    options.set(key, value);
  }
  const required = (key: string): string => {
    const value = options.get(key);
    if (!value) throw new Error(`Missing --${key}`);
    return value;
  };
  for (const key of allowed[command] ?? []) required(key);
  if (command === "freeze-bundle") {
    const raw = read(required("input")) as Record<string, unknown>;
    if (!raw || !Array.isArray(raw.sources)) throw new Error("Definition needs sources");
    const bundle = parseBundle({...raw, sources: raw.sources.map(source => {
      if (!source || typeof source !== "object" || typeof source.content !== "string") throw new Error("Invalid source content");
      // Validate a supplied hash instead of silently repairing a changed source.
      return {...source, sha256: source.sha256 ?? sha256(source.content)};
    })});
    write(required("out"), bundle);
    console.log(JSON.stringify({bundle_sha256: bundleHash(bundle), corpus_sha256: corpusHash(bundle), cases: bundle.cases.length}));
    return;
  }
  const bundle = parseBundle(read(required("bundle")));
  if (command === "validate-bundle") {
    console.log(JSON.stringify({bundle_sha256: bundleHash(bundle), corpus_sha256: corpusHash(bundle),
      sources: bundle.sources.length, scenarios: bundle.cases.length,
      retrieval_cases: bundle.cases.filter(c => c.query !== null).length,
      review_pending: bundle.cases.filter(c => c.label.review_status === "needs_review").length}));
  } else if (command === "import-recorded") {
    const run = parseRun(read(required("input")), bundle);
    if (run.provider.mode !== "recorded") throw new Error("File import cannot certify live provider execution");
    write(required("out"), run);
    console.log(JSON.stringify(summarizeRun(run, bundle), null, 2));
  } else if (command === "compare-files") {
    const report = compareRuns(bundle, read(required("baseline")), read(required("candidate")));
    write(required("out"), report);
    console.log(JSON.stringify({status: report.status, regression_count: report.regression_count,
      uncomparable_count: report.uncomparable_count, adoption_eligible: report.adoption_eligible}));
    process.exitCode = report.status === "regression" ? 2 : report.status === "incomplete" ? 3 : 0;
  } else {
    throw new Error("Unknown local evaluation command");
  }
}
