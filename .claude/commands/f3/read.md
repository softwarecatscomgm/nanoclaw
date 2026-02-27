---
description: Read recent messages from the main group chat
allowed-tools: Bash
argument-hint: [--limit N]
---

Read recent messages from the main group. Default limit is 20 messages.

If the user provides a number as the argument, use it as the limit. Otherwise use the default.

Run this command:

```bash
npx tsx tools/chat.ts read $1
```
