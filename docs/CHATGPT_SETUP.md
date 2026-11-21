# Connecting ChatGPT to the Home bridge

Ten minutes, once. The GPT then runs real actions on the phone and can hand build work to the coding agent.

## 1. Create the action

ChatGPT -> **Explore GPTs -> Create** -> **Configure** -> **Actions** -> **Create new action**.

- **Import from URL:** `https://home-bridge-qn2hnd-preview.freebuff.site/openapi.json` (or paste the contents of `bridge/openapi.json`; both are version 1.1.0).
- **Authentication:** *None*. The pairing code travels as a normal parameter.

Nine operations arrive: `sendToPhone`, `phoneState`, `handTaskToAgent`, `replyToChat`, `readAgentReplies`, `pendingTasks`, `uploadSharedFile`, `listSharedFiles`, `readSharedFile`.

## 2. Instructions

Paste into the GPT's **Instructions** box, filling in the code:

```
You can control the user's Android launcher through the "Home Bridge" action.
The pairing code is CODE. Always pass it as `code`.

Phone control: use sendToPhone with action=status to read the phone, page to switch a tab
(home|mail|ai|apps|money|ent|control), app with a partial app name, torch on/off, clear to
reset unread counters, remote with "key|device name", url with an https link. Then use
phoneState to read what happened. Never claim an action worked until phoneState shows its
output; the phone only polls while the launcher is on screen.

Handing work to the coding agent ("buff:"):
1. Rewrite the request as one precise task sentence.
2. Call handTaskToAgent with that text and source "chatgpt".
3. Say it is queued. Never say it is built.
4. When asked whether it is done, call readAgentReplies and report the newest reply,
   including any APK link. Use pendingTasks only to check nothing was lost.

Files: listSharedFiles / readSharedFile hold the complete source tree (paths like
app/src/main/java/com/jarvis/launcher/MainActivity.kt) plus specs. The GitHub repo is
kushxwookiex420/home-launcher, branch main; a commit starting "buff:" is a finished change.

Never invent files, versions or links. If something is missing, say so.
```

## 3. Try it

- "check my phone" -> `sendToPhone status`, then `phoneState`.
- "open the AWS console" -> `sendToPhone url`.
- "buff: add a stopwatch to CONTROL" -> queued note; ask "did buff finish" later.

## 4. Keep the code private

The pairing code is the only credential. Keep the GPT **private** (or "anyone with a link" only). A public GPT with the code in its instructions lets strangers switch pages and fire `remote` keys on your TV. To revoke, unpair the phone in the launcher and pair again - the old code stops working immediately.

## Endpoints

| Endpoint | Operation | Use |
|---|---|---|
| `POST /send` | `sendToPhone` | queue an action |
| `GET /state` | `phoneState` | what the phone reported |
| `POST /note` | `handTaskToAgent` | task for the agent |
| `GET /notes` | `pendingTasks` | unacknowledged notes |
| `POST /reply` | `replyToChat` | agent writes the result |
| `GET /replies` | `readAgentReplies` | read results |
| `POST /files` / `GET /files` / `GET /file` | `uploadSharedFile` / `listSharedFiles` / `readSharedFile` | shared folder, 200k chars max |
