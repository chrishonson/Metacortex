#!/usr/bin/env bash

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-my-brain-88870}"
MEMORY_COLLECTION="${MEMORY_COLLECTION:-memory_vectors}"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --memory-collection)
      MEMORY_COLLECTION="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

collection_groups=(
  "${MEMORY_COLLECTION}_write_fingerprints"
  "memory_events"
)

for collection_group in "${collection_groups[@]}"; do
  command=(
    gcloud firestore fields ttls update
    expires_at
    "--collection-group=${collection_group}"
    --enable-ttl
    "--project=${PROJECT_ID}"
    --async
  )

  if [[ "$DRY_RUN" == "true" ]]; then
    printf 'dry-run:'
    printf ' %q' "${command[@]}"
    printf '\n'
  else
    "${command[@]}"
  fi
done

echo "Verify with:"
echo "gcloud firestore fields ttls list --project=${PROJECT_ID}"
