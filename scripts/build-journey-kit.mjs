#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const JOURNEY_KIT_DIR = path.join(REPO_ROOT, "journey-kit");
const KIT_MD_PATH = path.join(JOURNEY_KIT_DIR, "kit.md");
const README_PATH = path.join(JOURNEY_KIT_DIR, "README.md");
export const defaultOutputPath = path.join(
  JOURNEY_KIT_DIR,
  "dist",
  "bundle.json"
);

const REQUIRED_SECTIONS = [
  "Goal",
  "When to Use",
  "Setup",
  "Steps",
  "Constraints",
  "Safety Notes"
];

const SECTION_MINIMUMS = new Map([
  ["Goal", 20],
  ["Setup", 40],
  ["Steps", 60],
  ["Constraints", 15],
  ["Safety Notes", 15],
  ["Failures Overcome", 30],
  ["Validation", 20]
]);

const README_REQUIRED_HEADINGS = [
  "Quick Start",
  "When to Use",
  "How It Works",
  "Setup",
  "Inputs & Outputs"
];

const SOURCE_FILE_MANIFEST = [
  {
    path: ".node-version",
    role: "config",
    description: "Pinned Node.js major version expected by the bundled verification and functions workflow."
  },
  {
    path: "firebase.json",
    role: "config",
    description: "Firebase configuration for Firestore, Cloud Functions, and emulator ports."
  },
  {
    path: "firestore.rules",
    role: "config",
    description: "Firestore security rules that deny direct client access to memory collections."
  },
  {
    path: "firestore.indexes.json",
    role: "config",
    description: "Vector and composite Firestore indexes required by MetaCortex search."
  },
  {
    path: "scripts/deploy-session-preflight.sh",
    role: "script",
    description: "Pre-deploy checks for env files, index dimensions, tests, build output, and Firebase target state."
  },
  {
    path: "scripts/verify-journey-kit-install.mjs",
    role: "script",
    description: "Root verification entrypoint that runs local tests/build and optional deployed smoke validation."
  },
  {
    path: "functions/.env.example",
    role: "config",
    description: "Template environment file documenting the required MetaCortex runtime variables."
  },
  {
    path: "functions/package.json",
    role: "config",
    description: "Functions package manifest with runtime scripts and dependencies."
  },
  {
    path: "functions/tsconfig.json",
    role: "config",
    description: "TypeScript compiler configuration for the Functions codebase."
  },
  {
    path: "functions/vitest.config.ts",
    role: "config",
    description: "Vitest configuration for the MetaCortex test suite."
  },
  {
    path: "functions/scripts/mcp-smoke-test.mjs",
    role: "script",
    description: "Smoke-test client for deployed MetaCortex MCP endpoints."
  },
  {
    path: "functions/src/app.ts",
    role: "source",
    description: "Express app entrypoint with routing, auth, and CORS handling."
  },
  {
    path: "functions/src/config.ts",
    role: "source",
    description: "Environment configuration loader and validation logic."
  },
  {
    path: "functions/src/embeddings.ts",
    role: "source",
    description: "Gemini embedding and multimodal normalization clients."
  },
  {
    path: "functions/src/errors.ts",
    role: "source",
    description: "HTTP error type shared across the server."
  },
  {
    path: "functions/src/index.ts",
    role: "source",
    description: "Firebase Functions entrypoint that exports the MetaCortex HTTP service."
  },
  {
    path: "functions/src/mcpServer.ts",
    role: "source",
    description: "MCP tool registration and client-specific allowlist wiring."
  },
  {
    path: "functions/src/memoryRepository.ts",
    role: "source",
    description: "Firestore-backed repository for store, search, fetch, and deprecate operations."
  },
  {
    path: "functions/src/normalize.ts",
    role: "source",
    description: "Normalization helpers for text and metadata handling."
  },
  {
    path: "functions/src/observability.ts",
    role: "source",
    description: "Structured logging and audit-event persistence for tool calls and ingress events."
  },
  {
    path: "functions/src/runtime.ts",
    role: "source",
    description: "Lazy runtime dependency initialization and caching."
  },
  {
    path: "functions/src/service.ts",
    role: "source",
    description: "Business logic for memory creation, search, fetch, and deprecation."
  },
  {
    path: "functions/src/types.ts",
    role: "source",
    description: "Shared enums and TypeScript interfaces for MetaCortex data models."
  },
  {
    path: "functions/test/app.test.ts",
    role: "test",
    description: "HTTP tests for auth, routing, and scoped client profile behavior."
  },
  {
    path: "functions/test/config.test.ts",
    role: "test",
    description: "Configuration parsing and validation tests."
  },
  {
    path: "functions/test/mcp.integration.test.ts",
    role: "test",
    description: "End-to-end MCP protocol tests against the real transport layer."
  },
  {
    path: "functions/test/runtime.test.ts",
    role: "test",
    description: "Runtime dependency initialization tests."
  },
  {
    path: "functions/test/service.test.ts",
    role: "test",
    description: "Service-layer tests using in-memory fakes."
  },
  {
    path: "functions/test/support/fakes.ts",
    role: "test-support",
    description: "In-memory fake repository, embeddings, and test factory helpers."
  }
];

