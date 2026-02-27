# Technical Design: Move Runtime State to ~/.config/nanoclaw/

## Overview

Move all runtime state (`store/`, `data/`, `logs/`) from the project root to `~/.config/nanoclaw/` (or `$XDG_CONFIG_HOME/nanoclaw/`). After this change, the project root is pure code. Container agents can no longer read host state (credentials, database, sessions, IPC) through the read-only `/workspace/project` mount. The main group retains read-only database access via a new dedicated `/workspace/store` mount.

This requires changes across 19 source files, 1 new module, and 4 test files.

---

## Architecture

### STATE_ROOT Hierarchy

All runtime state lives under a single root, computed from the XDG Base Directory specification:

```
STATE_ROOT = $XDG_CONFIG_HOME/nanoclaw/    (default: ~/.config/nanoclaw/)
```

Directory layout:

```
~/.config/nanoclaw/
  auth/                          # WhatsApp credentials (Baileys multi-file auth)
  db/
    messages.db                  # SQLite database (+shm, +wal)
  sessions/
    {group}/
      .claude/                   # Claude Code sessions (JSONL transcripts)
      agent-runner-src/          # Per-group agent code copy
  ipc/
    {group}/
      messages/                  # Agent -> host output messages
      tasks/                     # Host -> agent task input
      input/                     # Input snapshots
  logs/
    nanoclaw.log                 # Service stdout
    nanoclaw.error.log           # Service stderr
    setup.log                    # Setup output
  mount-allowlist.json           # Mount security config
  auth-status.txt                # Ephemeral auth flow status
  qr-auth.html                  # Ephemeral QR auth page
```

### Relationship to XDG_CONFIG_HOME

- If `XDG_CONFIG_HOME` is set, `STATE_ROOT` = `$XDG_CONFIG_HOME/nanoclaw/`
- Otherwise, `STATE_ROOT` = `~/.config/nanoclaw/` (XDG default)
- `GROUPS_DIR` stays at `PROJECT_ROOT/groups/` (tracked in git, not runtime state)
- `PROJECT_ROOT` continues to be `process.cwd()`

### What Does NOT Move

- `groups/` -- git-tracked group memory and logs, not runtime state
- `.env` -- git-ignored but project-specific configuration
- `container/` -- Dockerfile and agent code
- Container group logs (`groups/{name}/logs/`) -- these are per-invocation debug logs, not service logs

---

## Components: Modified Files

### 1. `src/config.ts` (lines 1-64)

**Current state (HEAD):**
- Line 20: `const PROJECT_ROOT = process.cwd();`
- Line 21: `const HOME_DIR = process.env.HOME || os.homedir();`
- Lines 24-29: `MOUNT_ALLOWLIST_PATH` computed from `HOME_DIR/.config/nanoclaw/`
- Line 30: `export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');`
- Line 31: `export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');`
- Line 32: `export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');`

**Changes:**

Replace lines 19-32 with:

```typescript
// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();

// Runtime state lives OUTSIDE the project root -- never visible to agents
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

export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
```

**Removals:**
- `HOME_DIR` (was private, only used by the old `MOUNT_ALLOWLIST_PATH` computation)
- `STORE_DIR` (replaced by `AUTH_DIR`, `DB_DIR`)
- `DATA_DIR` (replaced by `SESSIONS_DIR`, `IPC_BASE_DIR`)

**Kept unchanged:**
- `GROUPS_DIR` (line 31, stays at `PROJECT_ROOT/groups/`)
- `MAIN_GROUP_FOLDER` (line 33)
- All container/timer/trigger constants (lines 35-64)

---

### 2. `src/db.ts` (lines 1-640)

**Current state (HEAD):**
- Line 5: `import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';`
- Line 131-133: `initDatabase()` uses `path.join(STORE_DIR, 'messages.db')`
- Line 613: `migrateJsonState()` uses `path.join(DATA_DIR, filename)` for legacy JSON migration

**Changes:**

Line 5 -- change import:
```typescript
import { ASSISTANT_NAME, DB_DIR, IPC_BASE_DIR } from './config.js';
```

Lines 131-133 -- change `initDatabase()`:
```typescript
export function initDatabase(): void {
  const dbPath = path.join(DB_DIR, 'messages.db');
  fs.mkdirSync(DB_DIR, { recursive: true });
  // ... rest unchanged
```

Note: `mkdirSync` target changes from `path.dirname(dbPath)` (which was `STORE_DIR`) to `DB_DIR` directly. Both are equivalent but the latter is clearer.

Line 613 -- `migrateJsonState()` legacy JSON path:

The `migrateJsonState()` function reads from `DATA_DIR` for `router_state.json`, `sessions.json`, and `registered_groups.json`. These are ancient legacy files from before SQLite. After migration, no installations should have them. However, the function must still work for the edge case where someone has a very old installation that never ran the JSON->SQLite migration.

Two options:
1. Keep `DATA_DIR` import solely for this legacy path. Problem: `DATA_DIR` is being removed.
2. Compute the old path inline: `path.join(process.cwd(), 'data', filename)`.

**Decision:** Option 2. Compute inline with a comment explaining this is a legacy path. This avoids keeping `DATA_DIR` alive.

