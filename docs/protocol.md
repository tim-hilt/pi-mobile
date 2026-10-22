# Bridge Protocol

Source of truth for the contract between `bridge/` and `ios/`. Both sides test against it.

**Version: 1**

## Transport

WebSocket. Each text frame is one JSON object (a _record_); records are newline-terminated (`\n`) and a frame may carry several. Every connection and upgrade request carries `Authorization: Bearer <token>`; otherwise the bridge rejects it.

## Records

Every record has a `type`.

| Direction    | `type`    | Fields                                    |
| ------------ | --------- | ----------------------------------------- |
| app → bridge | `command` | `id` (integer), `name`, `params` (object) |
| bridge → app | `result`  | `id` (echoed), `result` **or** `error`    |
| bridge → app | `event`   | `seq` (integer), `name`, `data` (object)  |

`error` is `{ "code": string, "message": string }`.

## Correlation

- The app picks `id`, unique per connection and increasing. The bridge echoes it on exactly one `result` record.
- Unknown command `name` → `result` with `error.code = "unknownCommand"`.

## Event ordering and replay

- `seq` increases by 1 per event, across the bridge's lifetime.
- On connect the app sends its last-seen `seq` (`lastSeq`, `0` if none); the bridge replays events with `seq > lastSeq`, then streams live.
- If the cursor is no longer replayable, the bridge sends a `transcript` snapshot event instead.

## Versioning

- First record after connect: app sends `hello` (`command`, `params: { protocolVersion, lastSeq }`).
- Bridge answers `result` with `{ protocolVersion }` on success, or `error.code = "versionMismatch"` and closes the socket.
- Breaking changes bump the integer version; additive fields do not.

## Keepalive

Bridge sends WebSocket ping every ~30 s (Cloudflare drops idle sockets at ~100 s).

## Commands (skeleton)

`hello`, `prompt` (`mode`: `"steer"` | `"followUp"` | omitted), `abort`, `newSession`, `switchSession`, `getSessions`, `getStats`, `listSkills`, `searchFiles`. Params and results to be specified by the issue that implements each.

## Events (skeleton)

`transcript`, `delta` (text / thinking), `toolCall` (start / update / end), `messageEnd`, `runStarted`, `runSettled` (stop reason, timing), `stats`. Payloads to be specified by the issue that implements each.
