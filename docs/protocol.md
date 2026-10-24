# Bridge Protocol

Source of truth for the contract between `bridge/` and `ios/`. Both sides test against it.

**Version: 2**

The bridge serves every pi session running on the Mac (see [Share Link](#share-link)). A connection lists them and _joins_ one at a time; events and session commands concern the joined session.

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

- Each session counts its own events: `seq` increases by 1 per event of that session. It restarts whenever pi starts sharing the session anew, so it is only meaningful together with the `epoch` (opaque string) of the `joinSession` result that preceded it.
- `joinSession` carries the app's last-seen `lastSeq` of that session (`0` or absent if none) and the `epoch` it came from. A missing or invalid `lastSeq`, or an `epoch` other than the session's current one, counts as `0`. Right after the `joinSession` result the bridge sends the catch-up, then streams live without gaps:
  - `lastSeq` ≥ 1 and the bridge still retains every event after it (last 1000 by default) → exactly the events with `seq > lastSeq`.
  - Otherwise → one `transcript` snapshot instead.
- The app adopts a `transcript` event as authoritative: it replaces everything it held and its `seq` becomes the new cursor. A catch-up snapshot does not consume a `seq`; it carries the `seq` of the latest event it reflects. When pi replaces the session (`/new`, `/resume`, `/fork`), joined clients follow: they get a live `transcript` of the new session (new `sessionId`) that does take a fresh `seq`, and the replay log is emptied, so a cursor from before the switch always gets a snapshot.

## Versioning

- First record after connect: app sends `hello` (`command`, `params: { protocolVersion }`).
- Bridge answers `result` with `{ protocolVersion }` on success, or `error.code = "versionMismatch"` and closes the socket.
- Breaking changes bump the integer version; additive fields do not.

## Notifications

Not part of the protocol: the app raises none. When configured with an ntfy topic, the bridge publishes a push notification for every `runSettled`, whatever the `stopReason`, whether or not an app is connected; the user receives it with the ntfy app. It POSTs ntfy's JSON form to `<baseUrl>`: `{ topic, title, message, tags: ["robot"], markdown: true, icon, click }`. `title` is `<session name or cwd basename>: Agent Finished|Failed|Aborted|Cut Off`; `message` the run's last assistant text (≤ 1000 chars), else its error, else "The agent finished.". `click` is `pimobile://session?id=<sessionId>`: tapping the notification opens the app on that session (`joinSession` once connected, unless already joined). The topic is public by obscurity and the message carries transcript content: keep it unguessable. Delivery failures are logged and otherwise ignored.

Bridge config (`~/.pi/agent/bridge.json`): `ntfyTopic` (enables it), `ntfyUrl` (default `https://ntfy.sh`).

## Keepalive

After a successful `hello`, the bridge sends a WebSocket ping every ~30 s (Cloudflare drops idle sockets at ~100 s).

## Commands

`hello`, `getSessions`, `joinSession`, `prompt`, `abort`, `getStats`, `listSkills`, `searchFiles`, `listModels`, `setModel`. All but the first three concern the joined session; sent before joining → `error.code = "notJoined"`.

### `getSessions`

Params `{}`. Result `{ sessions, joinedId? }` — every live session, most recently active first, as `{ id, name?, cwd, preview, running, lastStopReason?, activeAt }` (`name` user-given; `preview` the first user message, `""` if none; `lastStopReason` the `stopReason` of the latest `runSettled`, absent until a run settled since pi began the session; `activeAt` ISO 8601 of the latest event). `joinedId` is the session this connection is joined to.

### `joinSession`

Params `{ id: string, lastSeq?: integer, epoch?: string }`. Result `{ epoch }`, then the catch-up (see [Event ordering and replay](#event-ordering-and-replay)). Replaces any previous join. Unknown `id` → `unknownSession`; bad params → `invalidParams`.

### `prompt`

Params: `{ text: string, mode?: "steer" | "followUp" }`. Result `{}` once pi has the text.

- Idle session: starts a run; `mode` is ignored.
- Run active: `steer` delivers after the current assistant turn and its tool calls; `followUp` delivers after the run finishes its pending work. No `mode` → `error.code = "runActive"`.
- Bad params → `error.code = "invalidParams"`. Pi failing → `error.code = "sessionError"` (connection stays usable).

### `abort`

Params `{}`. Result `{}`. Stops the active run, which then settles with `stopReason: "aborted"`; a no-op when idle. Failure → `error.code = "sessionError"`.

### `getStats`

Params `{}`. Result for the current session: `{ userMessages, assistantMessages, toolCalls, tokens, cost, runs, runDurationMs }`. The first five come from pi and cover the whole session (`tokens` is the total, `cost` its price). `runs` and `runDurationMs` (total) count the runs the bridge has seen settle since it started sharing the session.

### `listSkills`

Params `{}`. Result `{ skills: { name, description }[] }` — the session's skills. Invoke one by sending `prompt` text `/skill:<name>` optionally followed by a space and arguments; the bridge's `userMessage` echoes that text, not the skill's expanded body.

### `searchFiles`

Params `{ query: string, limit?: integer }` (`limit` default 20, capped at 100). Result `{ files: string[] }` — paths relative to the session's working directory, `/`-separated, best first. Matching is case-insensitive: file-name prefix, path prefix, substring, then subsequence; ties go to the shorter path; empty `query` matches all. Inside a git repository, ignored files are excluded. Bad params → `error.code = "invalidParams"`.

### `listModels`

Params `{}`. Result `{ models: { provider, id, name }[] }` — the models pi's `/model` offers: the session's scoped models if configured, else every model with credentials. `id` is unique only within `provider`; the active one is `status.model`.

### `setModel`

Params `{ provider: string, id: string }`. Result `{}` once pi switched; a `status` event follows. Unknown model or no credentials → `sessionError`; bad params → `invalidParams`.

## Events

Run events, in the order a run emits them:

| `name`        | `data`                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runStarted`  | `{}`                                                                                                                                                                                                 |
| `userMessage` | `{ text }` — a user message entered the conversation: the prompt itself, or a steer/follow-up pi took in                                                                                             |
| `queue`       | `{ steering: string[], followUp: string[] }` — the messages queued from the app but not yet taken in, oldest first; always the full new contents. Pi does not expose what was queued in its terminal |
| `delta`       | `{ kind: "text" \| "thinking", text }` — an increment to append                                                                                                                                      |
| `messageEnd`  | `{ text, thinking }` — the authoritative completed message; replaces its deltas                                                                                                                      |
| `runSettled`  | `{ stopReason: "success" \| "error" \| "aborted" \| "length", durationMs, errorMessage? }` — pi will not continue on its own                                                                         |

`durationMs` is measured by the bridge from `runStarted` to `runSettled`. `runStarted` is sent as soon as pi accepts a prompt. `stopReason` is `error` (with `errorMessage`) when the run's final assistant message failed, `aborted` when it was aborted, `length` when it ended because the model hit its output limit, else `success`; failures a retry recovered from do not count.

`status` `{ model?, contextTokens?, contextWindow?, cost }` — what pi's footer shows, sent whole whenever it changes: `model` the active model's id, `contextTokens` how much of its `contextWindow` the context fills (absent while unknown, e.g. right after compaction; both absent without a model), `cost` the whole session's price in USD. Usage counts once a turn ends.

`sessionEnded` `{ sessionId }` — pi quit: the session is gone and the connection is no longer joined. It is the last event of the session.

### `transcript`

`{ sessionId, cwd, messages, running, steering, followUp, model?, contextTokens?, contextWindow?, cost }` — `sessionId` is the session shown, `cwd` its working directory; the whole conversation, oldest first. `messages` entries are `{ role: "user", text }`, `{ role: "assistant", text, thinking }` (completed messages; a turn with neither is omitted) or `{ role: "toolCall", toolCallId, toolName, args, output?, isError? }` after the assistant turn that made the call (`output`/`isError` as in `toolCall` `end`, absent until the tool finished; later `toolCall` events with that `toolCallId` update it). If an assistant message is still being generated it is the last entry, holding its deltas so far, with `streaming: true`; later `delta` events extend it and its `messageEnd` replaces it. `running` is whether a run is active; while it is, `elapsedMs` is how long it has been going. `steering`/`followUp` are the queue as in the `queue` event, `model`, `contextTokens`, `contextWindow` and `cost` the status as in the `status` event. Past runs' outcomes and tool durations are not part of a snapshot.

### `toolCall`

One event per phase of a tool execution; all carry `toolCallId` and `toolName`. `output` is the tool's text (non-text content is dropped).

| `phase`  | other `data`                                                      |
| -------- | ----------------------------------------------------------------- |
| `start`  | `args`                                                            |
| `update` | `output` — output so far (replaces earlier updates)               |
| `end`    | `output`, `isError`, `durationMs?` (absent if the tool never ran) |

## Share Link

How pi processes share their sessions with the bridge; internal to the Mac, not part of the app contract. The `bridge/src/shareExtension.ts` pi extension connects every interactive pi process to the unix socket `~/.pi/agent/bridge.sock` (`PI_BRIDGE_SOCKET`; mode `0600`, no auth) and exchanges NDJSON records (`bridge/src/link.ts`): pi sends `announce` (on connect and when it replaces its session), `info`, `event` and `reply`; the bridge sends `call`. Any time, even before `announce`, pi may send `pairing`; the bridge answers `{type:"pairing", url}` (the app's pairing URL, holding the token) or `{type:"pairing", error}` without `publicUrl`. If no bridge answers, the extension starts `bridge/dist/main.js` detached; it outlives that pi. The TCP port is the single-instance lock.