```typescript
function migrateJsonState(): void {
  // Legacy: these JSON files predate SQLite. Path is hardcoded to the old
  // project-root location since new installations never create them.
  const legacyDataDir = path.join(process.cwd(), 'data');
  const migrateFile = (filename: string) => {
    const filePath = path.join(legacyDataDir, filename);
    // ... rest unchanged
```

---

### 3. `src/channels/whatsapp.ts` (lines 1-290)

**Current state (HEAD):**
- Line 14-17: `import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, STORE_DIR } from '../config.js';`
- Line 59: `const authDir = path.join(STORE_DIR, 'auth');`

**Changes:**

Line 14-17 -- change import:
```typescript
import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  AUTH_DIR,
} from '../config.js';
```

Line 59-60 -- replace local `authDir` computation:
```typescript
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
```

The local `const authDir` variable is removed entirely. `AUTH_DIR` from config is used directly.

---

### 4. `src/whatsapp-auth.ts` (lines 1-160)

**Current state (HEAD):**
- Line 23: `const AUTH_DIR = './store/auth';`
- Line 24: `const QR_FILE = './store/qr-data.txt';`
- Line 25: `const STATUS_FILE = './store/auth-status.txt';`
- All three are module-level constants with hardcoded relative paths.
- Line 52: `await useMultiFileAuthState(AUTH_DIR)`
- Line 55: `fs.writeFileSync(STATUS_FILE, 'already_authenticated')`
- Multiple other uses of these three constants throughout.

**Changes:**

Add import at top of file (after existing imports):
```typescript
import { AUTH_DIR as CONFIG_AUTH_DIR, STATE_ROOT } from './config.js';
```

Replace lines 23-25:
```typescript
const AUTH_DIR = CONFIG_AUTH_DIR;
const QR_FILE = path.join(STATE_ROOT, 'qr-data.txt');
const STATUS_FILE = path.join(STATE_ROOT, 'auth-status.txt');
```

The aliased import (`CONFIG_AUTH_DIR` -> `AUTH_DIR`) avoids renaming every usage of `AUTH_DIR` throughout the file. All existing references to `AUTH_DIR`, `QR_FILE`, and `STATUS_FILE` continue to work unchanged.

**Alternative approach:** Rename the local constants to avoid shadowing (e.g., `authDir`, `qrFile`, `statusFile`) and import `AUTH_DIR` directly. This is cleaner but requires more changes. The alias approach is safer for this refactor since the file has many references.

---

### 5. `src/container-runner.ts` (lines 1-410)

**Current state (HEAD):**
- Line 9-17: imports include `DATA_DIR` and `GROUPS_DIR`
- Line 103-108: `groupSessionsDir` = `path.join(DATA_DIR, 'sessions', group.folder, '.claude')`
- Lines 170-178: `groupAgentRunnerDir` = `path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src')`

**Changes:**

Line 9-17 -- change import:
```typescript
import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DB_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  IPC_BASE_DIR,
  SESSIONS_DIR,
  TIMEZONE,
} from './config.js';
```

Remove `DATA_DIR` from imports.

Lines 103-108 -- change sessions dir:
```typescript
  const groupSessionsDir = path.join(
    SESSIONS_DIR,
    group.folder,
    '.claude',
  );
```

Lines 170-178 -- change agent-runner dir:
```typescript
  const groupAgentRunnerDir = path.join(
    SESSIONS_DIR,
    group.folder,
    'agent-runner-src',
  );
```

**New: Main group DB mount** (add after the IPC mount block, around line 165):

```typescript
  // Main group gets read-only access to the database directory
  // so it can query registered groups, messages, and tasks directly
  if (isMain) {
    mounts.push({
      hostPath: DB_DIR,
      containerPath: '/workspace/store',
      readonly: true,
    });
  }
```

This goes inside `buildVolumeMounts()`, after the IPC mount and before the agent-runner copy. The `isMain` parameter is already available in this function.

**IPC path note:** The IPC path is already handled by `resolveGroupIpcPath()` from `group-folder.ts`, so no IPC path changes are needed in this file. The `resolveGroupIpcPath()` function will be updated in `group-folder.ts` (see below).

---

### 6. `src/group-folder.ts` (lines 1-44)

**Current state (HEAD):**
- Line 3: `import { DATA_DIR, GROUPS_DIR } from './config.js';`
- Line 38-43: `resolveGroupIpcPath()` computes `path.resolve(DATA_DIR, 'ipc')` as the base

**Changes:**

Line 3 -- change import:
```typescript
import { GROUPS_DIR, IPC_BASE_DIR } from './config.js';
```

Lines 38-43 -- change `resolveGroupIpcPath()`:
```typescript
export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcPath = path.resolve(IPC_BASE_DIR, folder);
  ensureWithinBase(IPC_BASE_DIR, ipcPath);
  return ipcPath;
}
```

The intermediate `ipcBaseDir` local variable is eliminated since `IPC_BASE_DIR` from config serves the same purpose.

---

### 7. `src/ipc.ts` (lines 1-260)

**Current state (HEAD):**
- Line 6-7: imports include `DATA_DIR`
- Line 41: `const ipcBaseDir = path.join(DATA_DIR, 'ipc');`
- Line 42: `fs.mkdirSync(ipcBaseDir, { recursive: true });`
- Lines 48-49, 62-63: use `ipcBaseDir` local variable

**Changes:**

Lines 6-7 -- change import:
```typescript
import {
  IPC_BASE_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
```

Remove `DATA_DIR` from imports.

