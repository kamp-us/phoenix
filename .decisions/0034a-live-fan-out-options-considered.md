---
id: 0034a
title: Live fan-out — options considered (appendix to 0034)
status: reference
date: 2026-05-29
tags: [fate, live, sse, durable-objects, build-vs-buy]
---

# 0034a — Live fan-out: options considered (appendix to ADR 0034)

The build-vs-buy survey behind phoenix's live channel — an appendix to
[ADR 0034](./0034-fate-native-sse-protocol.md). Future revisits don't re-do the
research; they read this, check which triggers have moved (the triggers live in
0034), and only re-survey the box that changed.

The chosen path is **build on alchemy's modular `Cloudflare.DurableObjectNamespace<Self, Shape>().make(body)` + fate's native SSE wire protocol**, with patterns harvested from the Cloudflare Agents SDK as a reference but the package not adopted. The reasoning below is what got us there. (The fan-out runs on a single void-aligned `LiveDO` playing both roles — [ADR 0037](./0037-unified-void-aligned-live-do.md); the build-vs-buy reasoning here is unchanged by that reunification.)

## Read first

- [fate-live-views.md](../.patterns/fate-live-views.md) — the protocol and DO phoenix actually runs.
- [ADR 0023](./0023-live-views-sse-livedo.md) — the SSE + LiveDO decision.
- [ADR 0037](./0037-unified-void-aligned-live-do.md) — the single void-aligned `LiveDO` (supersedes the 0025 connection/topic split).
- [ADR 0034](./0034-fate-native-sse-protocol.md) — why we stay on the native protocol.

## The candidates

### PartyKit / partyserver

The Cloudflare-acquired OSS pub/sub-over-DOs library; `partyserver@0.5.x` is
transitively pulled into phoenix's `node_modules` through `agents@0.12.3`.
Shape: `class Server extends DurableObject` with WebSocket hibernation built
in, a `Connection` class, helpers for `broadcast`, `getConnections(tag)`, and
per-room state.

**Why it's interesting.** WebSocket hibernation + room-style fan-out is
exactly what `LiveDO`'s connection + topic roles would look like if phoenix
moved off SSE.

**Why rejected (for now).** It is **WebSocket** infrastructure. Phoenix's
client transport is fate's `EventSource` (SSE), per [ADR 0034](./0034-fate-native-sse-protocol.md);
adopting partyserver would mean redesigning the client transport at the same
time. Reconsider only if and when [ADR 0034](./0034-fate-native-sse-protocol.md)
is revisited and the WebSocket trigger fires.

### partysub

Cloudflare / PartyKit experimental package. Topic-based pub/sub with wildcard
matching and multi-topic subscriptions per connection.

**Why it's interesting.** This is the **closest model fit** to fate's needs
of any candidate surveyed. `subscribe(topic, …)` / `publish(topic, msg)` /
multi-topic-per-connection is essentially what `LiveDO`'s topic + connection
roles implement by hand.

**Why rejected (for now).** The maintainers label it "not yet recommended for
production". No durability story; no QoS story; no documented behavior under
DO eviction. Adopting it would mean phoenix owns the durability layer
ourselves — which is what we already have on `state.storage.sql`.

**Trigger to track.** Quarterly check on the project's status. When durability
+ QoS land and the "not for production" label is gone, partysub becomes the
strongest replacement candidate.

### Cloudflare Pub/Sub (MQTT)

The product known as Cloudflare Pub/Sub, MQTT-over-edge.

**Status.** Private beta closed on 20 August 2025. The Cloudflare product
page now redirects to `@cloudflare/actors`.

**Verdict.** Dead. Skip.

### `@cloudflare/actors`

Cloudflare's alpha "actors over DOs" abstraction (preview release 25 June 2025).
A higher-level wrapper over Durable Objects with helpers for SQLite, single
and multi alarms, and event scheduling.

**Why it's interesting.** Sibling abstraction to alchemy's Effect DO model;
covers some of the same overhead.

