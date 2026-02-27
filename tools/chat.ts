/**
 * CLI chat utility — send messages via IPC, read messages from SQLite.
 *
 * Usage:
 *   npx tsx tools/chat.ts send "Hello from CLI"
 *   npx tsx tools/chat.ts read [--limit 20]
 *   npx tsx tools/chat.ts tail [--poll 2]
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const IPC_DIR = path.join(PROJECT_ROOT, 'data', 'ipc', 'main', 'messages');

function getMainJid(): string {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db
    .prepare('SELECT jid FROM registered_groups WHERE name = ?')
    .get('main') as { jid: string } | undefined;
  db.close();
  if (!row) {
    console.error('No main group registered. Run setup first.');
    process.exit(1);
  }
  return row.jid;
}

function send(text: string): void {
  const jid = getMainJid();
  const db = new Database(DB_PATH);
  const id = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, jid, 'cli@local', 'CLI', text, timestamp, 0, 0);
  db.close();
  console.log(`Injected as user message — F3 will pick it up on next poll cycle`);
}

function rawSend(text: string): void {
  const jid = getMainJid();
  fs.mkdirSync(IPC_DIR, { recursive: true });
  const filename = `cli-${Date.now()}.json`;
  const payload = { type: 'message', chatJid: jid, text };
  fs.writeFileSync(path.join(IPC_DIR, filename), JSON.stringify(payload));
  console.log(`Sent raw message to WhatsApp (no agent processing)`);
}

interface Message {
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

function read(limit: number): void {
  const jid = getMainJid();
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare(
      `SELECT sender_name, content, timestamp, is_from_me, is_bot_message
       FROM messages WHERE chat_jid = ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(jid, limit) as Message[];
  db.close();

  for (const row of rows.reverse()) {
    const tag = row.is_bot_message ? 'F3' : row.is_from_me ? 'You' : (row.sender_name || '?');
    const time = new Date(row.timestamp).toLocaleTimeString();
    // Strip duplicate name prefix from bot messages (e.g. "F3: Hello" → "Hello")
    const content = row.is_bot_message ? row.content.replace(/^\S+:\s*/, '') : row.content;
    console.log(`[${time}] ${tag}: ${content}`);
  }
}

function tail(pollSeconds: number): void {
  const jid = getMainJid();
  let lastTimestamp = new Date().toISOString();

  console.log('Watching for new messages... (Ctrl+C to stop)\n');
  read(5); // show last 5 for context

  setInterval(() => {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db
      .prepare(
        `SELECT sender_name, content, timestamp, is_from_me, is_bot_message
         FROM messages WHERE chat_jid = ? AND timestamp > ?
         ORDER BY timestamp ASC`,
      )
      .all(jid, lastTimestamp) as Message[];
    db.close();

    for (const row of rows) {
      const tag = row.is_bot_message ? 'F3' : row.is_from_me ? 'You' : (row.sender_name || '?');
      const time = new Date(row.timestamp).toLocaleTimeString();
      const content = row.is_bot_message ? row.content.replace(/^\S+:\s*/, '') : row.content;
      console.log(`[${time}] ${tag}: ${content}`);
      lastTimestamp = row.timestamp;
    }
  }, pollSeconds * 1000);
}

function ask(text: string, timeoutSeconds: number): void {
  const jid = getMainJid();
  const db = new Database(DB_PATH);
  const id = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();

  const prompt = `IMPORTANT: Your response MUST start with "> ${text}" on the first line, followed by a blank line, then your answer.\n\n${text}`;
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, jid, 'cli@local', 'CLI', prompt, timestamp, 0, 0);
  db.close();

  console.log(`You: ${text}`);

  const deadline = Date.now() + timeoutSeconds * 1000;
  const poll = setInterval(() => {
    const rdb = new Database(DB_PATH, { readonly: true });
    const row = rdb
      .prepare(
        `SELECT content, timestamp FROM messages
         WHERE chat_jid = ? AND timestamp > ? AND is_bot_message = 1
         ORDER BY timestamp ASC LIMIT 1`,
      )
      .get(jid, timestamp) as { content: string; timestamp: string } | undefined;
    rdb.close();

    if (row) {
      clearInterval(poll);
      const content = row.content.replace(/^\S+:\s*/, '');
      console.log(`F3: ${content}`);
      process.exit(0);
    }

    if (Date.now() > deadline) {
      clearInterval(poll);
      console.error('Timed out waiting for F3 response.');
      process.exit(1);
    }
  }, 1000);
}

// --- CLI ---
const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'send': {
    const text = rest.join(' ');
    if (!text) {
      console.error('Usage: npx tsx tools/chat.ts send "message"');
      process.exit(1);
    }
    send(text);
    break;
  }
  case 'read': {
    const limitIdx = rest.indexOf('--limit');
    const limit = limitIdx >= 0 ? parseInt(rest[limitIdx + 1], 10) : 20;
    read(limit);
    break;
  }
  case 'tail': {
    const pollIdx = rest.indexOf('--poll');
    const poll = pollIdx >= 0 ? parseInt(rest[pollIdx + 1], 10) : 2;
    tail(poll);
    break;
  }
  case 'ask': {
    const timeoutIdx = rest.indexOf('--timeout');
    const timeout = timeoutIdx >= 0 ? parseInt(rest[timeoutIdx + 1], 10) : 60;
    const askArgs = timeoutIdx >= 0
      ? rest.filter((_, i) => i !== timeoutIdx && i !== timeoutIdx + 1)
      : rest;
    const text = askArgs.join(' ');
    if (!text) {
      console.error('Usage: npx tsx tools/chat.ts ask "question"');
      process.exit(1);
    }
    ask(text, timeout);
    break;
  }
  case 'raw': {
    const text = rest.join(' ');
    if (!text) {
      console.error('Usage: npx tsx tools/chat.ts raw "message"');
      process.exit(1);
    }
    rawSend(text);
    break;
  }
  default:
    console.log('Usage:');
    console.log('  npx tsx tools/chat.ts ask "question"  — send and wait for F3 reply');
    console.log('  npx tsx tools/chat.ts send "Hello"    — inject as user message, F3 responds');
    console.log('  npx tsx tools/chat.ts raw "Hello"     — send directly to WhatsApp (no agent)');
    console.log('  npx tsx tools/chat.ts read [--limit N] — read recent messages');
    console.log('  npx tsx tools/chat.ts tail [--poll N]   — watch for new messages');
}
