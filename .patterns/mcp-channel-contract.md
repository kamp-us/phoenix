# The MCP channel contract (`claude/channel`)

The wire contract by which the crew's messaging substrate reaches a Claude Code session:
the `claude/channel` experimental capability an `McpServer` advertises, the
`notifications/claude/channel` server→client notification it delivers over, and the
**last-mile-only** constraint that shapes everything above it
([`@kampus/pipeline-crew-mcp`](../packages/pipeline-crew-mcp) `src/edge/`, epic
[#3045](https://github.com/kamp-us/phoenix/issues/3045)). This is the *wire contract*
layer — a child of [mcp-server-effect.md](./mcp-server-effect.md), which owns the
Effect-API surface (transports, registration, the notification machinery) and the `pnpm`
patch that adds this capability. Read that first for *how* the capability is wired; read
this for *what* a channel is and *what it can't do*.

## What a Claude Code channel is — and the constraint that defines the architecture

A channel is Claude Code's primitive for delivering a message **into a running session's
context**. It is deliberately minimal, and the substrate above it is shaped entirely by
what the primitive **does not** provide. Grounded in the Claude Code
[channels-reference](https://code.claude.com/docs/en/channels-reference):

| The primitive gives you | The primitive does **not** give you |
|---|---|
| Delivery into **one** session's context (strictly **1:1 per session**) | Cross-session **addressing** — a channel can't name another session |
| A **wake** on message (the session is roused to read it) | **Pub/sub** — no topics, no fan-out |
| A structured **`<channel>` tag** wrapping the delivered payload | **Persistence** — nothing is stored; an offline session misses it |
| — | **Delivery acks** — the primitive never confirms receipt |

**This is load-bearing:** because the channel is 1:1, wake-only, and ack-less, it carries
**no cross-session semantics at all**. Everything that makes crew messaging work —
addressing a peer by role, discovering who is present, leasing a role for uniqueness,
acknowledging a delivery, retrying — lives **above** the channel, in the substrate's
`tracker/` and `peer/` modules. The channel is **last-mile delivery only**: the final hop
that wakes a session and drops a structured payload into its context. An agent reasoning
about the channel as if it were a message bus (expecting persistence, acks, or the ability
to address a peer through it) will design a broken protocol — the primitive routes one
payload into one session and nothing more.

## The two wire constants — capability + notification

The substrate names the contract as two constants in
[`src/edge/mcp-channel.ts`](../packages/pipeline-crew-mcp/src/edge/mcp-channel.ts), so
consumers reference them instead of magic strings:

| Constant | Value | Role |
|---|---|---|
| `CHANNEL_CAPABILITY` | `"claude/channel"` | The `experimental` capability a channel-serving `McpServer` advertises at `initialize` |
| `CHANNEL_NOTIFICATION_METHOD` | `"notifications/claude/channel"` | The server→client notification method the payload rides |
| `channelExperimentalCapability` | `{ "claude/channel": {} }` | The ready-made `experimental` object to pass to the transport factory |

A channel-serving server **declares the capability** by passing the ready-made object to
its transport factory, and **delivers** by emitting the notification. Both the capability
slot and the notification method exist only because of the additive `pnpm` patch on
`effect/unstable/ai` ([ADR 0038](../.decisions/0038-dependency-patches-local-only.md);
the fixed public API can express neither — see
[mcp-server-effect.md](./mcp-server-effect.md#the-pin-surface-caveat-load-bearing--and-the-patch)):

```ts
import {McpServer} from "effect/unstable/ai";
import {channelExperimentalCapability} from "@kampus/pipeline-crew-mcp/edge";

// Advertise the claude/channel capability at initialize — never the raw string.
const serverLayer = McpServer.layerHttp({
	name: "ChannelEdge",
	version: "0.0.0",
	path: "/mcp",
	experimental: channelExperimentalCapability,
});
```

### The notification payload — `{message, _meta.from}`

A `notifications/claude/channel` payload is
[`ChannelNotificationPayload`](../packages/pipeline-crew-mcp/src/edge/mcp-channel.ts):
`message` is the channel body; `_meta.from` carries the originating peer (the raw-SDK
`_meta` contract proven by spike [#3034](https://github.com/kamp-us/phoenix/issues/3034)).
Because the channel gives no addressing, `_meta.from` is how the receiving edge learns who
sent the payload — the identity travels *in* the payload, not in the transport.

```ts
import type {ChannelNotificationPayload} from "@kampus/pipeline-crew-mcp/edge";

const payload: ChannelNotificationPayload = {
	message: "wake",
	_meta: {from: "peer-a"}, // sender identity rides in the payload, not the channel
};
```

## The research-preview load path — `--dangerously-load-development-channels`

Custom channels are a Claude Code **research preview**. A crew session loads this MCP
server as a channel by starting Claude Code with the
`--dangerously-load-development-channels` flag (founder-accepted transport bet, wayfinder
[#3031](https://github.com/kamp-us/phoenix/issues/3031)); without it, a custom
`claude/channel` capability is not loaded and the delivery path is inert. The flag is the
one seam that opts a session into the preview — it is not a per-message concern, and the
`dangerously-` prefix is Claude Code's own (a preview-gate, not a phoenix invention).

## Where the cross-session semantics actually live

Since the channel is last-mile only, the substrate splits the work across modules — the
channel edge does delivery, everything else does coordination (package
[README](../packages/pipeline-crew-mcp/README.md); the generic-core boundary in
[`src/index.ts`](../packages/pipeline-crew-mcp/src/index.ts)):

| Module | Carries | Not the channel's job because |
|---|---|---|
| `edge/` | Last-mile delivery: advertise `claude/channel`, emit `notifications/claude/channel` into a session | — this **is** the channel |
| `tracker/` | Presence, role discovery/lookup, heartbeat TTL, named leases for role uniqueness — a control-plane registry that **never relays messages** | the channel has no addressing or pub/sub |
| `peer/` | The p2p data plane: dial, hold connections, relay typed messages, inbox acks | the channel has no acks and can't address a peer |
| `protocol/` | The 7 typed message kinds as one Effect `RpcGroup` — the decode-checked envelope every peer shares | the channel carries an opaque body, not a typed catalog |

The boundary is one-way: `protocol/`, `tracker/`, `peer/`, and `edge/` are the generic,
crew-agnostic substrate and never import `crew/`; only `crew/` (the Role catalog + wiring)
depends inward. Coordination semantics belong in the tracker/peer layer by construction —
pushing any of them onto the channel is the mistake this doc exists to prevent.

## The worked example — the shipped `edge/` module + its drift guard

The edge module is small on purpose: it is the constants and the payload type, nothing
more. The behavior it depends on lives in the patch, held by the **two-layer behavior-pin
drift guard** in
[`src/edge/mcp-channel.test.ts`](../packages/pipeline-crew-mcp/src/edge/mcp-channel.test.ts)
(tagged `// @patch-pin: effect@4.0.0-beta.92`, shipped #3053/#3084):

- **Surface pin** — the upstream structures the patch grafts onto still exist at the pin
  (`McpSchema.ServerCapabilities` decodes an `experimental` slot,
  `ServerNotificationRpcs` still carries its upstream members, `McpServer.layerHttp` is
  still a function). A sanctioned catalog bump that moves them reds here.
- **Behavior pin** — the contract this doc describes: an initialized client sees
  `claude/channel` advertised (driven through a real in-memory `McpServer.layerHttp` +
  `HttpRouter.toWebHandler` + a session-replaying `customFetch`), `notifications/claude/channel`
  is a `ServerNotificationRpcs` member, and a `{message, _meta.from}` payload encodes
  through that member's `payloadSchema`.

The vocabulary and marker grammar are owned by
[dependency-patch-behavior-pins.md](./dependency-patch-behavior-pins.md); the API surface
and patch mechanics by [mcp-server-effect.md](./mcp-server-effect.md). This doc is the
*contract* the guard verifies.

## Rules

- **Reason about the channel as last-mile delivery, not a bus.** No persistence, no acks,
  no pub/sub, no cross-session addressing — 1:1 into one session (channels-reference). Put
  every cross-session semantic in `tracker/`/`peer/`, never on the channel.
- **Reference the wire constants, never the string.** Advertise with
  `channelExperimentalCapability` / `CHANNEL_CAPABILITY`, deliver with
  `CHANNEL_NOTIFICATION_METHOD` from `edge/mcp-channel.ts` — the string is meaningful only
  because of the patch.
- **Sender identity rides in the payload** (`_meta.from`), because the channel carries none.
- **The capability + notification exist only under the `pnpm` patch** — a channel-serving
  server is only viable at a pin whose `patch-guard` is green.
- **A custom channel loads only under `--dangerously-load-development-channels`** — it's a
  research preview, session-level, not a per-message flag.

## See also

- [mcp-server-effect.md](./mcp-server-effect.md) — the `effect/unstable/ai`
  `McpServer`/`McpSchema` API surface and the additive `pnpm` patch that adds this
  capability + notification (read first).
- [dependency-patch-behavior-pins.md](./dependency-patch-behavior-pins.md) — the two-layer
  patch behavior-pin discipline and `@patch-pin:` marker grammar the drift guard registers under.
- [ADR 0038](../.decisions/0038-dependency-patches-local-only.md) — the in-repo `pnpm patch`
  idiom the channel patch follows.
- Claude Code [channels-reference](https://code.claude.com/docs/en/channels-reference) —
  the upstream authority for the 1:1 / no-addressing / no-pub-sub / no-persistence /
  no-ack constraint.
