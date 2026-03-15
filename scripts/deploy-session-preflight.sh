#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

read_env_key() {
  local file_path="$1"
  local key="$2"

  node -e '
const fs = require("fs");

const [filePath, key] = process.argv.slice(1);

if (!fs.existsSync(filePath)) {
  process.exit(0);
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

  const candidateKey = line.slice(0, separatorIndex).trim();

  if (candidateKey !== key) {
    continue;
  }

  let value = line.slice(separatorIndex + 1).trim();

  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("\x27") && value.endsWith("\x27"))
  ) {
    value = value.slice(1, -1);
  }

  process.stdout.write(value);
  process.exit(0);
}
' "$file_path" "$key"
}

echo "== Git status =="
git status --short || true

echo
echo "== Env files =="
if [[ -f functions/.env.prod ]]; then
  echo "found functions/.env.prod"

  missing_keys=()

  grep -q '^GEMINI_API_KEY=' functions/.env.prod || missing_keys+=("GEMINI_API_KEY")
  grep -q '^MCP_AUTH_TOKEN=' functions/.env.prod || missing_keys+=("MCP_AUTH_TOKEN")
  grep -q '^GEMINI_EMBEDDING_DIMENSIONS=' functions/.env.prod || missing_keys+=("GEMINI_EMBEDDING_DIMENSIONS")

  if (( ${#missing_keys[@]} > 0 )); then
    echo "warning: functions/.env.prod is missing keys: ${missing_keys[*]}"
  fi
else
  echo "warning: functions/.env.prod not found"
fi

if [[ -f functions/.env ]]; then
  echo "found functions/.env"
fi

echo
echo "== Client profiles =="
if [[ -f functions/.env.prod ]]; then
  node - <<'NODE'
const fs = require("fs");

const envText = fs.readFileSync("functions/.env.prod", "utf8");
const line = envText
  .split(/\r?\n/)
  .map(item => item.trim())
  .find(item => item.startsWith("MCP_CLIENT_PROFILES_JSON="));

if (!line) {
  console.log(
    "warning: functions/.env.prod does not define MCP_CLIENT_PROFILES_JSON; browser-hosted clients will not have a scoped endpoint"
  );
  process.exit(0);
}

const rawValue = line.slice("MCP_CLIENT_PROFILES_JSON=".length).trim();

if (!rawValue) {
  console.log(
    "warning: MCP_CLIENT_PROFILES_JSON is empty; browser-hosted clients will not have a scoped endpoint"
  );
  process.exit(0);
}

let profiles;

try {
  profiles = JSON.parse(rawValue);
} catch {
  console.log("ERROR: MCP_CLIENT_PROFILES_JSON is not valid JSON");
  process.exit(1);
}

if (!Array.isArray(profiles)) {
  console.log("ERROR: MCP_CLIENT_PROFILES_JSON must be a JSON array");
  process.exit(1);
}

const ids = profiles
  .filter(profile => profile && typeof profile === "object")
  .map(profile => profile.id)
  .filter(id => typeof id === "string" && id.trim().length > 0);

console.log(`client profiles: ${ids.join(", ") || "(none)"}`);

const expectedProfiles = [
  {
    id: "chatgpt-web",
    expectedOrigin: "https://chatgpt.com"
  },
  {
    id: "claude-web",
    expectedOrigin: "https://claude.ai"
  }
];

for (const expectedProfile of expectedProfiles) {
  const profile = profiles.find(
    candidate =>
      candidate &&
      typeof candidate === "object" &&
      candidate.id === expectedProfile.id
  );

  if (!profile) {
    console.log(
      `warning: ${expectedProfile.id} profile missing; deploy separate scoped client endpoints for ChatGPT web and Claude web`
    );
    continue;
  }

  const allowedTools = Array.isArray(profile.allowedTools)
    ? profile.allowedTools.filter(tool => typeof tool === "string")
    : [];
  const allowedOrigins = Array.isArray(profile.allowedOrigins)
    ? profile.allowedOrigins.filter(origin => typeof origin === "string")
    : [];
  const allowedFilterStates = Array.isArray(profile.allowedFilterStates)
    ? profile.allowedFilterStates.filter(state => typeof state === "string")
    : [];

  for (const requiredTool of ["remember_context", "search_context", "fetch_context"]) {
    if (!allowedTools.includes(requiredTool)) {
      console.log(
        `warning: ${expectedProfile.id} profile is missing recommended tool ${requiredTool}`
      );
    }
  }

  if (!allowedOrigins.includes(expectedProfile.expectedOrigin)) {
    console.log(
      `warning: ${expectedProfile.id} profile does not allow expected origin ${expectedProfile.expectedOrigin}`
    );
  }

  if (allowedFilterStates.length === 0) {
    console.log(
      `warning: ${expectedProfile.id} profile does not declare allowedFilterStates; active-only is recommended for first rollout`
    );
  } else {
    console.log(
      `${expectedProfile.id} allowedFilterStates: ${allowedFilterStates.join(", ")}`
    );
  }
}
NODE
else
  echo "warning: functions/.env.prod not found"
fi

echo
echo "== Embedding config alignment =="
INDEX_DIMS="$(node -e '
const fs = require("fs");

const data = JSON.parse(fs.readFileSync("firestore.indexes.json", "utf8"));
const dims = [
  ...new Set(
    data.indexes
      .flatMap(index => index.fields)
      .filter(field => field.fieldPath === "embedding")
      .map(field => field.vectorConfig?.dimension)
      .filter(Boolean)
  )
];

process.stdout.write(dims.join(","));
')"

CONFIG_DEFAULT_DIM="$(node -e '
const fs = require("fs");

const text = fs.readFileSync("functions/src/config.ts", "utf8");
const match = text.match(/GEMINI_EMBEDDING_DIMENSIONS,\s*(\d+),/s);

if (!match) {
  console.error("Could not parse GEMINI_EMBEDDING_DIMENSIONS fallback from functions/src/config.ts");
  process.exit(1);
}

process.stdout.write(match[1]);
')"

CONFIG_DEFAULT_MODEL="$(node -e '
const fs = require("fs");

const text = fs.readFileSync("functions/src/config.ts", "utf8");
const match = text.match(/GEMINI_EMBEDDING_MODEL\?\.\s*trim\(\)\s*\|\|\s*"([^"]+)"/);

if (!match) {
  console.error("Could not parse GEMINI_EMBEDDING_MODEL fallback from functions/src/config.ts");
  process.exit(1);
}

process.stdout.write(match[1]);
')"

PROD_DIM=""
PROD_MODEL=""

if [[ -f functions/.env.prod ]]; then
  PROD_DIM="$(read_env_key functions/.env.prod GEMINI_EMBEDDING_DIMENSIONS)"
  PROD_MODEL="$(read_env_key functions/.env.prod GEMINI_EMBEDDING_MODEL)"
fi

EFFECTIVE_DIM="${PROD_DIM:-$CONFIG_DEFAULT_DIM}"
EFFECTIVE_MODEL="${PROD_MODEL:-$CONFIG_DEFAULT_MODEL}"

echo "index dimensions: ${INDEX_DIMS}"
echo "config fallback dimension: ${CONFIG_DEFAULT_DIM}"
if [[ -n "$PROD_DIM" ]]; then
  echo "functions/.env.prod dimension: ${PROD_DIM}"
else
  echo "functions/.env.prod dimension: (not set, using config fallback)"
fi
echo "effective deployment dimension: ${EFFECTIVE_DIM}"
echo "config fallback model: ${CONFIG_DEFAULT_MODEL}"
if [[ -n "$PROD_MODEL" ]]; then
  echo "functions/.env.prod model: ${PROD_MODEL}"
else
  echo "functions/.env.prod model: (not set, using config fallback)"
fi
echo "effective deployment model: ${EFFECTIVE_MODEL}"

if [[ "$INDEX_DIMS" != "$EFFECTIVE_DIM" ]]; then
  echo "ERROR: Firestore index dimensions do not match the effective deployment dimension." >&2
  exit 1
fi

if [[ -f functions/.env.prod && -z "$PROD_MODEL" ]]; then
  echo "warning: functions/.env.prod does not pin GEMINI_EMBEDDING_MODEL; deployment will rely on the code fallback (${CONFIG_DEFAULT_MODEL})"
fi

if [[ -n "$PROD_MODEL" && "$PROD_MODEL" != "$CONFIG_DEFAULT_MODEL" ]]; then
  echo "warning: functions/.env.prod overrides the embedding model. Do not mix vectors from different embedding models in the same Firestore collection."
fi

echo
echo "== Firebase project =="
if command -v firebase >/dev/null 2>&1; then
  firebase use || true
else
  echo "warning: firebase CLI not installed"
fi

echo
echo "== Tests =="
npm --prefix functions test

echo
echo "== Build =="
npm --prefix functions run build

echo
echo "Preflight passed."
echo "Next step: follow docs/DEPLOYMENT.md"
