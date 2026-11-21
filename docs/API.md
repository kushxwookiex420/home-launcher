# Home Bridge API (v1.2.0)

Base URL: `https://home-bridge-qn2hnd-preview.freebuff.site`

The relay is a Cloudflare Worker with a D1 database. It queues work; it never executes anything
on the phone. The launcher polls, decides against its own whitelist, and reports back.

## Authentication

Every endpoint except `/health`, `/openapi.json` and the phone's own `/bridge`, `/poll`,
`/result` needs the **pairing code** shown on the phone:

- `code` in the JSON body (POST), or
- `?code=XXXXXX` in the query string (GET), or
- `Authorization: Bearer XXXXXX`

Codes are six characters from `A-Z0-9`, compared in constant time. Missing, malformed or
unknown credentials get `401`. Codes are never stored in the repository, written to logs, or
returned by any endpoint.

## Errors

```json
{ "ok": false, "error": "unknown action (allowed: status, page, app, ...)", "code": "bad_request" }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | invalid JSON, missing field, bad path, unknown action or task |
| 401 | `unauthorized` | missing, malformed or unknown pairing code |
| 404 | `not_found` | unknown route, file or phone |
| 413 | `too_large` | shared file above 200000 characters |
| 429 | `rate_limited` | 20 tasks, 60 replies, 60 uploads or 30 commands a minute |
| 500 | `internal` | unexpected error; the message is returned, never a stack trace |

## Tasks

### `POST /note` — `handTaskToAgent`

```json
{ "code": "ABC123", "text": "add a stopwatch to CONTROL", "title": "stopwatch", "source": "chatgpt" }
```

```json
{ "ok": true, "taskId": "9b1f...", "createdAt": 1763769600000, "iso": "2026-11-21T19:20:00.000Z" }
```

`text` is required, 4000 characters max. `source` defaults to `chatgpt`. Rate limit 20/minute.

### `GET /tasks` — `taskStatus`

Newest first. `status` is `queued` (nobody picked it up), `working` (the agent claimed it) or
`done` (a reply exists). Finished tasks carry `replyId` and `artifacts`.

```json
{ "ok": true, "count": 1, "tasks": [ { "id": "9b1f...", "text": "add a stopwatch...", "source": "chatgpt",
  "status": "done", "createdAt": 1763769600000, "iso": "2026-11-21T19:20:00.000Z",
  "replyId": "77ac...", "artifacts": ["https://files.catbox.moe/example.apk"] } ] }
```

### `GET /notes` — `pendingTasks`

Unacknowledged tasks only, oldest first. Same task shape, plus a `notes` alias for older
clients. `limit` 1-50.

## Replies

### `POST /reply` — `replyToChat` (agent only)

```json
{ "code": "ABC123", "text": "0.58 built, stopwatch added to CONTROL", "taskId": "9b1f...",
  "artifacts": ["https://files.catbox.moe/example.apk"] }
```

```json
{ "ok": true, "replyId": "77ac...", "taskId": "9b1f...", "createdAt": 1763769660000, "iso": "..." }
```

`text` 1-4000 characters. `taskId` must belong to the same device or the call is a `400`; a
valid `taskId` marks the task `done`. Up to 10 `artifacts`, each an `http(s)` link.

### `GET /replies` — `readAgentReplies`

Oldest first, so the newest reply is last. Parameters: `code`, `since` (epoch ms, exclusive),
`taskId`, `limit` (1-50, default 20).

```json
{ "ok": true, "count": 1, "serverTime": 1763769700000,
  "replies": [ { "id": "77ac...", "taskId": "9b1f...", "source": "freebuff",
    "text": "0.58 built...", "artifacts": ["https://.../example.apk"],
    "createdAt": 1763769660000, "iso": "2026-11-21T19:21:00.000Z" } ] }
```

Keep `serverTime` as the next `since` to avoid re-reading, or store the newest `createdAt`.

### `POST /notes/ack`

`{ "code": "ABC123", "ids": ["9b1f..."] }` claims those tasks; without `ids` it acknowledges
every queued task. The agent uses this so a task never runs twice.

## Shared folder

Relative paths with forward slashes, 1-200 characters: letters, numbers, `.`, `-`, `_`, `/`.
Refused: `..`, leading `/`, backslashes, empty segments, hidden files (`.gitignore`, `.env`),
and key material (`*.pem`, `*.key`, `*.keystore`, `*.jks`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`).

### `POST /files` — `uploadSharedFile`

```json
{ "code": "ABC123", "name": "docs/report.md", "content": "# report", "encoding": "text", "mime": "text/markdown" }
```

```json
{ "ok": true, "name": "docs/report.md", "bytes": 18, "sha256": "...", "updatedAt": 1763769700000 }
```

Base64 for binaries (`"encoding": "base64"`). Max 200000 characters (about 195 KB of text).
Re-uploading a name replaces it, so `sha256` is the way to tell versions apart.

### `GET /files` — `listSharedFiles`

Returns `{ ok, count, files: [ { name, mime, encoding, size, bytes, updatedAt, iso } ] }`.

### `GET /file` — `readSharedFile`

`?code=...&name=docs/report.md` returns `{ ok, name, mime, encoding, size, updatedAt, data }`.
Missing file is `404`, bad path is `400`.

## Phone actions

### `POST /send` — `sendToPhone`

| action | arg |
|---|---|
| `status` | none - battery, network, storage, unread counts |
| `page` | `home` / `mail` / `ai` / `apps` / `money` / `ent` / `control` |
| `app` | partial app name, 80 characters |
| `torch` | `on` / `off` |
| `clear` | none - resets unread counters |
| `remote` | `key|device name`, e.g. `home|Living Room TV` |
| `url` | an `https://` link |

```json
{ "ok": true, "id": "...", "action": "page", "arg": "control", "queuedAt": 1763769700000 }
```

Anything outside the table is a `400`. The phone re-validates every action in
`MainActivity.runBridgeCommand`, so the relay cannot widen what the device allows. Nothing here
reads private content, sends messages, places calls or runs shell.

### `GET /state` — `phoneState`

```json
{ "ok": true, "name": "phone", "online": true, "lastSeen": 1763769690000, "serverTime": 1763769700000,
  "commands": [ { "id": "...", "action": "page", "arg": "control", "status": "done",
    "output": "switched to CONTROL", "createdAt": 1763769680000, "iso": "..." } ] }
```

`online` is true when the phone polled in the last 45 seconds - the launcher only polls while it
is on screen. The last 10 commands are returned with their outputs.

## Phone endpoints (used by the APK, unchanged)

`POST /bridge` `{name}` -> `{id, code}` - `POST /poll` `{id, code}` -> `{command|null}` -
`POST /result` `{id, code, commandId, output}` -> `{ok}`

## Tests

```bash
node bridge/test/run.mjs     # 27 tests, node >= 22
```

The suite imports the worker and drives its `fetch` handler with a D1 stand-in built on
`node:sqlite` (`bridge/test/d1.mjs`). It covers authentication (missing/malformed/unknown/bearer),
task submission and validation, task status transitions, reply linking and artifacts, reply
filtering, shared-file upload/list/read, path-traversal and secret-file refusal, the size limit,
action whitelisting, polling/results, cross-device isolation, rate limiting, 404s and the
OpenAPI document.

Not covered by automation: the live Cloudflare D1 and the actual phone UI. Those are checked by
smoke requests against the deployed URL and by using the app.