Line 41-42 -- replace local `ipcBaseDir`:
```typescript
  fs.mkdirSync(IPC_BASE_DIR, { recursive: true });
```

Lines 48-49, 62-63 and all other references to local `ipcBaseDir` -- replace with `IPC_BASE_DIR`:
```typescript
      groupFolders = fs.readdirSync(IPC_BASE_DIR).filter((f) => {
        const stat = fs.statSync(path.join(IPC_BASE_DIR, f));
```

```typescript
      const messagesDir = path.join(IPC_BASE_DIR, sourceGroup, 'messages');
      const tasksDir = path.join(IPC_BASE_DIR, sourceGroup, 'tasks');
```

And the error directory:
```typescript
              const errorDir = path.join(IPC_BASE_DIR, 'errors');
```

All 9 occurrences of `ipcBaseDir` in this file are replaced with `IPC_BASE_DIR`.

---

### 8. `src/group-queue.ts` (lines 1-300)

**Current state (HEAD):**
- Line 5: `import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';`
- Line 160: `const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');`
- Line 181: `const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');` (in `closeStdin`)

**Changes:**

Line 5 -- change import:
```typescript
import { IPC_BASE_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
```

Lines 160, 181 -- change `inputDir` computation (both `sendMessage` and `closeStdin`):
```typescript
    const inputDir = path.join(IPC_BASE_DIR, state.groupFolder, 'input');
```

---

### 9. `src/index.ts` (lines 1-530)

**Current state (HEAD):**
- Line 30: `initDatabase,` in imports from `./db.js`
- Line 448-450: `async function main()` calls `ensureContainerSystemRunning()` then `initDatabase()`

**Changes:**

Add import:
```typescript
import { migrateStateIfNeeded } from './migrate-state.js';
```

Lines 448-451 -- insert migration before database init:
```typescript
async function main(): Promise<void> {
  ensureContainerSystemRunning();
  migrateStateIfNeeded();
  initDatabase();
```

No other changes to `src/index.ts`.

---

### 10. `src/mount-security.ts`

**Current state (HEAD):**
- Line 13: `import { MOUNT_ALLOWLIST_PATH } from './config.js';`
- Docstring references `~/.config/nanoclaw/mount-allowlist.json`

**No code changes needed.** The `MOUNT_ALLOWLIST_PATH` import is already from config and the value will change automatically when config changes. The docstring already says `~/.config/nanoclaw/`.

---

### 11. `setup/service.ts` (lines 1-360)

**Current state (HEAD):**
- Line 52: `fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });`
- Line 109: `<string>${projectRoot}/logs/nanoclaw.log</string>` (launchd plist)
- Line 111: `<string>${projectRoot}/logs/nanoclaw.error.log</string>` (launchd plist)
- Line 248: `StandardOutput=append:${projectRoot}/logs/nanoclaw.log` (systemd)
- Line 249: `StandardError=append:${projectRoot}/logs/nanoclaw.error.log` (systemd)
- Lines 339-340: nohup wrapper log paths
- Line 344: nohup wrapper log tail path

**Changes:**

Add import from config:
```typescript
import { LOGS_DIR } from '../src/config.js';
```

Line 52 -- change mkdirSync:
```typescript
  fs.mkdirSync(LOGS_DIR, { recursive: true });
```

Lines 109, 111 -- change launchd plist paths:
```typescript
    <string>${LOGS_DIR}/nanoclaw.log</string>
    ...
    <string>${LOGS_DIR}/nanoclaw.error.log</string>
```

Lines 248-249 -- change systemd unit paths:
```typescript
StandardOutput=append:${LOGS_DIR}/nanoclaw.log
StandardError=append:${LOGS_DIR}/nanoclaw.error.log
```

Lines 339-340, 344 -- change nohup wrapper paths:
```typescript
    `  >> ${JSON.stringify(LOGS_DIR + '/nanoclaw.log')} \\`,
    `  2>> ${JSON.stringify(LOGS_DIR + '/nanoclaw.error.log')} &`,
    ...
    `echo "Logs: tail -f ${LOGS_DIR}/nanoclaw.log"`,
```

---

### 12. `setup/whatsapp-auth.ts` (lines 1-340)

**Current state (HEAD):**
- No config imports. All paths computed from `projectRoot`:
  - Line 97: `path.join(projectRoot, 'store', 'auth', 'creds.json')`
  - Line 129: `path.join(projectRoot, 'store', 'auth-status.txt')`
  - Line 130: `path.join(projectRoot, 'store', 'qr-data.txt')`
  - Line 162: `path.join(projectRoot, 'store', 'auth')` (rmSync)
  - Line 252: `path.join(projectRoot, 'store', 'qr-auth.html')`
  - Line 337: `path.join(projectRoot, 'store', 'qr-auth.html')`

**Changes:**

Add import:
```typescript
import { AUTH_DIR, STATE_ROOT } from '../src/config.js';
```

Replace all `projectRoot`-based store paths:

