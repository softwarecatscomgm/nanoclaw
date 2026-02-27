---
name: run-ci-locally
description: Use when about to push, before creating a PR, or when user asks to run CI checks locally
---

# Run CI Locally

Mirror the GitHub Actions CI pipeline locally to catch failures before pushing.

## Steps

Run these sequentially — stop on first failure:

1. **Format check**
   ```bash
   npm run format:check
   ```
   Fix: `npm run format` to auto-fix, then re-run check.

2. **Typecheck**
   ```bash
   npx tsc --noEmit
   ```
   Fix: resolve TypeScript errors in reported files.

3. **Tests**
   ```bash
   npx vitest run
   ```
   Fix: investigate and fix failing tests.

## On failure

Report which step failed, show the error output, and fix it. Do not skip steps or mark failures as known issues.

## On success

Report all three checks passed. Do not push unless user asks.
