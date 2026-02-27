---
description: Send a message to F3 (fire and forget, no wait for reply)
allowed-tools: Bash
argument-hint: <message>
---

Inject a user message into the main group. F3 will process it on the next poll cycle but we don't wait for the reply. The user's full message is: $ARGUMENTS

Run this exact command, passing the ENTIRE user message as a single quoted argument:

```
npx tsx tools/chat.ts send '<entire user message here>'
```
