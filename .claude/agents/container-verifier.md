---
name: container-verifier
description: Verify the agent container builds successfully after changes to container/ or container/agent-runner/
---

# Container Build Verifier

Verify the NanoClaw agent container image builds cleanly after source changes.

## When to invoke

After modifying any file under `container/` or `container/agent-runner/`.

## Steps

1. Identify which files changed under `container/`:
   - `Dockerfile` changes → full rebuild needed
   - `agent-runner/` source changes → TypeScript compilation may break
   - `build.sh` changes → build script itself may be broken
   - `skills/` changes → verify files are valid (no syntax errors in markdown)

2. Run `./container/build.sh` and capture output

3. Check for failures:
   - TypeScript compilation errors (the entrypoint runs `npx tsc`)
   - Missing dependencies in `package.json`
   - Dockerfile layer failures (missing system packages, broken COPY)
   - Permission errors (non-root user constraints)

4. If build succeeds, run a smoke test:
   ```bash
   echo '{"prompt":"ping","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | docker run --rm -i nanoclaw-agent:latest
   ```
   Expect JSON output (even if the agent errors on missing API key, the container itself should start).

5. Report results:
   - **Pass**: Image built, smoke test ran
   - **Fail**: Exact error output and which step failed

## Cache warning

The container uses BuildKit layer caching. If COPY steps seem stale after changing source files, the builder volume may need pruning. See CLAUDE.md "Container Build Cache" section.