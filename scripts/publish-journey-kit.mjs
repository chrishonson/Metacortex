#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildJourneyKitBundle,
  defaultOutputPath,
  writeJourneyKitBundle
} from "./build-journey-kit.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.JOURNEY_API_KEY;

  if (!apiKey) {
    throw new Error("Missing JOURNEY_API_KEY in the environment.");
  }

  const baseUrl = args.baseUrl ?? process.env.JOURNEY_BASE_URL ?? "https://www.journeykits.ai";
  const visibility = args.visibility ?? "public";
  const changelog = args.changelog ?? "Initial public release.";
  const outputPath = resolveOutputPath(args.out ?? defaultOutputPath);

  const bundle = buildJourneyKitBundle();
  writeJourneyKitBundle(bundle, outputPath);

  const whoami = await fetchJson(new URL("/api/auth/whoami", baseUrl), {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  const author = args.author ?? whoami?.agent?.name;
  if (!author) {
    throw new Error("Could not determine the Journey author name. Pass --author explicitly.");
  }

  const emailVerified = Boolean(whoami?.agent?.emailVerifiedAt);
  const publishApproved = Boolean(whoami?.agent?.publishApproved);
  if (!emailVerified && !publishApproved) {
    console.warn(
      "Warning: the current Journey agent does not appear to have a verified email or publishApproved flag. Publish may fail."
    );
  }

  const payload = {
    bundle,
    author,
    visibility,
    changelog,
    ...(args.skipRelease ? { skipRelease: true } : {})
  };

  const result = await fetchJson(new URL("/api/kits/import", baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const kitRef = `${result.kit?.owner ?? author}/${result.kit?.slug ?? bundle.manifest.slug}`;
  console.log(`Published ${kitRef}`);
  console.log(`Revision: ${result.revisionId}`);

  if (result.release?.tag) {
    console.log(`Release: ${result.release.tag}`);
  }

  if (Array.isArray(result.findings) && result.findings.length > 0) {
    console.log(`Findings: ${result.findings.length}`);
  }

  if (result.indexing?.status) {
    console.log(`Indexing: ${result.indexing.status}`);
  }

  console.log(`Bundle snapshot written to ${path.relative(REPO_ROOT, outputPath)}`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Request to ${url} returned non-JSON content: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(payload.error ?? payload.message ?? `Request failed with status ${response.status}.`);
  }

  return payload;
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--skip-release") {
      args.skipRelease = true;
      continue;
    }

    if (current === "--base-url") {
      args.baseUrl = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "--visibility") {
      args.visibility = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "--changelog") {
      args.changelog = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "--author") {
      args.author = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "--out") {
      args.out = argv[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unsupported argument: ${current}`);
  }

  return args;
}

function resolveOutputPath(outputPath) {
  if (!outputPath) {
    return defaultOutputPath;
  }

  return path.isAbsolute(outputPath)
    ? outputPath
    : path.resolve(REPO_ROOT, outputPath);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
