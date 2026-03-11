#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

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
echo "== Embedding dimension alignment =="
INDEX_DIMS="$(node <<'NODE'
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
NODE
)"

CONFIG_DIM="$(node <<'NODE'
const fs = require("fs");

const text = fs.readFileSync("functions/src/config.ts", "utf8");
const match = text.match(/GEMINI_EMBEDDING_DIMENSIONS,\s*(\d+),/s);

if (!match) {
  console.error("Could not parse GEMINI_EMBEDDING_DIMENSIONS fallback from functions/src/config.ts");
  process.exit(1);
}

process.stdout.write(match[1]);
NODE
)"

echo "index dimensions: ${INDEX_DIMS}"
echo "config dimension: ${CONFIG_DIM}"

if [[ "$INDEX_DIMS" != "$CONFIG_DIM" ]]; then
  echo "ERROR: Firestore index dimensions do not match the config fallback." >&2
  exit 1
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
echo "Next step: follow docs/DEPLOYMENT-SESSION-RUNBOOK.md"