const EXAMPLE_FILES = [
  {
    fileName: "browser-client-setup.md",
    sourcePath: path.join(JOURNEY_KIT_DIR, "examples", "browser-client-setup.md")
  },
  {
    fileName: "smoke-test.md",
    sourcePath: path.join(JOURNEY_KIT_DIR, "examples", "smoke-test.md")
  }
];

const SECRET_PATTERNS = [
  { label: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "GitHub token", pattern: /\bghp_[A-Za-z0-9]{12,}\b/g },
  { label: "Slack bot token", pattern: /\bxoxb-[A-Za-z0-9-]{10,}\b/g },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z-_]{35}\b/g },
  { label: "Journey API key", pattern: /\bakit_[A-Za-z0-9_]{12,}\b/g },
  { label: "inline password assignment", pattern: /\bpassword\s*=\s*["'][^"']+["']/gi },
  { label: "inline secret assignment", pattern: /\bsecret\s*=\s*["'][^"']+["']/gi }
];

const ABSOLUTE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+/g,
  /C:\\Users\\[A-Za-z0-9._-]+/g
];

const LOCAL_HOST_PATTERN = /\b(?:localhost|127\.0\.0\.1)\b/gi;

const BANNED_PATH_SEGMENTS = [
  "node_modules",
  "functions/lib",
  "functions/coverage",
  ".claude",
  ".agents",
  ".agent"
];

const BANNED_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".mov",
  ".mp4"
]);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = resolveOutputPath(args.out);
  const bundle = buildJourneyKitBundle();

  if (args.write !== false) {
    writeJourneyKitBundle(bundle, outputPath);
  }

  if (args.stdout) {
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  } else {
    console.log(
      `Built Journey kit bundle with ${Object.keys(bundle.srcFiles).length} source files and ${Object.keys(bundle.examples).length} examples.`
    );

    if (args.write !== false) {
      console.log(`Bundle written to ${path.relative(REPO_ROOT, outputPath)}`);
    }
  }
}

export function buildJourneyKitBundle() {
  const kitSource = readUtf8(KIT_MD_PATH);
  const readmeSource = readUtf8(README_PATH);
  const { frontmatter, body } = parseKitMd(kitSource);
  const sections = extractSections(body);

  validateFrontmatter(frontmatter);
  validateSections(sections);
  validateReadme(readmeSource, frontmatter);

  const srcFiles = {};
  const fileManifest = [];

  for (const entry of SOURCE_FILE_MANIFEST) {
    validateBundlePath(entry.path);

    const absolutePath = path.join(REPO_ROOT, entry.path);
    const content = readUtf8(absolutePath);

    srcFiles[entry.path] = content;
    fileManifest.push({
      path: entry.path,
      role: entry.role,
      description: entry.description
    });
  }

  const examples = {};
  for (const example of EXAMPLE_FILES) {
    validateTopLevelBundleFileName(example.fileName);
    examples[example.fileName] = readUtf8(example.sourcePath);
  }

  const manifest = buildManifest(frontmatter, sections, fileManifest);
  const bundle = {
    manifest,
    kitDoc: normalizeTrailingNewline(kitSource),
    readme: normalizeTrailingNewline(readmeSource),
    skillFiles: {},
    toolFiles: {},
    examples,
    assets: {},
    srcFiles
  };

  validateBundle(bundle);
  return bundle;
}