| Line | Current | New |
|------|---------|-----|
| 97 | `path.join(projectRoot, 'store', 'auth', 'creds.json')` | `path.join(AUTH_DIR, 'creds.json')` |
| 129 | `path.join(projectRoot, 'store', 'auth-status.txt')` | `path.join(STATE_ROOT, 'auth-status.txt')` |
| 130 | `path.join(projectRoot, 'store', 'qr-data.txt')` | `path.join(STATE_ROOT, 'qr-data.txt')` |
| 162 | `path.join(projectRoot, 'store', 'auth')` | `AUTH_DIR` |
| 252 | `path.join(projectRoot, 'store', 'qr-auth.html')` | `path.join(STATE_ROOT, 'qr-auth.html')` |
| 337 | `path.join(projectRoot, 'store', 'qr-auth.html')` | `path.join(STATE_ROOT, 'qr-auth.html')` |

---

### 13. `setup/environment.ts` (lines 1-90)

**Current state (HEAD):**
- Line 10: `import { STORE_DIR } from '../src/config.js';`
- Line 45: `const authDir = path.join(projectRoot, 'store', 'auth');`
- Line 50: `fs.existsSync(path.join(projectRoot, 'data', 'registered_groups.json'))`
- Line 54: `const dbPath = path.join(STORE_DIR, 'messages.db');`

**Changes:**

Line 10 -- change import:
```typescript
import { AUTH_DIR, DB_DIR } from '../src/config.js';
```

Line 45 -- replace auth check:
```typescript
  const hasAuth = fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
```

