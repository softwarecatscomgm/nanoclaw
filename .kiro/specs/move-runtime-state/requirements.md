# Requirements: Move Runtime State to ~/.config/nanoclaw/

## Feature Description

Move all runtime state (`store/`, `data/`, `logs/`) from the project root to `~/.config/nanoclaw/` so the project root becomes pure code and container agents cannot read host state through the read-only project mount. The main agent retains read-only database access via a dedicated `/workspace/store` mount.

### Prerequisite

Upstream PR [qwibitai/nanoclaw#500](https://github.com/qwibitai/nanoclaw/pull/500) (pluggable channel architecture) must be merged into our fork before implementation begins. PR #500 moves WhatsApp-specific code (`src/channels/whatsapp.ts`, `src/whatsapp-auth.ts`, `setup/whatsapp-auth.ts`) into `.claude/skills/add-whatsapp/`. All requirements below assume the post-PR #500 codebase.

---

## Requirement 1: Centralized State Root

### User Story
As a NanoClaw operator, I want all runtime state stored outside the project root so that cloning the repo gives clean code with no leftover state, and agents cannot read host secrets through the project mount.

### Acceptance Criteria
- [ ] AC1: `src/config.ts` exports `STATE_ROOT` computed from `XDG_CONFIG_HOME` or defaulting to `~/.config/nanoclaw/`
- [ ] AC2: Specific subdirectory constants are exported: `AUTH_DIR`, `DB_DIR`, `LOGS_DIR`, `IPC_BASE_DIR`, `SESSIONS_DIR`, `MOUNT_ALLOWLIST_PATH`
- [ ] AC3: `STORE_DIR` and `DATA_DIR` exports are removed after all consumers are migrated
- [ ] AC4: `GROUPS_DIR` remains at `PROJECT_ROOT/groups/` (tracked in git, not runtime state)

---

## Requirement 2: Auto-Migration

### User Story
As a NanoClaw operator with an existing installation, I want my runtime state automatically moved to the new location on first startup so I don't have to manually relocate files.

### Acceptance Criteria
- [ ] AC1: New `src/migrate-state.ts` module moves `store/auth/`, `store/messages.db*`, `store/mount-allowlist.json`, `data/sessions/`, `data/ipc/`, and `logs/` to their `STATE_ROOT` subdirectories
- [ ] AC2: Migration is idempotent — skips if `STATE_ROOT/db/messages.db` already exists
- [ ] AC3: Migration handles cross-filesystem moves (Dropbox project root → `~/.config/`) via copy+delete fallback
- [ ] AC4: Empty old directories (`store/`, `data/`, `logs/`) are cleaned up after successful move
- [ ] AC5: Migration runs in `src/index.ts` before `initDatabase()` is called
- [ ] AC6: Each migration step is logged via pino

---

## Requirement 3: Host Process Consumer Updates

### User Story
As a developer, I want all host process source files to use the new config constants so there are no hardcoded references to `store/` or `data/` in the project root.

### Acceptance Criteria
- [ ] AC1: `src/db.ts` uses `DB_DIR` for database path
- [ ] AC2: `src/container-runner.ts` uses `SESSIONS_DIR` for session paths and `DB_DIR` for the new main-group DB mount
- [ ] AC3: `src/group-folder.ts`, `src/ipc.ts`, and `src/group-queue.ts` use `IPC_BASE_DIR` for IPC paths
- [ ] AC4: `src/index.ts` calls migration before database init
- [ ] AC5: No source file in `src/` contains a reference to `STORE_DIR` or `DATA_DIR` after migration

---

## Requirement 3a: WhatsApp Skill Consumer Updates (post-PR #500)

### User Story
As a developer, I want the WhatsApp skill's source files (relocated from core by PR #500) to use the new config constants so the skill works correctly when applied to an installation using `~/.config/nanoclaw/`.

### Acceptance Criteria
- [ ] AC1: `.claude/skills/add-whatsapp/add/src/channels/whatsapp.ts` uses `AUTH_DIR` instead of `STORE_DIR` for auth directory
- [ ] AC2: `.claude/skills/add-whatsapp/add/src/whatsapp-auth.ts` imports `AUTH_DIR` and `STATE_ROOT` from config instead of hardcoded `./store/` paths
- [ ] AC3: `.claude/skills/add-whatsapp/add/setup/whatsapp-auth.ts` uses `AUTH_DIR` and `STATE_ROOT` from config instead of computing `store/` paths
- [ ] AC4: `.claude/skills/add-whatsapp/SKILL.md` documentation references `~/.config/nanoclaw/auth/`, `~/.config/nanoclaw/db/messages.db`, and `~/.config/nanoclaw/logs/` instead of `store/` and `logs/` paths

---

## Requirement 4: Setup System Consumer Updates

### User Story
As a developer running setup, I want all setup scripts to read/write state at the new `~/.config/nanoclaw/` location so fresh installations go directly to the correct paths.

### Acceptance Criteria
- [ ] AC1: `setup/service.ts` writes log paths to `LOGS_DIR` in launchd plist, systemd unit, and nohup wrapper
- [ ] AC2: `setup/environment.ts` uses `AUTH_DIR` and `DB_DIR` for preflight checks (post-PR #500: also has ENABLED_CHANNELS — keep it)
- [ ] AC3: `setup/mounts.ts` uses `MOUNT_ALLOWLIST_PATH` from config instead of computing `~/.config/nanoclaw/` locally
- [ ] AC4: `setup/register.ts` uses `DB_DIR` for database path and `fs.mkdirSync(DB_DIR, ...)` (post-PR #500: also has `--channel` arg — keep it)
- [ ] AC5: `setup/groups.ts` uses `DB_DIR` for database path (post-PR #500: also has ENABLED_CHANNELS auto-skip — keep it)
- [ ] AC6: `setup/verify.ts` uses `DB_DIR`, `AUTH_DIR`, and `MOUNT_ALLOWLIST_PATH` from config; updates WhatsApp case in multi-channel auth switch to use `AUTH_DIR` (post-PR #500: auth check is now a channel switch)

---

## Requirement 4a: Setup Idempotency at New Paths

### User Story
As a NanoClaw operator, I want setup to work correctly and remain idempotent regardless of whether runtime state was migrated from the old location or created fresh at `~/.config/nanoclaw/`, so I can re-run any setup step without breaking my installation.

### Acceptance Criteria
- [ ] AC1: Each setup step that writes state creates its target directory under `STATE_ROOT` with `{ recursive: true }` if it does not already exist (e.g., `AUTH_DIR`, `DB_DIR`, `LOGS_DIR`)
- [ ] AC2: `setup/whatsapp-auth.ts` checks for auth credentials at `AUTH_DIR` (not `store/auth/`), so re-running auth after migration finds existing creds
- [ ] AC3: `setup/environment.ts` preflight checks look at `AUTH_DIR` and `DB_DIR` — passing when state exists at the new location even if `store/` does not exist
- [ ] AC4: `setup/verify.ts` validates state at `AUTH_DIR`, `DB_DIR`, and `MOUNT_ALLOWLIST_PATH` — a fresh install that never had `store/` passes verification
- [ ] AC5: `setup/service.ts` creates `LOGS_DIR` (not `PROJECT_ROOT/logs/`) before writing the service config, so a fresh install gets logs at the correct location
- [ ] AC6: Running `npx tsx setup/index.ts --step verify` succeeds on both migrated and fresh installations without manual intervention

---

## Requirement 5: Main Agent Database Access

### User Story
As the main group agent, I want read-only access to the SQLite database so I can query registered groups, messages, and tasks without going through IPC.

### Acceptance Criteria
- [ ] AC1: `container-runner.ts` mounts `DB_DIR` at `/workspace/store` read-only for the main group only
- [ ] AC2: Non-main groups do NOT receive a `/workspace/store` mount
- [ ] AC3: `groups/main/CLAUDE.md` references `/workspace/store/messages.db` as the database path

---

## Requirement 5a: Agent Code Mount Point Adjustment

### User Story
As a container agent, I want my CLAUDE.md memory and any agent-facing documentation to reference the correct mount paths so I can access the database and other resources without relying on paths that no longer exist after the runtime state relocation.

### Acceptance Criteria
- [ ] AC1: `groups/main/CLAUDE.md` replaces `/workspace/project/store/messages.db` with `/workspace/store/messages.db` as the database path
- [ ] AC2: `groups/main/CLAUDE.md` removes the legacy reference to `/workspace/project/data/registered_groups.json` (migrated to SQLite long ago)
- [ ] AC3: `groups/main/CLAUDE.md` documents the new `/workspace/store` mount as a read-only DB directory available only to the main group
- [ ] AC4: No agent-facing file (`groups/*/CLAUDE.md`, `container/skills/*.md`) references `/workspace/project/store` or `/workspace/project/data` as accessible paths
- [ ] AC5: Agent-runner code (`container/agent-runner/`) does NOT need changes — its hardcoded paths (`/workspace/ipc`, `/workspace/group`, `/workspace/global`) remain valid since those mount points are unchanged

---

## Requirement 6: Security — No Runtime State in Project Root

### User Story
As a security-conscious operator, I want agents to have zero visibility into host runtime state (credentials, session data, IPC) through the project root mount.

### Acceptance Criteria
- [ ] AC1: After migration, `store/`, `data/`, and `logs/` do not exist under the project root (or are empty)
- [ ] AC2: An agent running `ls /workspace/project/store` inside a container sees no directory or an empty directory
- [ ] AC3: The mount-allowlist remains outside the project root and is never mounted into containers
- [ ] AC4: `.gitignore` retains `store/`, `data/`, `logs/` rules with a comment noting they are legacy locations

---

## Requirement 7: Tools Update

### User Story
As a CLI tool user, I want `tools/chat.ts` to work with the new state locations so I can send/receive messages after the migration.

### Acceptance Criteria
- [ ] AC1: `tools/chat.ts` uses `DB_DIR` and `IPC_BASE_DIR` from config instead of hardcoded `store/` and `data/` paths

---

## Requirement 7a: Skill Modification Template Audit (post-PR #500)

### User Story
As a developer applying channel skills after the state relocation, I want the skill three-way merge templates to be compatible with the updated `src/config.ts` so skill application does not produce merge conflicts or reintroduce `STORE_DIR`/`DATA_DIR` references.

### Acceptance Criteria
- [ ] AC1: Any `modify/` files in `.claude/skills/add-*/` that embed `src/config.ts` snapshots are checked for `STORE_DIR`/`DATA_DIR` references
- [ ] AC2: If stale merge bases are found, they are regenerated against the updated config or verified to merge cleanly via the skills engine
- [ ] AC3: Applying each channel skill (`add-whatsapp`, `add-telegram`, `add-discord`, `add-slack`, `add-gmail`) does not reintroduce `STORE_DIR` or `DATA_DIR` into `src/config.ts`

---

## Requirement 8: Test Updates

### User Story
As a developer, I want all tests to pass after the path migration so the CI pipeline stays green.

### Acceptance Criteria
- [ ] AC1: `src/container-runner.test.ts` mocks `SESSIONS_DIR`, `IPC_BASE_DIR`, `DB_DIR` instead of `DATA_DIR`
- [ ] AC2: `src/group-queue.test.ts` mocks `IPC_BASE_DIR` instead of `DATA_DIR`
- [ ] AC3: `setup/register.test.ts` and `setup/service.test.ts` use updated path expectations
- [ ] AC4: `npm test` passes with zero failures

---

## Requirement 9: Documentation — Architecture Guide

### User Story
As a new contributor or operator, I want documentation explaining the 3-part system architecture and where runtime state lives so I can understand the project without reading all the source code.

### Acceptance Criteria
- [ ] AC1: New `docs/ARCHITECTURE.md` documents the three parts: Setup System, Host Process, Agent Code
- [ ] AC2: `docs/ARCHITECTURE.md` includes the `~/.config/nanoclaw/` directory layout with purpose of each subdirectory
- [ ] AC3: `docs/ARCHITECTURE.md` includes the container mount table for main and non-main groups
- [ ] AC4: `docs/SECURITY.md` updated with new credential and session paths
- [ ] AC5: `docs/SPEC.md` updated with new folder structure diagram and configuration sample
- [ ] AC6: `docs/DEBUG_CHECKLIST.md` updated with new log, DB, auth, and session paths
- [ ] AC7: `CLAUDE.md` (project root) references `docs/ARCHITECTURE.md` and updated state locations
- [ ] AC8: `.claude/skills/setup/SKILL.md` and `.claude/skills/debug/SKILL.md` updated with new paths
