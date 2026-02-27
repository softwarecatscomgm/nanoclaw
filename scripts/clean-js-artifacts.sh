#!/usr/bin/env bash
#
# clean-js-artifacts.sh
#
# Finds and deletes .js files that have a corresponding .ts or .tsx source file.
# These are TypeScript compile artifacts that should not be committed.
#
# Usage:
#   scripts/clean-js-artifacts.sh          # dry-run (list only, exit 0)
#   scripts/clean-js-artifacts.sh --check  # list and exit 1 if any found
#   scripts/clean-js-artifacts.sh --delete # actually delete files
#
# Pre-commit hook usage:
#   --check mode blocks the commit so you can review before deleting.
#   --delete mode silently removes artifacts (use with caution).

set -euo pipefail

DELETE=false
CHECK=false
VERBOSE=false
COUNT=0

for arg in "$@"; do
  case "$arg" in
    --delete) DELETE=true ;;
    --check) CHECK=true ;;
    --verbose) VERBOSE=true ;;
  esac
done

# Search the project for .js files, skipping known non-artifact directories
while IFS= read -r js_file; do
  # Derive the corresponding .ts or .tsx path
  ts_file="${js_file%.js}.ts"
  tsx_file="${js_file%.js}.tsx"

  if [ -f "$ts_file" ] || [ -f "$tsx_file" ]; then
    COUNT=$((COUNT + 1))
    if [ "$DELETE" = true ]; then
      rm "$js_file"
      if [ "$VERBOSE" = true ]; then
        echo "Deleted: $js_file"
      fi
    else
      echo "$js_file"
    fi
  fi
done < <(find . \
  -name '*.js' \
  -not -path '*/node_modules/*' \
  -not -path './dist/*' \
  -not -path './dist-ssr/*' \
  -not -path './.nx/*' \
  -not -path './coverage-*/*' \
  -not -path './.git/*' \
  -type f)

if [ "$COUNT" -eq 0 ]; then
  exit 0
fi

if [ "$DELETE" = true ]; then
  echo "Cleaned $COUNT TypeScript compile artifact(s)."
elif [ "$CHECK" = true ]; then
  echo ""
  echo "Found $COUNT .js artifact(s) with matching .ts/.tsx source."
  echo "Run 'scripts/clean-js-artifacts.sh --delete' to remove them."
  exit 1
else
  echo ""
  echo "Found $COUNT .js artifact(s) with matching .ts/.tsx source."
  echo "Run with --delete to remove them."
fi
