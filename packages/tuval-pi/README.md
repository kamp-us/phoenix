# @kampus/tuval-pi

Tuval's Pi harness: the `pi-session` program row, the loopback Pi host and client behind it
(`PiAiAgent`), the kernel tools it serves to Pi as custom tools, the history mapper that reads Pi's
own session JSONL, and the Pi chat window.

It is an official plugin package, built on `@kampus/tuval-sdk` and `@kampus/tuval-ui` through their
exports maps the same way an outside program is. The desk app registers Pi by importing it, and the
Pi packages (`@earendil-works/pi-*`, `pi-subagents`, `typebox`, `ws`) are this package's
dependencies, not the SDK's or the app's. The pin and why it is exact are in
[ADR 0366](../../.decisions/0366-tuval-keeps-own-pi-host.md).

## Usage

A config registers the row:

```ts
// <project>/.tuval/tuval.config.ts
import {ClientId, piSessionProgram, projectRootOf, WorkspaceId} from "@kampus/tuval-pi";
import type {TuvalConfigInput} from "@kampus/tuval-sdk/kernel/config";

const scope = {workspace: WorkspaceId.make("default"), client: ClientId.make("tuval-desk")};

export default {
  version: 1,
  programs: [piSessionProgram({cwd: projectRootOf(import.meta.url), scope})],
} satisfies TuvalConfigInput;
```

The row reaches for the operator's own Pi credentials and model catalog when a process starts.
Building the row starts nothing.

## Dependencies

`@kampus/tuval-sdk`, `effect` and `react` are peer dependencies: the desk supplies the one copy of
each. `@kampus/tuval-ui`, the four `@earendil-works/pi-*` packages, `pi-subagents`, `typebox` and
`ws` are regular dependencies.

The package is workspace-only for now. It ships TypeScript source, and the window reaches
stylesheets through `@kampus/tuval-ui`, so a consumer bundles it with Vite, as the desk does.

## Entries

| Entry | What it holds |
|---|---|
| `.` | `piSessionProgram`, its program id, renderer reference and `projectRootOf`, and the `ClientId` / `WorkspaceId` constructors a row's `scope` needs. Node-side; never reaches React. |
| `./ai-agent` | `PiAiAgent`, the `TuvalAiAgent` layer, and its options. |
| `./server` | The loopback Pi host: `PiServerService`, `PiSessionHost` and the subagent extension paths. |
| `./window` | `piChatWindow` and `PiChatWindow`, the browser-side renderer. |
| `./testing/faux` | `fauxPiLayer` over Pi's faux provider and its reply builders, for proofs that must call no model. |
| `./testing/window` | Session states the window tests and proofs render. |
| `./testing/window-proof` | The projections a window proof page builds its states from. |

## Develop

```sh
pnpm --filter @kampus/tuval-pi typecheck
pnpm --filter @kampus/tuval-pi test:unit
pnpm --filter @kampus/tuval-pi test:integration
```

The integration tier runs a real Pi `AgentSession` behind the real loopback socket on Pi's faux
provider, and needs no credentials. The desk-level proofs that boot the row in the real shell live
in the app under `apps/tuval/src/pi-desk/`.

## The loopback server

