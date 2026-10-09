#!/usr/bin/env node

// Verify only the distributable files, with an independent dependency install.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildJourneyKitBundle } from "./build-journey-kit.mjs";

const bundle = buildJourneyKitBundle();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metacortex-kit-check-"));
const env = { ...process.env };
// Never run the verifier's optional live smoke test during packaging checks.
delete env.MCP_BASE_URL;
delete env.MCP_ADMIN_TOKEN;

try {
  for (const [relative, content] of Object.entries(bundle.srcFiles)) {
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  const pkg = JSON.parse(bundle.srcFiles["functions/package.json"]);
  for (const command of Object.values(pkg.scripts)) {
    for (const match of command.matchAll(/\bscripts\/([\w./-]+\.(?:ts|mjs))\b/g)) {
      assert.ok(bundle.srcFiles[`functions/scripts/${match[1]}`], `Missing packaged script: ${match[1]}`);
    }
  }
  for (const [command, args] of [
    ["npm", ["--prefix", "functions", "ci", "--no-audit", "--no-fund"]],
    [process.execPath, ["scripts/verify-journey-kit-install.mjs"]]
  ]) {
    const result = spawnSync(command, args, { cwd: directory, env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Bundle verification failed: ${command} (exit ${result.status})`);
  }
  console.log(`Verified clean Journey installation: ${Object.keys(bundle.srcFiles).length} files.`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