Line 50 -- keep legacy JSON check at old path (this is checking for the pre-SQLite file that still lives in the project root for installations that haven't run the JSON->SQLite migration):
```typescript
  if (fs.existsSync(path.join(projectRoot, 'data', 'registered_groups.json'))) {
```
No change needed here. This is a legacy detection path.

Line 54 -- change DB check:
```typescript
    const dbPath = path.join(DB_DIR, 'messages.db');
```

---

### 14. `setup/mounts.ts` (lines 1-100)

**Current state (HEAD):**
- Line 7: `import os from 'os';`
- Lines 28-30: locally computes `configDir` and `configFile` from `os.homedir()`
- Line 38: `fs.mkdirSync(configDir, { recursive: true });`
- No config imports

**Changes:**

Add import:
```typescript
import { MOUNT_ALLOWLIST_PATH, STATE_ROOT } from '../src/config.js';
```

Remove line 7 (`import os from 'os';`) if `os` is not used elsewhere in the file. Check: `isRoot` is imported from `./platform.js` (line 10), and `os.homedir()` is only used on line 28. After the change, `os` is no longer needed. Remove the import.

Lines 28-30 -- remove local path computation:
```typescript
  // Remove: const homeDir = os.homedir();
  // Remove: const configDir = path.join(homeDir, '.config', 'nanoclaw');
  // Remove: const configFile = path.join(configDir, 'mount-allowlist.json');
```

Line 38 -- change mkdirSync:
```typescript
  fs.mkdirSync(path.dirname(MOUNT_ALLOWLIST_PATH), { recursive: true });
```

All references to `configDir` become `path.dirname(MOUNT_ALLOWLIST_PATH)` or `STATE_ROOT` (they are equivalent when `STATE_ROOT` is `~/.config/nanoclaw/`).

All references to `configFile` become `MOUNT_ALLOWLIST_PATH`.

---

### 15. `setup/register.ts` (lines 1-130)

**Current state (HEAD):**
- Line 12: `import { STORE_DIR } from '../src/config.js';`
- Line 90: `const dbPath = path.join(STORE_DIR, 'messages.db');`

**Changes:**

Line 12 -- change import:
```typescript
import { DB_DIR } from '../src/config.js';
```

Line 90 -- change DB path:
```typescript
  const dbPath = path.join(DB_DIR, 'messages.db');
```

Add `fs.mkdirSync(DB_DIR, { recursive: true });` before opening the database (line 93), since `DB_DIR` may not exist for fresh installations.

Also line 83 -- remove the old `fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });` since the `data/` directory is no longer used.

---

### 16. `setup/groups.ts` (lines 1-130)

**Current state (HEAD):**
- Line 11: `import { STORE_DIR } from '../src/config.js';`
- Line 41: `const dbPath = path.join(STORE_DIR, 'messages.db');` (in `listGroups`)
- The inline sync script (lines ~60-95) hardcodes `path.join('store', 'messages.db')` and `path.join('store', 'auth')` because it runs as a separate node process via `execFileSync`.

**Changes:**

Line 11 -- change import:
```typescript
import { AUTH_DIR, DB_DIR } from '../src/config.js';
```

Line 41 -- change `listGroups` DB path:
```typescript
  const dbPath = path.join(DB_DIR, 'messages.db');
```

For the inline sync script (lines ~60-95): This is a string of JavaScript that gets passed to `node -e`. It cannot import from config because it runs as a standalone script. The paths in the inline script must either:
1. Be updated to the new hardcoded paths (`~/.config/nanoclaw/auth`, `~/.config/nanoclaw/db/messages.db`), OR
2. Accept the paths as arguments or environment variables.

**Decision:** Pass `AUTH_DIR` and `DB_DIR` values as arguments to the inline script. This keeps the source of truth in config.ts:

```typescript
const syncScript = `
  // ... existing imports ...
  const authDir = process.argv[2];
  const dbPath = process.argv[3];
  // ... rest uses authDir and dbPath ...
`;

const output = execFileSync(
  'node',
  ['--input-type=module', '-e', syncScript, AUTH_DIR, path.join(DB_DIR, 'messages.db')],
  { ... },
);
```

The `dbPath` at line 121 inside the `syncGroups` function (for counting groups) also needs updating:
```typescript
  const dbPath = path.join(DB_DIR, 'messages.db');
```

---

### 17. `setup/verify.ts` (lines 1-150)

**Current state (HEAD):**
- Line 14: `import { STORE_DIR } from '../src/config.js';`
- Line 109: `const authDir = path.join(projectRoot, 'store', 'auth');` -- hardcoded
- Line 116: `const dbPath = path.join(STORE_DIR, 'messages.db');`
- Line 134: `path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json')` -- hardcoded

**Changes:**

Line 14 -- change import:
```typescript
import { AUTH_DIR, DB_DIR, MOUNT_ALLOWLIST_PATH } from '../src/config.js';
```

Line 109 -- replace auth check:
```typescript
  let whatsappAuth = 'not_found';
  if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
    whatsappAuth = 'authenticated';
  }
```

Line 116 -- change DB check:
```typescript
  const dbPath = path.join(DB_DIR, 'messages.db');
```

Line 134 -- change mount allowlist check:
```typescript
  if (fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
    mountAllowlist = 'configured';
  }
```

With `MOUNT_ALLOWLIST_PATH` imported, `homeDir` and `os` may no longer be needed. Check: `homeDir` is also used on line 109 (removed above). If no other uses remain, remove the `os` import and `homeDir` variable.

---

### 18. `tools/chat.ts` (lines 1-170)

**Current state (HEAD):**
- Line 14: `const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');`
- Line 15: `const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');`
- Line 16: `const IPC_DIR = path.join(PROJECT_ROOT, 'data', 'ipc', 'main', 'messages');`

**Changes:**

Add import:
```typescript
import { DB_DIR, IPC_BASE_DIR } from '../src/config.js';
```

Lines 14-16 -- replace path constants:
```typescript
const DB_PATH = path.join(DB_DIR, 'messages.db');
const IPC_DIR = path.join(IPC_BASE_DIR, 'main', 'messages');
```

`PROJECT_ROOT` is no longer needed if only used for computing these two paths. Check: it is not used elsewhere in the file. Remove it.

---

## New Component: `src/migrate-state.ts`

### Purpose

Auto-migrates runtime state from old project-root locations to `STATE_ROOT` on first startup after the upgrade. Called from `src/index.ts` before `initDatabase()`.

### Interface

```typescript
/**
 * Migrate runtime state from project-root locations to STATE_ROOT.
 * Idempotent: skips if STATE_ROOT/db/messages.db already exists.
 * Cross-filesystem safe: uses copy+delete fallback when rename fails (EXDEV).
 */
export function migrateStateIfNeeded(): void;
```

### Migration Map

| Old Location | New Location | Type |
|---|---|---|
| `PROJECT_ROOT/store/auth/` | `STATE_ROOT/auth/` | directory |
| `PROJECT_ROOT/store/messages.db` | `STATE_ROOT/db/messages.db` | file |
| `PROJECT_ROOT/store/messages.db-shm` | `STATE_ROOT/db/messages.db-shm` | file (if exists) |
| `PROJECT_ROOT/store/messages.db-wal` | `STATE_ROOT/db/messages.db-wal` | file (if exists) |
| `PROJECT_ROOT/store/mount-allowlist.json` | `STATE_ROOT/mount-allowlist.json` | file |
| `PROJECT_ROOT/store/auth-status.txt` | `STATE_ROOT/auth-status.txt` | file (if exists) |
| `PROJECT_ROOT/store/qr-auth.html` | `STATE_ROOT/qr-auth.html` | file (if exists) |
| `PROJECT_ROOT/data/sessions/` | `STATE_ROOT/sessions/` | directory |
| `PROJECT_ROOT/data/ipc/` | `STATE_ROOT/ipc/` | directory |
| `PROJECT_ROOT/logs/` | `STATE_ROOT/logs/` | directory (service logs only) |

### Algorithm

```
function migrateStateIfNeeded():
  projectRoot = process.cwd()

  # Idempotency check: if DB already exists at new location, skip
  if exists(STATE_ROOT/db/messages.db):
    log.debug("State already migrated, skipping")
    return

  # Check if there's anything to migrate
  oldStoreDir = projectRoot/store
  oldDataDir  = projectRoot/data
  oldLogsDir  = projectRoot/logs

  if none of [oldStoreDir, oldDataDir, oldLogsDir] exist:
    log.debug("No legacy state found, skipping migration")
    return

  log.info("Migrating runtime state to STATE_ROOT")

  # Ensure target directories exist
  mkdirSync(STATE_ROOT/auth, recursive)
  mkdirSync(STATE_ROOT/db, recursive)
  mkdirSync(STATE_ROOT/sessions, recursive)
  mkdirSync(STATE_ROOT/ipc, recursive)
  mkdirSync(STATE_ROOT/logs, recursive)

  # Move directories (auth, sessions, ipc, logs)
  moveDir(oldStoreDir/auth, STATE_ROOT/auth)
  moveDir(oldDataDir/sessions, STATE_ROOT/sessions)
  moveDir(oldDataDir/ipc, STATE_ROOT/ipc)
  moveDir(oldLogsDir, STATE_ROOT/logs)

  # Move individual files (DB, allowlist, ephemeral files)
  moveFile(oldStoreDir/messages.db, STATE_ROOT/db/messages.db)
  moveFile(oldStoreDir/messages.db-shm, STATE_ROOT/db/messages.db-shm)
  moveFile(oldStoreDir/messages.db-wal, STATE_ROOT/db/messages.db-wal)
  moveFile(oldStoreDir/mount-allowlist.json, STATE_ROOT/mount-allowlist.json)
  moveFile(oldStoreDir/auth-status.txt, STATE_ROOT/auth-status.txt)
  moveFile(oldStoreDir/qr-auth.html, STATE_ROOT/qr-auth.html)

  # Cleanup empty old directories
  tryRmdir(oldStoreDir)   # rmdir fails if not empty, which is fine
  tryRmdir(oldDataDir)
  tryRmdir(oldLogsDir)

  log.info("Migration complete")
```

### Cross-Filesystem Move

The project root is often on Dropbox or another synced filesystem, while `~/.config/` is on the local disk. `fs.renameSync` will throw `EXDEV` for cross-device moves.

```typescript
function moveFile(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  try {
    fs.renameSync(src, dest);
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      // Cross-filesystem: copy then delete
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
  logger.info({ from: src, to: dest }, 'Migrated file');
}

function moveDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  try {
    fs.renameSync(src, dest);
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      // Cross-filesystem: recursive copy then remove
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
  logger.info({ from: src, to: dest }, 'Migrated directory');
}
```

### Special Case: mount-allowlist.json

The `mount-allowlist.json` may already exist at `~/.config/nanoclaw/mount-allowlist.json` (upstream already placed it there). If `STATE_ROOT` resolves to `~/.config/nanoclaw/` (the default), and the file already exists at `STATE_ROOT/mount-allowlist.json`, the `moveFile` call is a no-op (source == dest or source doesn't exist because it was already at the destination). If `XDG_CONFIG_HOME` is set to something else, the old file at `~/.config/nanoclaw/` should be left alone (it's the user's choice to use a different config home).

### Partial Migration Recovery

If migration is interrupted (power loss, crash), some files may be at the old location and some at the new. The idempotency check (`STATE_ROOT/db/messages.db` exists) would incorrectly skip. To handle this:

- The DB file is migrated last among critical files.
- Each `moveFile`/`moveDir` call is independent and idempotent (skips if source doesn't exist).
- On next startup, if the DB exists at the new location, migration is considered complete. Any remaining files at the old location are harmless (gitignored) and can be cleaned up manually.

---

## Data Flow: How Paths Flow Through the System

```
src/config.ts
  |
  +-- STATE_ROOT (computed from XDG_CONFIG_HOME or ~/.config)
  |     |
  |     +-- AUTH_DIR        --> src/channels/whatsapp.ts (auth state)
  |     |                   --> src/whatsapp-auth.ts (auth flow)
  |     |                   --> setup/whatsapp-auth.ts (setup auth)
  |     |                   --> setup/environment.ts (preflight check)
  |     |                   --> setup/verify.ts (verification)
  |     |
  |     +-- DB_DIR          --> src/db.ts (SQLite path)
  |     |                   --> src/container-runner.ts (main group mount)
  |     |                   --> setup/register.ts (write registration)
  |     |                   --> setup/groups.ts (list/sync groups)
  |     |                   --> setup/environment.ts (preflight check)
  |     |                   --> setup/verify.ts (verification)
  |     |                   --> tools/chat.ts (CLI tool)
  |     |
  |     +-- LOGS_DIR        --> setup/service.ts (plist/systemd/nohup paths)
  |     |
  |     +-- IPC_BASE_DIR    --> src/group-folder.ts (resolveGroupIpcPath)
  |     |                   --> src/ipc.ts (IPC watcher)
  |     |                   --> src/group-queue.ts (sendMessage/closeStdin)
  |     |                   --> tools/chat.ts (CLI tool)
  |     |
  |     +-- SESSIONS_DIR    --> src/container-runner.ts (session + agent-runner mounts)
  |     |
  |     +-- MOUNT_ALLOWLIST_PATH --> src/mount-security.ts (already)
  |                               --> setup/mounts.ts
  |                               --> setup/verify.ts
  |
  +-- GROUPS_DIR (unchanged, PROJECT_ROOT/groups/)
```

---

## Container Mount Changes

### Main group mounts (after change):

| Host Path | Container Path | Mode | Status |
|-----------|---------------|------|--------|
| `groups/main/` | `/workspace/group` | rw | unchanged |
| `PROJECT_ROOT/` | `/workspace/project` | ro | unchanged (but no store/data visible) |
| `DB_DIR/` | `/workspace/store` | **ro** | **NEW** |
| `SESSIONS_DIR/main/.claude/` | `/home/node/.claude` | rw | path changes (was DATA_DIR-based) |
| `IPC_BASE_DIR/main/` | `/workspace/ipc` | rw | path changes (was DATA_DIR-based) |
| `SESSIONS_DIR/main/agent-runner-src/` | `/app/src` | rw | path changes (was DATA_DIR-based) |

### Non-main group mounts (after change):

| Host Path | Container Path | Mode | Status |
|-----------|---------------|------|--------|
| `groups/{name}/` | `/workspace/group` | rw | unchanged |
| `groups/global/` | `/workspace/global` | ro | unchanged |
| `SESSIONS_DIR/{name}/.claude/` | `/home/node/.claude` | rw | path changes |
| `IPC_BASE_DIR/{name}/` | `/workspace/ipc` | rw | path changes |
| `SESSIONS_DIR/{name}/agent-runner-src/` | `/app/src` | rw | path changes |

No `/workspace/store` or `/workspace/project` mount for non-main groups. This is unchanged from current behavior (non-main groups never had project root access).

### Security improvement

After this change, `ls /workspace/project/store` inside the main group's container returns nothing (or the directory doesn't exist), because all runtime state has moved to `~/.config/nanoclaw/` which is not mounted at `/workspace/project`. The only state the main agent can see is:
- Its own group folder (rw)
- The project code (ro)
- The database (ro, at `/workspace/store`)
- Its own IPC namespace (rw)
- Its own session data (rw)

---

## Migration Strategy

### Timeline

1. **First startup after upgrade:** `migrateStateIfNeeded()` runs before `initDatabase()`. Moves all files from `store/`, `data/`, `logs/` to `STATE_ROOT`. Removes empty old directories.
2. **Subsequent startups:** Migration skips (idempotent check: DB exists at new location).
3. **Fresh installations:** No migration needed. All paths point to `STATE_ROOT` from the start.

### Running service during migration

The migration happens at the start of `main()` before any database or WhatsApp connections. There is no race condition since only one NanoClaw process runs at a time (enforced by launchd/systemd).

### Rollback

If the user needs to rollback to a pre-migration version:
1. Files are at `~/.config/nanoclaw/` -- they need to be moved back manually.
2. The old `store/`, `data/`, `logs/` directories are removed (or empty) after migration.
3. A helper script or documented manual steps would be needed.
4. This is an acceptable tradeoff since rollback is an exceptional case.

---

## Error Handling

### Cross-Filesystem Moves (EXDEV)

Covered in the migration module design above. `fs.renameSync` -> catch `EXDEV` -> `cpSync` + `rmSync`.

### Permission Issues

- `STATE_ROOT` (`~/.config/nanoclaw/`) is owned by the current user. If the user can write to the project root, they can write to `~/.config/`.
- If `~/.config/` doesn't exist, `mkdirSync(STATE_ROOT, { recursive: true })` creates it.
- If `~/.config/` is unwritable (unlikely for a normal user), migration fails with a clear error message and the process exits.

### Partial Migration Recovery

Covered in the migration module design above. The DB is moved last. Each step is independent and idempotent.

### SQLite WAL Files

SQLite WAL files (`messages.db-shm`, `messages.db-wal`) must be moved alongside the main DB file. If only the DB is moved and WAL files are left behind, SQLite will create new WAL files at the new location (no data loss, but the WAL data from the old location is lost). The migration moves all three files together.

Important: The database must not be open during migration. This is guaranteed because `migrateStateIfNeeded()` runs before `initDatabase()`.

---

## Testing Strategy

### 19. `src/container-runner.test.ts`

**Current state (HEAD):**
- Lines 18-24: mock `./config.js` with `DATA_DIR: '/tmp/nanoclaw-test-data'` and `GROUPS_DIR: '/tmp/nanoclaw-test-groups'`

**Changes:**

Replace config mock:
```typescript
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DB_DIR: '/tmp/nanoclaw-test-state/db',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  IPC_BASE_DIR: '/tmp/nanoclaw-test-state/ipc',
  SESSIONS_DIR: '/tmp/nanoclaw-test-state/sessions',
  TIMEZONE: 'America/Los_Angeles',
}));
```

Remove `DATA_DIR` from mock. Add `DB_DIR`, `IPC_BASE_DIR`, `SESSIONS_DIR`.

No test logic changes needed -- the tests mock spawn and don't actually check mount paths. The mock just needs to provide the right exports so the module loads.

### 20. `src/group-queue.test.ts`

**Current state (HEAD):**
- Lines 5-8: mock `./config.js` with `DATA_DIR: '/tmp/nanoclaw-test-data'`

**Changes:**

Replace config mock:
```typescript
vi.mock('./config.js', () => ({
  IPC_BASE_DIR: '/tmp/nanoclaw-test-state/ipc',
  MAX_CONCURRENT_CONTAINERS: 2,
}));
```

Remove `DATA_DIR`, add `IPC_BASE_DIR`. The tests use `fs.writeFileSync` mock calls and check for `_close` file writes. The path in the mock affects what paths are constructed, but since `fs` is also mocked, the tests just verify the right calls happen.

### 21. `setup/register.test.ts`

**Current state (HEAD):**
- Tests use in-memory SQLite directly, not imports from config. The tests verify parameterized SQL behavior and file templating.

**No changes needed.** These tests don't import `STORE_DIR` or use any path constants from config. They create their own in-memory databases.

### 22. `setup/service.test.ts`

**Current state (HEAD):**
- Tests use inline helper functions (`generatePlist`, `generateSystemdUnit`) that replicate the generation logic. They verify string content of generated configs.

**Changes:**

The test helpers currently hardcode `${projectRoot}/logs/nanoclaw.log` patterns. After the change, the real code uses `${LOGS_DIR}/nanoclaw.log`. The test helpers need to be updated to match:

```typescript
function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  logsDir: string,   // NEW parameter
): string {
  // ... use ${logsDir}/nanoclaw.log instead of ${projectRoot}/logs/nanoclaw.log
```

Or simpler: since the tests just verify string content, update the expected strings to use the new log path format. The tests should verify that log paths point to `LOGS_DIR`, not `projectRoot/logs/`.

### New: `src/migrate-state.test.ts`

A new test file for the migration module. Key test cases:

1. **Skip when already migrated:** DB exists at `STATE_ROOT/db/messages.db` -> no-op
2. **Skip when no legacy state:** Neither `store/` nor `data/` nor `logs/` exist -> no-op
3. **Full migration:** All old directories exist -> files moved to new locations, old directories removed
4. **Cross-filesystem fallback:** `renameSync` throws `EXDEV` -> `copyFileSync` + `unlinkSync` used
5. **Partial migration:** Only some old directories exist -> migrates what's there, skips what's missing
6. **mount-allowlist already at destination:** File exists at `STATE_ROOT/` already -> no duplicate move

Tests should use a temp directory for both `PROJECT_ROOT` and `STATE_ROOT` to avoid affecting the real filesystem.

---

## Documentation Changes

### New: `docs/ARCHITECTURE.md`

Three-part system documentation:
- **Setup System** (`setup/`): one-time scripts, writes to `STATE_ROOT`
- **Host Process** (`src/`): long-running service, reads/writes `STATE_ROOT`
- **Agent Code** (`container/`, `groups/`): runs in containers, isolated from host
- Runtime state directory layout with purpose annotations
- Container mount table for main and non-main groups

### Update: `docs/SECURITY.md`

- Session isolation: `data/sessions/` -> `~/.config/nanoclaw/sessions/`
- Credential storage: `store/auth/` -> `~/.config/nanoclaw/auth/`
- New: project root mount no longer exposes runtime state

### Update: `docs/SPEC.md`

- Folder Structure diagram
- Configuration section code sample
- Credential Storage table
- Troubleshooting paths

### Update: `docs/DEBUG_CHECKLIST.md`

| Old Path | New Path |
|----------|----------|
| `logs/nanoclaw.log` | `~/.config/nanoclaw/logs/nanoclaw.log` |
| `sqlite3 store/messages.db` | `sqlite3 ~/.config/nanoclaw/db/messages.db` |
| `store/auth/` | `~/.config/nanoclaw/auth/` |
| `data/sessions/` | `~/.config/nanoclaw/sessions/` |

### Update: `CLAUDE.md` (project root)

- Add reference to `docs/ARCHITECTURE.md`
- Update Key Files table with state location note

### Update: `.claude/skills/setup/SKILL.md`

- Replace `store/auth/` -> `~/.config/nanoclaw/auth/`
- Replace `./store/auth/creds.json` -> config-derived paths

### Update: `.claude/skills/debug/SKILL.md`

- Replace `store/messages.db` -> `~/.config/nanoclaw/db/messages.db`
- Replace `data/sessions/` -> `~/.config/nanoclaw/sessions/`

### Update: `groups/main/CLAUDE.md`

- Replace `/workspace/project/store/messages.db` -> `/workspace/store/messages.db`
- Document the new `/workspace/store` mount (read-only DB access)
- Remove references to `/workspace/project/data/registered_groups.json`

### Update: `.gitignore`

Keep rules but update comments:
```gitignore
# Legacy locations -- runtime state now lives in ~/.config/nanoclaw/
store/
data/
logs/
```

---

## File Change Summary

| File | Change Type | Key Changes |
|------|------------|-------------|
| `src/config.ts` | modify | Add STATE_ROOT hierarchy, remove STORE_DIR/DATA_DIR/HOME_DIR |
| `src/migrate-state.ts` | **new** | Auto-migration module |
| `src/db.ts` | modify | Import DB_DIR, inline legacy DATA_DIR path |
| `src/channels/whatsapp.ts` | modify | Import AUTH_DIR instead of STORE_DIR |
| `src/whatsapp-auth.ts` | modify | Import from config instead of hardcoded paths |
| `src/container-runner.ts` | modify | Import SESSIONS_DIR/DB_DIR, add main DB mount |
| `src/group-folder.ts` | modify | Import IPC_BASE_DIR instead of DATA_DIR |
| `src/ipc.ts` | modify | Import IPC_BASE_DIR instead of DATA_DIR |
| `src/group-queue.ts` | modify | Import IPC_BASE_DIR instead of DATA_DIR |
| `src/index.ts` | modify | Call migrateStateIfNeeded() before initDatabase() |
| `setup/service.ts` | modify | Import LOGS_DIR, update all log path references |
| `setup/whatsapp-auth.ts` | modify | Import AUTH_DIR/STATE_ROOT, replace store/ paths |
| `setup/environment.ts` | modify | Import AUTH_DIR/DB_DIR instead of STORE_DIR |
| `setup/mounts.ts` | modify | Import MOUNT_ALLOWLIST_PATH/STATE_ROOT, remove os |
| `setup/register.ts` | modify | Import DB_DIR instead of STORE_DIR |
| `setup/groups.ts` | modify | Import DB_DIR/AUTH_DIR, pass paths to inline script |
| `setup/verify.ts` | modify | Import AUTH_DIR/DB_DIR/MOUNT_ALLOWLIST_PATH |
| `tools/chat.ts` | modify | Import DB_DIR/IPC_BASE_DIR from config |
| `src/container-runner.test.ts` | modify | Update config mock exports |
| `src/group-queue.test.ts` | modify | Update config mock exports |
| `setup/service.test.ts` | modify | Update log path expectations |
| `src/migrate-state.test.ts` | **new** | Migration module tests |
