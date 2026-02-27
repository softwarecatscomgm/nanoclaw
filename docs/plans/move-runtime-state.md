# Plan: Move Runtime State to ~/.config/nanoclaw/

## Context

The project root is mounted read-only into the main group's container at `/workspace/project`. This means agents can currently **read** `store/` (WhatsApp credentials, SQLite DB) and `data/` (sessions, IPC) through that mount — even though these are gitignored. The upstream SECURITY.md already placed the mount-allowlist at `~/.config/nanoclaw/` for exactly this reason, but the rest of the state stayed in the project root.

This change moves ALL runtime state out of the project root to `~/.config/nanoclaw/`, making the project root pure code. The main agent retains read-only DB access via a dedicated `/workspace/store` mount.

Additionally, add `docs/ARCHITECTURE.md` to document the 3-part system (setup, host process, agent) and update existing docs with new paths.

---

## Prerequisite: Merge Upstream PR #500 (Pluggable Channels)

**PR:** https://github.com/qwibitai/nanoclaw/pull/500
**Status:** Open — watch upstream, merge when it lands (or fold into fork if it stalls)

PR #500 introduces a pluggable channel architecture that **moves three files** our plan touches into a skill directory:

| Original location | New location (post-PR #500) |
|---|---|
| `src/channels/whatsapp.ts` | `.claude/skills/add-whatsapp/add/src/channels/whatsapp.ts` |
| `src/whatsapp-auth.ts` | `.claude/skills/add-whatsapp/add/src/whatsapp-auth.ts` |
| `setup/whatsapp-auth.ts` | `.claude/skills/add-whatsapp/add/setup/whatsapp-auth.ts` |

It also restructures:
- `src/index.ts` — channel registry pattern (our migration call still fits in `main()`)
- `setup/verify.ts` — multi-channel auth switch (still hardcodes `store/auth` for WhatsApp case)
- `setup/register.ts` — adds `fs.mkdirSync(STORE_DIR, ...)` and `--channel` arg
- `setup/environment.ts` — adds ENABLED_CHANNELS readout (STORE_DIR import unchanged)
- `setup/groups.ts` — adds ENABLED_CHANNELS auto-skip (STORE_DIR import unchanged)
- `src/config.ts` — adds `ENABLED_CHANNELS` export only (STORE_DIR/DATA_DIR untouched)

**Action:** Merge PR #500 into our fork BEFORE starting this plan. All steps below assume the post-PR #500 codebase.

---

## Step 0: Revert Hacked Files

Undo the partial allowlist relocation from the previous session:

- `git restore src/config.ts setup/mounts.ts setup/verify.ts src/mount-security.ts`
- `mv store/mount-allowlist.json ~/.config/nanoclaw/mount-allowlist.json`

After this, the working tree matches HEAD for all nanoclaw source files.

---

## Step 1: Update `src/config.ts` — Central Path Constants

**Post-PR #500 state:** `MOUNT_ALLOWLIST_PATH` uses `HOME_DIR/.config/nanoclaw/`. `STORE_DIR` = `PROJECT_ROOT/store`, `DATA_DIR` = `PROJECT_ROOT/data`. `HOME_DIR` is defined but only used for `MOUNT_ALLOWLIST_PATH`. PR #500 adds `ENABLED_CHANNELS` export (keep it).

**Changes:**

Replace `STORE_DIR`, `DATA_DIR`, and `MOUNT_ALLOWLIST_PATH` with a new `STATE_ROOT`-based hierarchy:

```typescript
// Runtime state lives OUTSIDE the project root — never visible to agents
export const STATE_ROOT = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'nanoclaw',
);

export const AUTH_DIR = path.join(STATE_ROOT, 'auth');
export const DB_DIR = path.join(STATE_ROOT, 'db');
export const LOGS_DIR = path.join(STATE_ROOT, 'logs');
export const IPC_BASE_DIR = path.join(STATE_ROOT, 'ipc');
export const SESSIONS_DIR = path.join(STATE_ROOT, 'sessions');
export const MOUNT_ALLOWLIST_PATH = path.join(STATE_ROOT, 'mount-allowlist.json');
```

**Remove:** `STORE_DIR`, `DATA_DIR`, `HOME_DIR` — dead exports after all consumers migrate.

**Keep unchanged:** `GROUPS_DIR` (stays at `PROJECT_ROOT/groups/`), `MAIN_GROUP_FOLDER`, `ENABLED_CHANNELS`, all container/timer constants.

---

## Step 2: New `src/migrate-state.ts` — Auto-Migration

New file. Called from `src/index.ts` before `initDatabase()`.

Moves files from old project-root locations to `STATE_ROOT`:

| Old Location | New Location |
|---|---|
| `store/auth/` | `STATE_ROOT/auth/` |
| `store/messages.db` (+shm, +wal) | `STATE_ROOT/db/` |
| `store/mount-allowlist.json` | `STATE_ROOT/mount-allowlist.json` |
| `store/auth-status.txt` | `STATE_ROOT/auth-status.txt` |
| `store/qr-auth.html` | `STATE_ROOT/qr-auth.html` |
| `data/sessions/` | `STATE_ROOT/sessions/` |
| `data/ipc/` | `STATE_ROOT/ipc/` |
| `logs/` (service logs only) | `STATE_ROOT/logs/` |

**Note:** `~/.config/nanoclaw/mount-allowlist.json` may already exist from the upstream location. If `STATE_ROOT` resolves to `~/.config/nanoclaw/` (default), no move needed. If `XDG_CONFIG_HOME` is set to something else, move from the old `~/.config/nanoclaw/` path.

**Rules:**
- Idempotent: skip if `STATE_ROOT/db/messages.db` already exists
- `fs.renameSync` for same-filesystem moves (atomic), fall back to copy+delete for cross-filesystem (Dropbox → ~/.config scenario)
- Remove empty old directories after move
- Log each migration step via pino

---

## Step 3: Update Consumers — Host Process (`src/`)

### `src/db.ts`
- **Currently:** imports `STORE_DIR`, uses `path.join(STORE_DIR, 'messages.db')`
- **Change:** import `DB_DIR`, use `path.join(DB_DIR, 'messages.db')`, add `fs.mkdirSync(DB_DIR, { recursive: true })`

### `src/container-runner.ts`
- **Currently:** imports `DATA_DIR`, uses `path.join(DATA_DIR, 'sessions', group.folder, '.claude')` and `path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src')`
- **Change:** import `SESSIONS_DIR`, `DB_DIR`. Replace all `DATA_DIR` session paths with `SESSIONS_DIR`. Add new DB mount for main group only.

### `src/group-folder.ts`
- **Currently:** imports `DATA_DIR`, has `resolveGroupIpcPath()` using `path.resolve(DATA_DIR, 'ipc')`
- **Change:** import `IPC_BASE_DIR`, use it directly

### `src/ipc.ts`
- **Currently:** imports `DATA_DIR`, uses `path.join(DATA_DIR, 'ipc')` for ipcBaseDir
- **Change:** import `IPC_BASE_DIR`, use it directly

### `src/group-queue.ts`
- **Currently:** imports `DATA_DIR`, uses `path.join(DATA_DIR, 'ipc', state.groupFolder, 'input')`
- **Change:** import `IPC_BASE_DIR`, use `path.join(IPC_BASE_DIR, state.groupFolder, 'input')`

### `src/mount-security.ts`
- **Currently:** docstring says `~/.config/nanoclaw/mount-allowlist.json` — already correct. No code changes needed since it imports `MOUNT_ALLOWLIST_PATH` from config.
- **Docstring fix:** Update `store/mount-allowlist.json` → `~/.config/nanoclaw/mount-allowlist.json` in the module docstring (lines 4-6)

### `src/index.ts`
- **Post-PR #500:** uses channel registry pattern, imports `./channels/index.js` barrel
- **Add:** call `migrateStateIfNeeded()` before `initDatabase()`, import from `./migrate-state.js`

---

## Step 3a: Update Consumers — WhatsApp Skill (post-PR #500)

After PR #500, WhatsApp-specific code lives in `.claude/skills/add-whatsapp/`. These files still reference `store/` paths and need updating.

### `.claude/skills/add-whatsapp/add/src/channels/whatsapp.ts`
- **Currently:** imports `STORE_DIR`, uses `path.join(STORE_DIR, 'auth')`
- **Change:** import `AUTH_DIR`, use `AUTH_DIR` directly

### `.claude/skills/add-whatsapp/add/src/whatsapp-auth.ts`
- **Currently:** hardcoded relative paths: `const AUTH_DIR = './store/auth'`, `const QR_FILE = './store/qr-data.txt'`, `const STATUS_FILE = './store/auth-status.txt'`
- **Change:** import `AUTH_DIR` as `AUTH_DIR_PATH`, `STATE_ROOT` from `./config.js`. Compute QR_FILE and STATUS_FILE from `STATE_ROOT`. Rename local constant to avoid shadowing.

### `.claude/skills/add-whatsapp/add/setup/whatsapp-auth.ts`
- **Currently:** uses `path.join(projectRoot, 'store', 'auth', 'creds.json')`, `path.join(projectRoot, 'store', 'auth')`, `path.join(projectRoot, 'store', 'qr-auth.html')`, `path.join(projectRoot, 'store', 'auth-status.txt')`
- **Change:** import `AUTH_DIR`, `STATE_ROOT` from config. Replace all computed store paths.

### `.claude/skills/add-whatsapp/SKILL.md`
- **Currently:** hardcoded `store/auth/creds.json`, `store/auth/`, `store/messages.db`, `logs/nanoclaw.log` references in documentation
- **Change:** replace with `~/.config/nanoclaw/auth/`, `~/.config/nanoclaw/db/messages.db`, `~/.config/nanoclaw/logs/nanoclaw.log`

---

## Step 4: Update Consumers — Setup System (`setup/`)

### `setup/service.ts`
- **Currently:** uses `path.join(projectRoot, 'logs')` for log directory, hardcodes `${projectRoot}/logs/nanoclaw.log` in launchd plist, systemd unit, and nohup wrapper
- **Change:** import `LOGS_DIR` from config. Replace all `${projectRoot}/logs/` with `LOGS_DIR` paths. Change `fs.mkdirSync(path.join(projectRoot, 'logs'))` to `fs.mkdirSync(LOGS_DIR, { recursive: true })`

### `setup/environment.ts`
- **Post-PR #500:** imports `STORE_DIR`, adds `ENABLED_CHANNELS` readout. Uses `path.join(projectRoot, 'store', 'auth')` for auth check, `path.join(STORE_DIR, 'messages.db')` for DB check
- **Change:** import `AUTH_DIR`, `DB_DIR` instead of `STORE_DIR`. Replace auth check with `AUTH_DIR`. Replace DB check with `path.join(DB_DIR, 'messages.db')`.

### `setup/mounts.ts`
- **Currently:** does NOT import from config. Computes `configDir = path.join(os.homedir(), '.config', 'nanoclaw')` locally.
- **Change:** import `MOUNT_ALLOWLIST_PATH`, `STATE_ROOT` from config. Replace local path computation. Use `fs.mkdirSync(path.dirname(MOUNT_ALLOWLIST_PATH), { recursive: true })`.

### `setup/register.ts`
- **Post-PR #500:** imports `STORE_DIR`, uses `path.join(STORE_DIR, 'messages.db')`. PR adds `fs.mkdirSync(STORE_DIR, { recursive: true })` and `--channel` arg.
- **Change:** import `DB_DIR`, use `path.join(DB_DIR, 'messages.db')`. Change `fs.mkdirSync(STORE_DIR, ...)` to `fs.mkdirSync(DB_DIR, { recursive: true })`.

### `setup/groups.ts`
- **Post-PR #500:** imports `STORE_DIR`, adds ENABLED_CHANNELS auto-skip. Uses `path.join(STORE_DIR, 'messages.db')`.
- **Change:** import `DB_DIR`, use `path.join(DB_DIR, 'messages.db')`

### `setup/verify.ts`
- **Post-PR #500:** imports `STORE_DIR`. Replaces single WhatsApp auth check with multi-channel auth switch. WhatsApp case still hardcodes `path.join(projectRoot, 'store', 'auth')`. DB check still uses `path.join(STORE_DIR, 'messages.db')`. Allowlist check may still use hardcoded path.
- **Change:** import `DB_DIR`, `AUTH_DIR`, `MOUNT_ALLOWLIST_PATH` from config. Update WhatsApp case in the auth switch to use `AUTH_DIR`. Replace DB path. Replace allowlist path.

---

## Step 5: Update Tools

### `tools/chat.ts`
- **Currently:** hardcoded `path.join(PROJECT_ROOT, 'store', 'messages.db')` and `path.join(PROJECT_ROOT, 'data', 'ipc', 'main', 'messages')`
- **Change:** import `DB_DIR`, `IPC_BASE_DIR` from `../src/config.js`. Replace both paths.

---

## Step 6: Update `launchd/com.nanoclaw.plist` Template

The template file in the repo uses `{{PROJECT_ROOT}}/logs/` placeholders. Since `setup/service.ts` generates the plist dynamically (not from this template), the template is reference-only. Update it to reflect the new log location or add a note that paths are generated at setup time.

---

## Step 7: Update Agent Memory — `groups/main/CLAUDE.md`

- Replace `/workspace/project/store/messages.db` → `/workspace/store/messages.db`
- Remove references to `/workspace/project/data/registered_groups.json` (legacy JSON, long migrated to SQLite)
- Document the new `/workspace/store` mount (read-only DB access for main)

---

## Step 8: Update Documentation

### New: `docs/ARCHITECTURE.md` — The 3-Part System

**Part A: Setup System** (`setup/`)
- One-time scripts for installation and configuration
- Runs on the host, writes to `~/.config/nanoclaw/` and project root
- Generates service configs (launchd/systemd)
- Entry point: `npx tsx setup/index.ts --step <name>`
- Not used at runtime

**Part B: Host Process** (`src/`, `launchd/`)
- Long-running Node.js service managed by launchd/systemd
- Connects to enabled channels, polls SQLite, spawns containers
- Reads/writes `~/.config/nanoclaw/` for all runtime state
- The project root is its `cwd` but is treated as read-only code

**Part C: Agent Code** (`container/`, `groups/`)
- Runs inside Docker containers, isolated from host
- `container/Dockerfile` + `container/agent-runner/` + `container/skills/`
- Each group has `groups/{name}/` with CLAUDE.md and container logs
- Mounts: group folder (rw), IPC (rw), sessions (rw), DB (ro, main only), project root (ro, main only)

**Part D: Channel Skills** (`.claude/skills/add-*`)
- Post-PR #500: channels are pluggable skills (add-whatsapp, add-telegram, add-discord, add-slack, add-gmail)
- Each skill has `add/` (files copied into src/ on apply) and `modify/` (three-way merge targets)
- Skills reference `AUTH_DIR`, `STATE_ROOT` from config — not hardcoded `store/` paths

**Runtime State** (`~/.config/nanoclaw/`)
- All runtime state lives outside the project root
- Directory layout with purpose of each subdirectory

### `docs/SECURITY.md`
- Update session isolation path: `data/sessions/...` → `~/.config/nanoclaw/sessions/...`
- Update credential storage: `store/auth/` → `~/.config/nanoclaw/auth/`
- Add: project root mount no longer exposes any runtime state to agents

### `docs/SPEC.md`
- Update Folder Structure diagram
- Update Configuration section code sample
- Update Credential Storage table
- Update Troubleshooting paths

### `docs/DEBUG_CHECKLIST.md`
- `logs/nanoclaw.log` → `~/.config/nanoclaw/logs/nanoclaw.log`
- `sqlite3 store/messages.db` → `sqlite3 ~/.config/nanoclaw/db/messages.db`
- `store/auth/` → `~/.config/nanoclaw/auth/`
- `data/sessions/` → `~/.config/nanoclaw/sessions/`
- `~/.config/nanoclaw/mount-allowlist.json` — already correct

### `CLAUDE.md` (project root)
- Update Key Files table with new state location reference
- Add reference to `docs/ARCHITECTURE.md`

### `.claude/skills/setup/SKILL.md`
- Replace `store/auth/` references → `~/.config/nanoclaw/auth/`
- Replace `./store/auth/creds.json` → use config-derived paths

### `.claude/skills/debug/SKILL.md`
- Replace `store/messages.db` → `~/.config/nanoclaw/db/messages.db`
- Replace `data/sessions/` → `~/.config/nanoclaw/sessions/`

---

## Step 9: Update `.gitignore` Comments

Keep rules for safety but update comments:
```gitignore
# Legacy locations — runtime state now lives in ~/.config/nanoclaw/
store/
data/
logs/
```

---

## Step 10: Update Tests

- `src/container-runner.test.ts` — mock `SESSIONS_DIR`, `IPC_BASE_DIR`, `DB_DIR` instead of `DATA_DIR`
- `src/group-queue.test.ts` — mock `IPC_BASE_DIR` instead of `DATA_DIR`
- `setup/register.test.ts` — update DB path expectations, account for `fs.mkdirSync(DB_DIR, ...)`
- `setup/service.test.ts` — update log path expectations

---

## Step 11: Skill Modification Template Audit

Post-PR #500, several channel skills have `modify/` directories containing three-way merge base files that embed snapshots of `src/config.ts` with `STORE_DIR`/`DATA_DIR`. After our changes to `config.ts`, these merge bases may become stale.

**Audit these:**
- `.claude/skills/add-slack/modify/src/config.ts` (if still exists)
- `.claude/skills/add-telegram/modify/src/config.ts` (if still exists)
- Any other skill with `modify/` files referencing `STORE_DIR` or `DATA_DIR`

**Action:** If the skills engine uses three-way merge and the base file references the old constants, regenerate the merge base after our config changes. Alternatively, verify the skills engine handles this gracefully (the merge base diff is about `ENABLED_CHANNELS`, not about `STORE_DIR`).

---

## Directory Layout: ~/.config/nanoclaw/

```
~/.config/nanoclaw/
  auth/                          # Channel credentials (e.g., Baileys multi-file auth)
  db/
    messages.db                  # SQLite database (+shm, +wal)
  sessions/
    {group}/
      .claude/                   # Claude Code sessions (JSONL transcripts)
      agent-runner-src/          # Per-group agent code copy
  ipc/
    {group}/
      messages/                  # Agent → host output messages
      tasks/                     # Host → agent task input
      input/                     # Input snapshots
  logs/
    nanoclaw.log                 # Service stdout
    nanoclaw.error.log           # Service stderr
    setup.log                    # Setup output
  mount-allowlist.json           # Mount security config
  auth-status.txt                # Ephemeral auth flow status
  qr-auth.html                  # Ephemeral QR auth page
```

---

## Container Mount Changes

### Main group mounts:
| Host Path | Container Path | Mode | Notes |
|-----------|---------------|------|-------|
| `groups/main/` | `/workspace/group` | rw | Group memory + logs |
| `PROJECT_ROOT/` | `/workspace/project` | ro | Code only — no store/data visible |
| `DB_DIR/` | `/workspace/store` | **ro** | **NEW** — DB access for main |
| `SESSIONS_DIR/main/.claude/` | `/home/node/.claude` | rw | Claude sessions |
| `IPC_BASE_DIR/main/` | `/workspace/ipc` | rw | IPC channels |
| `SESSIONS_DIR/main/agent-runner-src/` | `/app/src` | rw | Per-group agent code |

### Non-main group mounts:
| Host Path | Container Path | Mode | Notes |
|-----------|---------------|------|-------|
| `groups/{name}/` | `/workspace/group` | rw | Group memory + logs |
| `groups/global/` | `/workspace/global` | ro | Shared memory |
| `SESSIONS_DIR/{name}/.claude/` | `/home/node/.claude` | rw | Claude sessions |
| `IPC_BASE_DIR/{name}/` | `/workspace/ipc` | rw | IPC channels |
| `SESSIONS_DIR/{name}/agent-runner-src/` | `/app/src` | rw | Per-group agent code |

No `/workspace/store` or `/workspace/project` mount for non-main groups.

---

## Verification

1. **Revert check:** `git diff` shows only `.claude/settings.local.json` (not the 4 reverted source files)
2. **Build:** `npm run build` succeeds with no errors
3. **Tests:** `npm test` passes
4. **Migration test:** Start service → confirm `~/.config/nanoclaw/db/messages.db` exists, old `store/` and `data/` are empty or removed
5. **Service logs:** `tail ~/.config/nanoclaw/logs/nanoclaw.log` — logs appear at new location
6. **Channel test:** Send a test message to the main group agent, confirm response
7. **DB mount:** Ask agent to run `sqlite3 /workspace/store/messages.db "SELECT count(*) FROM messages"` — should succeed read-only
8. **Security check:** Ask agent to `ls /workspace/project/store` — should not exist
9. **Setup verify:** `npx tsx setup/index.ts --step verify` passes with new paths
10. **Setup idempotency:** Re-run `npx tsx setup/index.ts --step verify` on a fresh install (no `store/` directory) — passes
