# Plan: Image & Media Attachment Support

**Status**: BLOCKED — waiting for upstream [PR#500](https://github.com/qwibitai/nanoclaw/pull/500) (pluggable multi-channel architecture) to merge. That PR restructures `src/types.ts`, `src/index.ts`, `src/ipc.ts`, and all channel files — the same files this plan modifies. Merge after PR#500 lands and we `/update`.

## Context

F3 can create files (charts, documents, images) inside its container at `/workspace/group/`, which maps to `groups/{name}/` on the host. But the only way to send output is `channel.sendMessage(jid, text)` — text only. When F3 generates a BTC candlestick chart as PNG, it can't attach it to the chat message. All three channel APIs (WhatsApp/Baileys, Slack, Gmail) support media natively.

This plan adds media attachment support through two mechanisms:
1. **Convention-based**: Agent text containing `[attachment:/workspace/group/file.png]` markers get extracted, files read from host, sent as media
2. **MCP tool**: Extend `send_message` with a `media` parameter for programmatic file sending

---

## Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `MediaAttachment` type, add optional `sendMedia?` to Channel |
| `src/media.ts` | **NEW** — extraction, path resolution, security validation |
| `src/media.test.ts` | **NEW** — unit tests for media module |
| `src/channels/whatsapp.ts` | Add `sendMedia` using Baileys `{ image: Buffer }` etc. |
| `src/channels/slack.ts` | Add `sendMedia` using `files.uploadV2` |
| `src/channels/gmail.ts` | Add `sendMedia` using MIME multipart |
| `src/index.ts` | Integrate `extractAttachments` into streaming output + scheduler callbacks |
| `src/ipc.ts` | Extend IPC message handler for `media` field |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Extend `send_message` tool with `media` param |

---

## Step 1: Types (`src/types.ts`)

Add to existing types:

```typescript
export interface MediaAttachment {
  buffer: Buffer;
  mimetype: string;
  filename: string;
}
```

Add optional method to `Channel` interface:

```typescript
sendMedia?(jid: string, media: MediaAttachment, caption?: string): Promise<void>;
```

Optional so channels that don't implement it are backward-compatible.

---

## Step 2: Media Module (`src/media.ts` — new)

Core utility with three exports:

- **`containerPathToHost(containerPath, groupFolder)`** — converts `/workspace/group/file.png` to host path `groups/{folder}/file.png`. Returns null if path escapes group folder (security).
- **`extractAttachments(text, groupFolder)`** — regex-extracts `[attachment:...]` markers from text, reads files from host, returns `{ cleanText, attachments: MediaAttachment[] }`.
- **`resolveMediaPaths(paths, groupFolder)`** — resolves an array of container paths to `MediaAttachment[]` (used by IPC handler).

Security: `path.resolve` + `startsWith` check ensures files stay within group folder. Reuse `resolveGroupFolderPath` from `src/group-folder.ts`.

Limits: 16MB max file size (WhatsApp cap). Missing files logged and skipped.

MIME detection: extension-based lookup (`.png` → `image/png`, etc.), fallback `application/octet-stream`.

---

## Step 3: Channel Implementations

### WhatsApp (`src/channels/whatsapp.ts`)
Baileys accepts `{ image: Buffer, caption }`, `{ video: Buffer, caption }`, `{ audio: Buffer, mimetype }`, `{ document: Buffer, fileName, mimetype }`. Route by `mimetype.startsWith('image/')` etc.

### Slack (`src/channels/slack.ts`)
Use `this.app.client.files.uploadV2({ channel_id, file: Buffer, filename, initial_comment })`.

### Gmail (`src/channels/gmail.ts`)
Build MIME multipart/mixed message with base64 attachment. Only works for reply context (needs thread metadata).

---

## Step 4: Orchestrator Integration (`src/index.ts`)

Two call sites to modify:

**Streaming output callback** (~line 192): After stripping `<internal>` tags, run `extractAttachments(text, group.folder)`. Send `cleanText` via `sendMessage`, then each attachment via `sendMedia`.

**Scheduler sendMessage** (~line 502): Same pattern — extract attachments before sending.

---

## Step 5: IPC Integration (`src/ipc.ts`)

Extend the IPC message handler to accept `data.media` (array of container paths). Resolve via `resolveMediaPaths()`, send via `channel.sendMedia`.

Update `IpcDeps.sendMessage` signature to accept optional media paths + group folder.

---

## Step 6: MCP Tool Extension (`container/agent-runner/src/ipc-mcp-stdio.ts`)

Extend `send_message` tool:
- Add `media: z.array(z.string()).optional()` — array of `/workspace/group/` file paths
- Make `text` optional (media-only messages are valid)
- Validate paths start with `/workspace/group/` and contain no `..`
- Validate files exist before writing IPC JSON
- Include `media` field in the IPC JSON payload

---

## Step 7: Container Rebuild + Tests

- `src/media.test.ts`: Test path resolution, security (traversal rejection), extraction with markers, missing files, oversized files
- Rebuild container: `./container/build.sh`
- Clear stale agent-runner: `rm -r data/sessions/*/agent-runner-src`

---

## Verification

1. `npm test` — all tests pass including new media tests
2. `npm run build` — clean compile
3. Deploy and ask F3 in Slack: "Create a simple test image and send it to me"
4. F3 should use `send_message` with `media: ["/workspace/group/test.png"]`
5. Image should appear in Slack channel
6. Repeat via WhatsApp — image should appear in WhatsApp group
7. Test convention path: F3 outputs text with `[attachment:/workspace/group/file.png]` — marker stripped, file sent
