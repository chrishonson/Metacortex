#!/usr/bin/env node

import { spawn } from "node:child_process";

const steps = [
  {
    label: "functions test",
    command: "npm",
    args: ["--prefix", "functions", "test"]
  },
  {
    label: "functions build",
    command: "npm",
    args: ["--prefix", "functions", "run", "build"]
  }
];

const hasSmokeEnv = Boolean(process.env.MCP_BASE_URL && process.env.MCP_ADMIN_TOKEN);

if (hasSmokeEnv) {
  steps.push({
    label: "deployed smoke verification",
    command: "npm",
    args: ["--prefix", "functions", "run", "smoke"]
  });
}

for (const step of steps) {
  console.log(`\n==> ${step.label}`);
  await runStep(step.command, step.args);
}

if (!hasSmokeEnv) {
  console.log(
    "\nSkipped deployed smoke verification because MCP_BASE_URL and MCP_ADMIN_TOKEN are not both set."
  );
}

async function runStep(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env
    });

    child.on("exit", code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });

    child.on("error", reject);
  });
}
