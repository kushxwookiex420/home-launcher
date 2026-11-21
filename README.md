# Home — an Android launcher with a remote brain

A single-activity Android launcher (`com.jarvis.launcher`, label **Home**) plus a small Cloudflare Worker that lets an outside assistant drive the phone and hand build tasks to a coding agent.

Built for a Samsung Galaxy S26 Ultra, sideloaded as a debug APK.

## What the launcher does

| Area | Behaviour |
|---|---|
| Tabs | HOME · EMAIL · AI · APPS · MONEY · ENT · CONTROL (7 tabs, mono 7sp labels) |
| HOME | Pulse ring with unread arcs (mail/calls/text), COMMS gauges, typed briefing line, command line, pinned app grid |
| Page locks | Per-page 3x3 pattern; salted SHA-256 in `LockStore`; relocks on leaving the page |
| Admin phrase | `wie gehts` unlocks every page until the screen turns off, and switches the command line into app search |
| Notifications | `NotificationListenerService` counts unread by bucket, seeded on connect; tap the COMMS panel to clear |
| Widget | `CounterWidget` shows the four counts; placeable on home screen and lock screen |
| CONTROL | Compact system shortcuts + a Wi-Fi universal remote (Samsung Tizen + Roku), multiple saved devices |
| Command line | Verbs (`torch`, `wifi`, `remote`, `m`, `p`, `s`, `o`, `pay`, `g`, `f`, `b`, `bridge`, `brain`, `clear`), app names, `gpt …` hand-off, optional AI |

## Repo map

```
app/src/main/java/com/jarvis/launcher/
  MainActivity.kt      the whole UI: pager, pages, locks, command line, bridge polling, AI routing
  PulseRingView.kt     custom view: three unread arcs, radar sweep, ambient dashes
  CounterWidget.kt     app widget provider for the unread counters
  NotifListener.kt     notification listener service
  NotifCounts.kt       unread buckets, persistence, watchers, widget refresh
  LockStore.kt         per-page salted pattern hashes
  PaneStore.kt         pinned apps / URLs per panel
  DeviceStore.kt       saved TV remotes (id, name, kind, host, token)
  TvRemote.kt          Samsung Tizen websocket remote
  RokuRemote.kt        Roku ECP HTTP remote
  BridgeClient.kt      polls the relay for commands, reports results
  AiClient.kt          OpenAI-compatible client for the optional in-app AI
  Launcher.kt          intent helpers (open url, settings, app info, uninstall)
  AppRepository.kt     installed app list
  HomeStore.kt         pinned home apps
  HomeAdapter.kt / DrawerAdapter.kt   two RecyclerView adapters
  PatternLockView.kt   3x3 pad

app/src/main/res/      dark galaxy theme, cyan #4FE3E0 / violet #A97BFF, mono type
bridge/                the relay worker (Cloudflare Workers + D1)
```

## Build

```bash
export JAVA_HOME=<jdk17>
export ANDROID_HOME=<android-sdk>
./gradlew :app:assembleDebug :app:testDebugUnitTest
# APK: app/build/outputs/apk/debug/app-debug.apk
```

`StartupTest` (Robolectric) inflates the activity and catches layout regressions. Keep it green.

---

## The relay

A Worker with a D1 queue. It never executes anything itself — the phone decides, against its own whitelist in `MainActivity.runBridgeCommand`.

Live schema: `https://home-bridge-qn2hnd-preview.freebuff.site/openapi.json` (API 1.2.0).
Endpoint reference: [`docs/API.md`](docs/API.md). Tests: `node bridge/test/run.mjs`.

| Endpoint | Purpose |
|---|---|
| `POST /bridge` | phone registers, gets `{id, code}` |
| `POST /poll` | phone asks for the next command |
| `POST /result` | phone reports what it did |
| `POST /send` | queue an action: `status`, `page`, `app`, `torch`, `clear`, `remote`, `url` |
| `GET /state` | recent commands and their output |
| `POST /note` / `GET /notes` / `GET /tasks` | hand a task to the coding agent, list it, read its status |
| `POST /reply` / `GET /replies` | agent writes the result back, linked to the task, with artifacts |
| `POST /files` · `GET /files` · `GET /file` | shared folder, text or base64, ≤200k chars, path-checked |

Every endpoint except `/health`, `/openapi.json` and the phone's `/bridge` `/poll` `/result`
requires the pairing code (body, query or `Authorization: Bearer`) and answers `401` without it.

Pairing: the phone shows a 6-character code. It is **never stored in this repo** — it is the
only credential. Treat it like a password.

## BUFF PROTOCOL (for an assistant using this repo)

If the user says **"talk to buff"**, **"ask buff"**, or **"buff: …"**:

1. Turn the request into one precise task sentence.
2. `handTaskToAgent` (`POST /note`) with `{code, text, source: "chatgpt"}`; keep the `taskId`.
3. Tell the user it is queued. **Never claim it is built.**
4. When the user asks whether Buff finished, call `taskStatus` (`GET /tasks`) for
   queued/working/done, then `readAgentReplies` (`GET /replies?taskId=…`) and report the
   reply text plus every artifact link.

Reading the project: browse this repo for code, and `readSharedFile` for specs and patches the
agent leaves behind. The agent commits here, so a commit message beginning `buff:` is a
finished change.

What the agent can do: edit this project, build APKs, deploy the relay, upload files to the
shared folder. What it cannot do: act while no chat turn is open, send messages or place calls
on the phone, or read private content.
