# Connecting ChatGPT to the Home bridge

About ten minutes, once. After that the GPT can queue actions on the phone, hand build tasks to
the coding agent, and read the agent's answers and artifacts - without you copying replies.

API version **1.2.0**. Full endpoint reference: [`docs/API.md`](API.md).

## 1. Create the action

ChatGPT -> **Explore GPTs -> Create** -> **Configure** -> **Actions** -> **Create new action**.

- **Import from URL:** `https://home-bridge-qn2hnd-preview.freebuff.site/openapi.json`
  (or paste the JSON that URL returns; its source is `bridge/openapi.js`).
- **Authentication:** *None*. The schema declares the pairing code as a query `apiKey`, so the
  code travels as an ordinary `code` parameter. A `Bearer` header works too.

Eleven operations: `handTaskToAgent`, `taskStatus`, `pendingTasks`, `replyToChat`,
`readAgentReplies`, `uploadSharedFile`, `listSharedFiles`, `readSharedFile`, `sendToPhone`,
`phoneState`, `healthCheck`.

## 2. Instructions

Paste into the GPT's **Instructions** box, replacing `CODE` with the code shown on the phone:

```
The Home Bridge action talks to the user's Android launcher and to Buff, their coding agent.
Every call needs the pairing code CODE, passed as `code`.

Phone control
- sendToPhone: action=status reads the phone; page switches a tab (home|mail|ai|apps|money|ent|control);
  app with a partial name opens an app; torch on|off; clear resets unread counters;
  remote takes "key|device name"; url takes an https link.
- Read phoneState afterwards. The phone only polls while the launcher is on screen, so online:false
  means the action is still queued, not that it failed. Never say it worked until phoneState shows
  status "done" and an output.

Handing work to Buff
1. Turn the request into one precise task sentence.
2. Call handTaskToAgent with text, source "chatgpt" and a short title. Keep the returned taskId.
3. Say the task is queued with its id. Never say it is built.
4. When the user asks whether it is done, call taskStatus. queued = not picked up, working = Buff is
   on it, done = the answer exists. Then call readAgentReplies with that taskId and report the text
   plus every artifact link.
5. Use the serverTime from the reply as the next `since` so nothing is read twice.

Project files
- listSharedFiles shows the shared folder; readSharedFile returns one file's content. Paths look like
  app/src/main/java/com/jarvis/launcher/MainActivity.kt, docs/API.md, tests/smoke.txt.
- The GitHub repo kushxwookiex420/home-launcher (branch main) holds docs, config and the worker; a
  commit message starting "buff:" is a finished change.

Rules
- Never invent task ids, versions, file names or links. If a call returns 401, say the pairing code
  needs updating. If it returns 400, read the error text and fix the request once.
- Do not try actions outside the seven listed above; anything else is refused on purpose.
```

## 3. Try it

| Say | What happens |
|---|---|
| "check my phone" | `sendToPhone status`, then `phoneState` |
| "open the AWS console" | `sendToPhone url` |
| "buff: add a stopwatch to CONTROL" | task queued, `taskId` returned |
| "is buff done?" | `taskStatus`, then `readAgentReplies` |

## 4. Keep the code private

The pairing code is the only credential. Keep the GPT **private** or link-only: a public GPT with
the code in its instructions lets strangers switch pages and press `remote` keys on your TV.
Unpairing the phone in the launcher and pairing again revokes the old code immediately.

There is no rate-limit bypass and no way to widen the phone's action list from outside - the
relay validates, and the phone validates again in `MainActivity.runBridgeCommand`.

## 5. If the action reports errors

| Error | Fix |
|---|---|
| `401 unauthorized` | The code changed. Update it in the Instructions and try again. |
| `400 bad_request` | The request body is wrong; the message names the field. |
| `429 rate_limited` | 20 tasks, 60 replies/uploads or 30 phone commands a minute. Wait. |
| `404 not_found` | Wrong path name or unknown route. |
