#!/bin/bash
set -e

# Recompile agent-runner source (may be customised per-group via bind mount)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Read JSON input from stdin and run the agent
# Secrets are passed via stdin — never written to disk
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
