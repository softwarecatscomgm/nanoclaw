"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISCORD_ONLY = exports.DISCORD_BOT_TOKEN = exports.TIMEZONE = exports.TRIGGER_PATTERN = exports.MAX_CONCURRENT_CONTAINERS = exports.IDLE_TIMEOUT = exports.IPC_POLL_INTERVAL = exports.CONTAINER_MAX_OUTPUT_SIZE = exports.CONTAINER_TIMEOUT = exports.CONTAINER_IMAGE = exports.MAIN_GROUP_FOLDER = exports.DATA_DIR = exports.GROUPS_DIR = exports.STORE_DIR = exports.MOUNT_ALLOWLIST_PATH = exports.SCHEDULER_POLL_INTERVAL = exports.POLL_INTERVAL = exports.ASSISTANT_HAS_OWN_NUMBER = exports.ASSISTANT_NAME = void 0;
var os_1 = require("os");
var path_1 = require("path");
var env_js_1 = require("./env.js");
// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
var envConfig = (0, env_js_1.readEnvFile)([
    'ASSISTANT_NAME',
    'ASSISTANT_HAS_OWN_NUMBER',
    'DISCORD_BOT_TOKEN',
    'DISCORD_ONLY',
]);
exports.ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
exports.ASSISTANT_HAS_OWN_NUMBER = (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
exports.POLL_INTERVAL = 2000;
exports.SCHEDULER_POLL_INTERVAL = 60000;
// Absolute paths needed for container mounts
var PROJECT_ROOT = process.cwd();
var HOME_DIR = process.env.HOME || os_1.default.homedir();
// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
exports.MOUNT_ALLOWLIST_PATH = path_1.default.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
exports.STORE_DIR = path_1.default.resolve(PROJECT_ROOT, 'store');
exports.GROUPS_DIR = path_1.default.resolve(PROJECT_ROOT, 'groups');
exports.DATA_DIR = path_1.default.resolve(PROJECT_ROOT, 'data');
exports.MAIN_GROUP_FOLDER = 'main';
exports.CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
exports.CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
exports.CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
exports.IPC_POLL_INTERVAL = 1000;
exports.IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
exports.MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
exports.TRIGGER_PATTERN = new RegExp("^@".concat(escapeRegex(exports.ASSISTANT_NAME), "\\b"), 'i');
// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
exports.TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
// Discord configuration
exports.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || envConfig.DISCORD_BOT_TOKEN || '';
exports.DISCORD_ONLY = (process.env.DISCORD_ONLY || envConfig.DISCORD_ONLY) === 'true';