**Why rejected.** No built-in pub/sub or fan-out primitives — it doesn't
replace the `LiveDO` fan-out algorithm, it would sit alongside it.
The alchemy Effect DO model already gives phoenix typed RPC and Effect-wrapped
storage; `@cloudflare/actors` would add a layer for no fan-out gain.

### Cloudflare Agents SDK

`agents` on npm; latest stable in the 0.13.x line. A thin layer over
`partyserver` (the same Cloudflare-acquired OSS) that adds:

- **State auto-broadcast.** Any `this.setState(...)` on the agent rebroadcasts
  the full state to every connected WebSocket client.
- **`@callable` decorator.** Method-as-RPC over WebSocket.
- **Scheduling abstraction.** `this.schedule(when, task)` over DO alarms.

**Why it's interesting.** State-auto-broadcast and `@callable` are the
ergonomics people reach for when they want "live state without writing the
publish path". Worth understanding as a pattern.

**Why rejected.**

- State auto-broadcast **collides with fate's typed view deltas.** fate
  publishes targeted `live.update(type, id, {changed, data})` events with
  inline-resolved entities and per-client masking. Broadcasting the whole DO
  state would re-introduce the over-fetching problem fate's data-view layer
  exists to solve.
- `@callable` is **WebSocket-only.** phoenix's transport is SSE
  ([ADR 0034](./0034-fate-native-sse-protocol.md)).
- The package inherits from `Agent` (which inherits from partyserver's
  `Server`), so adopting it would mean inheriting the WebSocket transport too.

**Verdict.** **Harvest patterns as a reference; do not inherit from `Agent`.**
Stick with vanilla `Cloudflare.DurableObjectNamespace<Self, Shape>().make(body)`
on the alchemy Effect DO model.

### Project Think / `@cloudflare/think`

Preview release 15 April 2026. AI-shaped runtime: durable execution via
fibers, sandboxed code execution, sub-agent coordination.

**Why rejected.** Solves a different problem (AI agent orchestration), not
real-time fan-out. Irrelevant to the live channel.

### Durable Object Facets

Released 13 April 2026. Dynamic DO instantiation under a supervisor DO,
allowing one parent DO to host an open set of child DOs without statically
declaring each binding.

**Why rejected.** Solves tenant-code-loading and dynamic-namespace problems
(useful if phoenix ever runs untrusted user-supplied DO code), not fan-out.
phoenix's live topics are well-known at deploy time.

### SaaS — Ably / Pusher / Liveblocks

Move the data plane off Cloudflare entirely. Use a managed pub/sub provider
for the live channel.

**Why rejected.** Inverts phoenix's "everything on Cloudflare" locality bet.
The whole point of `LiveDO` is that it sits in the same edge
isolate as the worker that publishes to it; routing the live channel
through a SaaS provider re-introduces the round-trip phoenix's architecture
exists to avoid. Also reintroduces a vendor account, billing, and
auth-bridging surface.

## How the choice was made

Two filters narrowed the search:

1. **Same edge as the publisher.** Anything that routes a `live.update` off
   Cloudflare is out — the locality bet is load-bearing.
2. **Same wire as the existing client.** Anything that requires the client
   transport to swap from SSE to WebSocket is out *until* [ADR 0034](./0034-fate-native-sse-protocol.md)
   is revisited; the cost of writing a custom `liveConnector` is the whole
   point of the SSE decision.

After those filters the surviving candidates were partysub (closest model
fit, not production-ready) and "keep building on alchemy DOs + native SSE"
(less ergonomic but production-proven and already half-built). Phoenix took
the second.

## Triggers to revisit

The state of this survey is anchored to the conditions recorded in
[ADR 0034](./0034-fate-native-sse-protocol.md):

- **partysub goes stable** with documented durability + QoS → re-evaluate as
  a replacement for the hand-written `LiveDO` fan-out algorithm.
- **A latency-sensitive feature lands** where the SSE subscribe-race graceful
  degradation is no longer acceptable → re-evaluate WebSocket transports and
  reconsider partyserver/Agents SDK as authoring frameworks under the same
  topology.
- **A new Cloudflare-native pub/sub primitive ships.** The `@cloudflare/actors`
  alpha is the canonical place to watch.

Until one of those fires, the current build wins on cost.
