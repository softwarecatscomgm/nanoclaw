---
description: Send a message directly to WhatsApp (bypasses agent processing)
allowed-tools: Bash
argument-hint: <message>
---

Send a message directly to the WhatsApp group via IPC. This bypasses the agent entirely — the message goes straight to WhatsApp as-is. The user's full message is: $ARGUMENTS

Run this exact command, passing the ENTIRE user message as a single quoted argument:

```
npx tsx tools/chat.ts raw '<entire user message here>'
```
