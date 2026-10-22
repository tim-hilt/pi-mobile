# Bridge Protocol

Source of truth for the contract between `bridge/` and `ios/`. Both sides test against it.

**Version: 1**

## Transport

WebSocket. Each text frame is one JSON object (a _record_); records are newline-terminated (`\n`) and a frame may carry several. Every connection and upgrade request carries `Authorization: Bearer <token>`; otherwise the bridge answers the upgrade with HTTP `401` and no protocol traffic occurs. The bridge listens on `127.0.0.1` only.

## Records

Every record has a `type`.

| Direction    | `type`    | Fields                                    |
| ------------ | --------- | ----------------------------------------- |
| app → bridge | `command` | `id` (integer), `name`, `params` (object) |
| bridge → app | `result`  | `id` (echoed), `result` **or** `error`    |
| bridge → app | `event`   | `seq` (integer), `name`, `data` (object)  |
| bridge → app | `error`   | `error` (connection-level, no `id`)       |

`error` is `{ "code": string, "message": string }`.

## Protocol violations

A record that is not valid JSON or not a well-formed `command` → `error` record with `error.code = "malformedRecord"`. A first command other than `hello` → `error.code = "helloRequired"`. After any top-level `error` record (and after `versionMismatch`) the bridge closes the socket with WebSocket code `1008`; connections are never left half-usable.

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

After a successful `hello`, the bridge sends a WebSocket ping every ~30 s (Cloudflare drops idle sockets at ~100 s).

## Commands

`hello`, `prompt`, `abort`, `newSession`, `switchSession`, `getSessions`, `getStats`, `listSkills`, `searchFiles`. Only `hello` and `prompt` are specified so far; params and results of the rest are specified by the issue that implements each.

### `prompt`

Params: `{ text: string, mode?: "steer" | "followUp" }`. Result `{}` once the bridge has accepted the text.

- Idle session: starts a run; `mode` is ignored.
- Run active: `steer` delivers after the current assistant turn and its tool calls; `followUp` delivers after the run finishes its pending work. No `mode` → `error.code = "runActive"`.
- Bad params → `error.code = "invalidParams"`. The session refusing the prompt → `error.code = "sessionError"` (connection stays usable).

## Events

`transcript`, `toolCall` (start / update / end), `stats`: payloads to be specified by the issue that implements each. Run events, in the order a run emits them:

| `name`       | `data`                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `runStarted` | `{}`                                                                                                             |
| `delta`      | `{ kind: "text" \| "thinking", text }` — an increment to append                                                  |
| `messageEnd` | `{ text, thinking }` — the authoritative completed message; replaces its deltas                                  |
| `runSettled` | `{ stopReason: "success" \| "error" \| "aborted", durationMs, errorMessage? }` — pi will not continue on its own |

`durationMs` is measured by the bridge from `runStarted` to `runSettled`.