export function writeJourneyKitBundle(bundle, outputPath = defaultOutputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(bundle, null, 2));
}

function buildManifest(frontmatter, sections, fileManifest) {
  const description = normalizeInlineWhitespace(sections.get("Goal") ?? "");
  const failures = frontmatter.failuresOvercome ?? frontmatter.failures ?? [];
  const timestamp = new Date().toISOString();

  return {
    schemaVersion: "1.0.0",
    slug: frontmatter.slug,
    title: frontmatter.title,
    summary: frontmatter.summary,
    description,
    version: frontmatter.version,
    license: frontmatter.license ?? "MIT",
    tags: frontmatter.tags ?? [],
    model: frontmatter.model,
    models: frontmatter.models ?? [],
    tools: frontmatter.tools ?? [],
    skills: frontmatter.skills ?? [],
    tech: frontmatter.tech ?? [],
    services: frontmatter.services ?? [],
    parameters: frontmatter.parameters ?? [],
    failuresOvercome: failures,
    useCases: frontmatter.useCases ?? [],
    inputs: frontmatter.inputs ?? [],
    outputs: frontmatter.outputs ?? [],
    fileManifest,
    prerequisites: frontmatter.prerequisites ?? [],
    dependencies: normalizeDependencies(frontmatter.dependencies),
    verification: frontmatter.verification ?? {},
    selfContained: frontmatter.selfContained === true,
    orgRequired: frontmatter.orgRequired === true,
    requiredResources: frontmatter.requiredResources ?? [],
    environment: normalizeEnvironment(frontmatter.environment ?? {}),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function normalizeEnvironment(environment) {
  return {
    ...environment,
    ...(Array.isArray(environment.os)
      ? {
          os: environment.os.join(", ")
        }
      : {}),
    ...(Array.isArray(environment.platforms)
      ? {
          platforms: environment.platforms
        }
      : {})
  };
}

function normalizeDependencies(dependencies = {}) {
  return {
    runtime: dependencies.runtime ?? {},
    npm: dependencies.npm ?? {},
    cli: dependencies.cli ?? [],
    secrets: dependencies.secrets ?? [],
    kits: dependencies.kits ?? []
  };
}

function parseKitMd(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);

  if (!match) {
    throw new Error("journey-kit/kit.md is missing JSON frontmatter delimited by --- fences.");
  }

  let frontmatter;
  try {
    frontmatter = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`journey-kit/kit.md frontmatter must be valid JSON: ${error.message}`);
  }

  const body = normalized.slice(match[0].length);
  return { frontmatter, body };
}

function extractSections(markdown) {
  const sections = new Map();
  const headingRegex = /^##\s+(.+)$/gm;
  const headings = [...markdown.matchAll(headingRegex)];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const title = heading[1].trim();
    const start = heading.index + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : markdown.length;
    const content = markdown.slice(start, end).trim();

    sections.set(title, content);
  }

  return sections;
}