`src/server/` is the WebSocket server Pi 0.84.3 does not ship — the spike's `spike-server.mjs`
(#7469) hand-ported into Effect, plus the production half the spike had no need for. One server
per Pi process, on `127.0.0.1` and port 0: two Pi processes on one machine run two servers on two
ports and share nothing.

`PiServerService.layer()` is acquire/release scoped over a `PiSessionHost`. Closing its scope
closes every socket, ends every connection's fibers and disposes every session exactly once. The
service hands back the address, the dial URL and the capability token, all three `Redacted` where
they carry the token.

```ts
const layer = PiServerService.layer().pipe(
	Layer.provide(agentSessionHostLayer({modelRuntime, agentDir})),
);
```

**The wire.** Framed CBOR through `ClientMessageDecoder` / `encodeServerMessage`. Each request is
answered under its own id on its own fiber, so a slow `create` never holds up a later `list`.
Sessions are owned exclusively: a second connection attaching one is refused `session_locked`, a
missing one answers a structured `not_found`, and an `attach` from the connection that already
owns it is the reconnect — the previous lease is invalidated, a new one issued, and the transcript
comes back on the snapshot. Every change advances the session's revision and pushes a
`session_snapshot` to its owner; bursts coalesce, so revisions can skip but never go backwards.

**The production half** (#7465, founder ruling on #7567). The upgrade carries a per-launch
capability token — 32 random bytes as hex, minted per process spawn, in handler memory only, never
in Demlik state, the checkpoint or a log, and a fresh one after a restart. The handshake refuses a
missing or wrong token, a non-loopback `Host` and a non-loopback `Origin`, all before a WebSocket
exists and therefore before any frame is read. Every one of those inputs is attacker-controlled and
pre-auth, so the guard is total — no header and no request target can throw out of it, and the
`upgrade` listener answers a bare `400` under a `catch` if one ever does. A frame over the declared
inbound bound closes the socket with `1009`; a per-connection outbound queue over its bound closes
it with `1013`.

**`PiSessionHost`** is the seam. Above it, only protocol values; below it, the real `AgentSession`
and its JSONL `SessionManager` — the transcript lands in the desk's own store, at
`<state dir>/pi-sessions`, whatever cwd the session works in. Everything crossing that seam is
projected, never cast, per
[`.patterns/strict-wire-schema-projection.md`](../../.patterns/strict-wire-schema-projection.md).
`makeScriptedHost` in `fixtures.ts` is the same seam with no model behind it, which is what lets
the whole wire suite run in the unit tier.

## The client

`src/client/` is the dial side, in Node inside the same Pi process: the `ByteTransport` the
0.84.3 pin does not export, plus the lease handling around `PiClient`. Pi ships a Unix-socket
factory and nothing over a WebSocket, and Node 26 ships the WebSocket *client* as a global while
`ws` supplies the server half — so `webSocketTransportFactory` is ours, hand-derived from the
spike's `play.ts` (#7469) and shaped after the pin's own `unix.js`.

`PiClientService.layerWebSocket({url})` takes the server's dial URL, token included, and hands back
`connect`, `reconnect`, `createSession`, `attachSession`, `prompt`, `abort`, `snapshots` and
`disconnections`. Nothing below that surface returns a `Promise` or throws a Pi error class: every
rejection folds into one of four typed refusals — `SessionLocked`, `SessionNotFound`,
`Disconnected`, `ProtocolRefused` — in `refusals.ts`.

**Reconnect is explicit, and it does not preserve leases.** The pin invalidates every lease when the
connection drops, so a dropped socket is one `Disconnected` on the `disconnections` stream and
nothing else: no redial, no backoff, no queued call waiting on one. A caller reconnects and then
reacquires by session id, and the reacquired snapshot carries the transcript from before the drop.
Retry policy is the handlers' and stays declared data (#7371).

`fixtures.ts`'s `startProtocolServer` is an in-process `ws` listener speaking the real codec, which
is what lets the transport and the no-retry-loop proof run in the unit tier; the lock, the
not-found and the reacquire run against the loopback server on Pi's faux provider in
`pi-client.integration.test.ts`.

## The AI agent layer

`src/ai-agent/` is where Pi's protocol stops. `PiAiAgent.layer()` is a
`Layer<TuvalAiAgent, never, KernelBridge | Features>`, never-failing, asking for two of Tuval's own
services and no Pi type in either channel. `KernelBridge` is what the row's three kernel tools call
through, provided by the row from its own scope the way the Claude and Codex rows provide it (ruling
R9.1 on [#8715](https://github.com/kamp-us/phoenix/issues/8715)); `Features` is the merged flag
record the row's spawner hands over
([#8595](https://github.com/kamp-us/phoenix/issues/8595)). Founder ruling 4
([#7570](https://github.com/kamp-us/phoenix/issues/7570)) is what puts the runtime inside the layer,
and it required nothing at all until those two landed; what the ruling guards is unchanged, since
both are Tuval services. Building it inside the process's scope stands up Pi's model runtime, the
`PiSessionHost` over it, one loopback server and one client, and closing that scope closes the
client, the server and every session exactly once. A process therefore holds no Pi value of its own
— `PiAiAgentOptions` carries plain strings, and `agentDir` is the only path it usually sets. Nothing
on that surface is a Pi type, and the per-launch token is unwrapped once, into the transport
factory's closure, and reaches no event, no method's answer and no log line.

**The three kernel tools.** `spawn`, `send` and `read` reach a Pi session as plain `customTools` on
`createAgentSession`, at those bare names — a third adapter over the one `KernelBridge`, where
Claude's is an in-process MCP server and Codex's an HTTP one (`src/tools.ts`,
[#8720](https://github.com/kamp-us/phoenix/issues/8720)). They ship behind the default-off
`piKernelTools` flag; off, the host passes no `customTools` key and opens exactly the session it
opened before. Pi has no error flag on a tool result, so a bridge refusal is a rejected `execute`,
which is what the agent loop renders as the model's tool error. The `pi-subagents` extension and its
own flag are untouched by any of it.

`start({cwd, resume?})` is the caller's, not the layer's, so restore is "rebuild the layer, then
`start({cwd, resume: sessionId})`" — and that same call is the only way back after a drop. A dropped
socket fails `events` once with a `TransportError` and nothing dials again; the handlers decide.

Pi pushes whole snapshots, so `items.ts` folds each revision into the events that changed, keyed by
identities Pi guarantees — a tool row by its call id, so the result supersedes the running row it
belongs to ([snapshot-authoritative-to-delta-events.md](../../.patterns/snapshot-authoritative-to-delta-events.md)).
History is Pi's own: `page(before, limit)` reads the session's JSONL through
`SessionManager.getBranch()` and bounds it with the shared page planner, so Tuval keeps no second
copy. Pi raises no permission requests and offers no modes at this pin, so `answer` and `setMode`
refuse as data.
