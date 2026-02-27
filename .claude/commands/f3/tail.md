---
description: Watch the main group chat for new messages in real-time
allowed-tools: Bash
argument-hint: [--poll N]
---

Watch the main group chat for new messages. Shows last 5 messages for context, then streams new messages as they arrive. Default poll interval is 2 seconds.

Run this command:

```bash
npx tsx tools/chat.ts tail $1
```

This runs indefinitely until interrupted.