function validateFrontmatter(frontmatter) {
  const requiredKeys = ["schema", "slug", "title", "summary", "version", "model"];
  for (const key of requiredKeys) {
    if (!frontmatter[key]) {
      throw new Error(`journey-kit/kit.md frontmatter is missing required field "${key}".`);
    }
  }

  if (frontmatter.schema !== "kit/1.0") {
    throw new Error(`Expected journey-kit/kit.md schema to be "kit/1.0", received "${frontmatter.schema}".`);
  }

  if (frontmatter.owner || frontmatter.createdAt || frontmatter.updatedAt) {
    throw new Error("Do not author owner/createdAt/updatedAt in journey-kit/kit.md; Journey sets those fields.");
  }

  if (frontmatter.summary.length > 160) {
    throw new Error(`journey-kit/kit.md summary exceeds 160 characters (${frontmatter.summary.length}).`);
  }

  if (!Array.isArray(frontmatter.tags) || frontmatter.tags.length === 0) {
    throw new Error("journey-kit/kit.md must declare at least one tag.");
  }

  if (
    (!Array.isArray(frontmatter.tools) || frontmatter.tools.length === 0) &&
    (!Array.isArray(frontmatter.skills) || frontmatter.skills.length === 0)
  ) {
    throw new Error("journey-kit/kit.md must declare at least one tool or skill.");
  }

  if (!frontmatter.model.hosting) {
    throw new Error("journey-kit/kit.md model.hosting is required.");
  }
}

function validateSections(sections) {
  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) {
      throw new Error(`journey-kit/kit.md is missing required section "## ${name}".`);
    }
  }

  for (const [name, minimum] of SECTION_MINIMUMS) {
    if (!sections.has(name)) {
      continue;
    }

    const content = normalizeInlineWhitespace(sections.get(name) ?? "");
    if (content.length < minimum) {
      throw new Error(`Section "## ${name}" is too short (${content.length} chars; need at least ${minimum}).`);
    }
  }
}

function validateReadme(readme, frontmatter) {
  const normalized = normalizeTrailingNewline(readme);

  if (!normalized.startsWith("# ")) {
    throw new Error("journey-kit/README.md must start with a level-1 heading.");
  }

  for (const heading of README_REQUIRED_HEADINGS) {
    const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}$`, "m");
    if (!pattern.test(normalized)) {
      throw new Error(`journey-kit/README.md is missing required section \"## ${heading}\".`);
    }
  }

  const expectedQuickStart = `journey install agentnightshift/${frontmatter.slug}`;
  if (!normalized.includes(expectedQuickStart)) {
    throw new Error(
      `journey-kit/README.md must include the Quick Start command "${expectedQuickStart}".`
    );
  }
}

function validateBundle(bundle) {
  if (!bundle.readme || normalizeInlineWhitespace(bundle.readme).length < 200) {
    throw new Error("Bundle readme is missing or too short.");
  }

  if (!bundle.manifest.description) {
    throw new Error("Generated manifest description is empty. Fill out the ## Goal section.");
  }

  if (normalizeInlineWhitespace(bundle.manifest.description) === normalizeInlineWhitespace(bundle.manifest.summary)) {
    throw new Error("Manifest description must differ from the summary.");
  }

  if (!Array.isArray(bundle.manifest.inputs) || bundle.manifest.inputs.length === 0) {
    throw new Error("Manifest must include at least one input.");
  }

  if (!Array.isArray(bundle.manifest.outputs) || bundle.manifest.outputs.length === 0) {
    throw new Error("Manifest must include at least one output.");
  }

  if (
    !Array.isArray(bundle.manifest.failuresOvercome) ||
    bundle.manifest.failuresOvercome.length === 0
  ) {
    throw new Error("Manifest must include at least one failure entry.");
  }

  if (bundle.manifest.fileManifest.length !== Object.keys(bundle.srcFiles).length) {
    throw new Error("fileManifest must contain one entry for every srcFiles item.");
  }

  if (bundle.manifest.verification?.command !== "node scripts/verify-journey-kit-install.mjs") {
    throw new Error("Manifest verification.command must point to node scripts/verify-journey-kit-install.mjs.");
  }

  if (!bundle.srcFiles["scripts/verify-journey-kit-install.mjs"]) {
    throw new Error("Bundle must include scripts/verify-journey-kit-install.mjs in srcFiles.");
  }

  if (!bundle.srcFiles[".node-version"]) {
    throw new Error("Bundle must include .node-version in srcFiles.");
  }

  for (const fileEntry of bundle.manifest.fileManifest) {
    if (!bundle.srcFiles[fileEntry.path]) {
      throw new Error(`fileManifest entry "${fileEntry.path}" does not exist in srcFiles.`);
    }

    validateBundlePath(fileEntry.path);
  }

  for (const srcPath of Object.keys(bundle.srcFiles)) {
    validateBundlePath(srcPath);
  }

  const bundleTextEntries = collectBundleStringEntries(bundle);

  for (const entry of bundleTextEntries) {
    for (const rule of SECRET_PATTERNS) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(entry.content)) {
        throw new Error(`Bundle validation failed: found ${rule.label} in ${entry.location}.`);
      }
    }

    for (const pattern of ABSOLUTE_PATH_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(entry.content)) {
        throw new Error(`Bundle validation failed: found a hardcoded user path in ${entry.location}.`);
      }
    }

    LOCAL_HOST_PATTERN.lastIndex = 0;
    if (!isAllowedLocalhostEntry(entry.location) && LOCAL_HOST_PATTERN.test(entry.content)) {
      throw new Error(`Bundle validation failed: found localhost-only content in ${entry.location}.`);
    }
  }
}

