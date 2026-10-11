const command = process.argv[2] ?? "";
if (["freeze-bundle", "validate-bundle", "import-recorded", "compare-files"].includes(command)) {
  // File commands never load deployment environment or initialize Firebase.
  const { runLocalEvaluation } = await import("./provider-eval-files.js");
  await runLocalEvaluation(command, process.argv.slice(3));
} else {
  await import("./retrieval-eval-legacy.js");
}
export {};
