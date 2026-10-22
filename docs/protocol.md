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
- On connect the app sends its last-seen `seq` (`lastSeq`, `0` if none; a missing or invalid value counts as `0`). Right after the `hello` result the bridge sends the catch-up, then streams live without gaps:
  - `lastSeq` ≥ 1 and the bridge still retains every event after it (last 1000 by default) → exactly the events with `seq > lastSeq`.
  - Otherwise — fresh client (`0`), cursor too old, or cursor ahead of the bridge's `seq` (bridge restarted) → one `transcript` snapshot instead.
- The app adopts a `transcript` event as authoritative: it replaces everything it held and its `seq` becomes the new cursor. A snapshot does not consume a `seq`; it carries the `seq` of the latest event it reflects.

## Versioning

- First record after connect: app sends `hello` (`command`, `params: { protocolVersion, lastSeq }`).
- Bridge answers `result` with `{ protocolVersion }` on success, or `error.code = "versionMismatch"` and closes the socket.
- Breaking changes bump the integer version; additive fields do not.

## Keepalive

After a successful `hello`, the bridge sends a WebSocket ping every ~30 s (Cloudflare drops idle sockets at ~100 s).

## Commands

`hello`, `prompt`, `abort`, `newSession`, `switchSession`, `getSessions`, `getStats`, `listSkills`, `searchFiles`. Only `hello`, `prompt`, `abort` and `clearQueue` are specified so far; params and results of the rest are specified by the issue that implements each.

### `prompt`

Params: `{ text: string, mode?: "steer" | "followUp" }`. Result `{}` once the bridge has accepted the text.

- Idle session: starts a run; `mode` is ignored.
- Run active: `steer` delivers after the current assistant turn and its tool calls; `followUp` delivers after the run finishes its pending work. No `mode` → `error.code = "runActive"`.
- Bad params → `error.code = "invalidParams"`. The session refusing the prompt → `error.code = "sessionError"` (connection stays usable).

### `abort`

Params `{}`. Result `{}`. Stops the active run, which then settles with `stopReason: "aborted"`; a no-op when idle. Queued messages stay queued. Failure → `error.code = "sessionError"`.

### `clearQueue`

Params `{}`. Result `{ steering: string[], followUp: string[] }` — the queued texts that were dropped, so the app can hand them back to the user. A `queue` event follows.

## Events

`stats`: payload to be specified by the issue that implements it. Run events, in the order a run emits them:

| `name`        | `data`                                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `runStarted`  | `{}`                                                                                                                                |
| `userMessage` | `{ text }` — a user message entered the conversation: the prompt itself, or a steer/follow-up pi took in                            |
| `queue`       | `{ steering: string[], followUp: string[] }` — the messages queued but not yet taken in, oldest first; always the full new contents |
| `delta`       | `{ kind: "text" \| "thinking", text }` — an increment to append                                                                     |
| `messageEnd`  | `{ text, thinking }` — the authoritative completed message; replaces its deltas                                                     |
| `runSettled`  | `{ stopReason: "success" \| "error" \| "aborted" \| "length", durationMs, errorMessage? }` — pi will not continue on its own        |

`durationMs` is measured by the bridge from `runStarted` to `runSettled`. `runStarted` is sent as soon as pi accepts a prompt. `stopReason` is `error` (with `errorMessage`) when the run's final assistant message failed, `aborted` when it was aborted, `length` when it ended because the model hit its output limit, else `success`; failures a retry recovered from do not count.

### `transcript`

`{ messages, running, steering, followUp }` — the whole conversation, oldest first. `messages` entries are `{ role: "user", text }` or `{ role: "assistant", text, thinking }` (completed messages; tool-only turns omitted). If an assistant message is still being generated it is the last entry, holding its deltas so far, with `streaming: true`; later `delta` events extend it and its `messageEnd` replaces it. `running` is whether a run is active; while it is, `elapsedMs` is how long it has been going. `steering`/`followUp` are the queue as in the `queue` event. Tool calls and past runs' outcomes are not part of a snapshot.

### `toolCall`

One event per phase of a tool execution; all carry `toolCallId` and `toolName`. `output` is the tool's text (non-text content is dropped).

| `phase`  | other `data`                                                      |
| -------- | ----------------------------------------------------------------- |
| `start`  | `args`                                                            |
| `update` | `output` — output so far (replaces earlier updates)               |
| `end`    | `output`, `isError`, `durationMs?` (absent if the tool never ran) |