function collectBundleStringEntries(bundle) {
  const entries = [
    { location: "kitDoc", content: bundle.kitDoc },
    { location: "readme", content: bundle.readme },
    ...Object.entries(bundle.examples).map(([name, content]) => ({
      location: `examples/${name}`,
      content
    }))
  ];

  for (const [name, content] of Object.entries(bundle.skillFiles)) {
    entries.push({ location: `skillFiles/${name}`, content });
  }

  for (const [name, content] of Object.entries(bundle.toolFiles)) {
    entries.push({ location: `toolFiles/${name}`, content });
  }

  for (const [name, content] of Object.entries(bundle.assets)) {
    entries.push({ location: `assets/${name}`, content });
  }

  for (const [name, content] of Object.entries(bundle.srcFiles)) {
    entries.push({ location: `srcFiles/${name}`, content });
  }

  entries.push({
    location: "manifest",
    content: JSON.stringify(bundle.manifest)
  });

  return entries;
}

function validateBundlePath(bundlePath) {
  if (!bundlePath || path.isAbsolute(bundlePath)) {
    throw new Error(`Bundle path "${bundlePath}" must be a safe relative path.`);
  }

  if (bundlePath.includes("..") || bundlePath.includes("\\")) {
    throw new Error(`Bundle path "${bundlePath}" must not contain ".." or backslashes.`);
  }

  for (const segment of BANNED_PATH_SEGMENTS) {
    if (bundlePath.includes(segment)) {
      throw new Error(`Bundle path "${bundlePath}" includes a banned segment "${segment}".`);
    }
  }

  if (
    bundlePath.includes(".env") &&
    bundlePath !== "functions/.env.example"
  ) {
    throw new Error(`Bundle path "${bundlePath}" is not allowed because .env files must stay local.`);
  }

  const extension = path.extname(bundlePath).toLowerCase();
  if (BANNED_FILE_EXTENSIONS.has(extension)) {
    throw new Error(`Bundle path "${bundlePath}" uses banned file type "${extension}".`);
  }
}

function validateTopLevelBundleFileName(fileName) {
  if (fileName.includes("/") || fileName.includes("\\")) {
    throw new Error(`Bundle example file "${fileName}" must be a top-level file name.`);
  }
}

function isAllowedLocalhostEntry(location) {
  return location.startsWith("srcFiles/functions/test/");
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function normalizeInlineWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeTrailingNewline(text) {
  return `${text.replace(/\s+$/, "")}\n`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const args = {
    out: defaultOutputPath,
    stdout: false,
    write: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--stdout") {
      args.stdout = true;
      continue;
    }

    if (current === "--no-write") {
      args.write = false;
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

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
