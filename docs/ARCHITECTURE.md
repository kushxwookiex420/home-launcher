# Architecture

## Layers

```
MainActivity ──┬── pages (ViewPager, pre-inflated, never recycled)
               ├── locks (LockStore + PatternLockView overlay)
               ├── command line (verbs → apps → optional AI)
               ├── bridge poller (BridgeClient every 12 s while in front)
               └── telemetry readers (battery, network, storage, uptime)
```

## Pages and their keys

| # | Tab | Page view | Lock key | Notes |
|---|---|---|---|---|
| 0 | HOME | `page_home.xml` | `home` | ring, comms gauges, command line, pinned grid |
| 1 | EMAIL | `page_panes.xml` | `email` | 4 Gmail panels |
| 2 | AI | `page_panes.xml` | `apps` | 12 panels |
| 3 | APPS | `page_apps.xml` | `appsList` | all installed apps |
| 4 | MONEY | `page_panes.xml` | `money` | 8 panels |
| 5 | ENT | `page_panes.xml` | `ent` | 12 panels + free-service chips |
| 6 | CONTROL | `page_control.xml` | `control` | shortcuts + remote |

Lock keys are stable strings, not indices, so a tab can move without losing its pattern.

## Notification counting

`NotifListener` → `NotifCounts` (SharedPreferences string sets per bucket) → watchers → `renderNotifCard()` (gauges), `PulseRingView` (arcs) and `CounterWidget` (widget).

Buckets: `email`, `calls`, `messages`, `other`. Ongoing notifications are excluded by manifest meta-data. On first connect the listener folds in already-posted notifications (`resync`), so the counts are not zero until something new arrives.

## Command line

`runCommand(text)`:

1. lowercase, trim, clear the field
2. verb table (torch, wifi, remote, m, p, s, o, pay, g, f, b, bridge, brain, clear, wie gehts …)
3. otherwise `launchByCommand`: best app-name match launches immediately — no chooser dialog
4. otherwise the optional AI (`AiClient`) if a key is set, else a `NO MATCH` toast

After the admin phrase, a `TextWatcher` fills `commandResults` with up to six app matches (search mode). Screen-off clears both the unlock and the strip.

## Remote

`DeviceStore` keeps a JSON list of `{id, name, kind, host, token}`. `sendRemoteTo(device, action)` dispatches to `TvRemote` (Samsung websocket, port 8001, token from the TV's allow prompt) or `RokuRemote` (ECP POST on port 8060). Actions are protocol-neutral strings in `RemoteAction`.

## Bridge

`BridgeClient` posts to the relay; `runBridgeCommand(action, arg)` maps relay actions onto the same functions the UI uses. The relay cannot skip that whitelist.

## Adding a page

1. Add a layout and a `PageXBinding` (an explicit `import com.jarvis.launcher.databinding.PageXBinding` is required — ViewBinding does not resolve it implicitly).
2. Append to `pageViews`, `tabLabels` and `pageLockKeys` in the same order.
3. Add a tab include in `activity_main.xml`.
