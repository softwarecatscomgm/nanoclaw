---
description: Ask F3 a question and wait for the reply
allowed-tools: Bash
argument-hint: <message>
---

Send a message to F3 via the CLI chat tool and wait for the response. The user's full message is: $ARGUMENTS

Run this exact command, passing the ENTIRE user message as a single quoted argument:

```
npx tsx tools/chat.ts ask '<entire user message here>' --timeout 120
```

Display F3's response to the user. Strip any system-reminder tags from the output.
