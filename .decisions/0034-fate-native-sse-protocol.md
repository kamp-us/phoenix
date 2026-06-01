---
id: 0034
title: Stay on fate's native SSE + POST protocol; do not redesign to WebSocket
status: accepted
date: 2026-05-29
tags: [fate, live, sse, websocket, durable-objects]
---

# 0034 — Stay on fate's native SSE + POST protocol; do not redesign to WebSocket

## Context

phoenix's live channel runs on fate's native wire protocol (recorded in
[0023](0023-live-views-sse-livedo.md), split-DO topology in
[0025](0025-split-livedo-connection-topic.md), authoring model in
[0028](0028-effect-durable-object-model.md)):

- A long-lived `GET /fate/live?connectionId=…` opens a `text/event-stream`
  to the client. `ConnectionDO` holds the `ReadableStream` controller.
- Control messages — `subscribe`, `subscribeConnection`, `unsubscribe` —
  POST to the **same** path. `ConnectionDO` records the subscription and
  registers the row on `TopicDO`.
- Fan-out is `TopicDO.publish` → enumerate subscriber rows → typed RPC
  `connections.getByName(…).deliver(frame)`.

This is fate's stock client design. `nativeLiveClient` (the only live client
implementation fate ships) hard-codes `EventSource` for the read stream and
the same-URL `POST` for control. Using fate's stock client means phoenix
doesn't write or maintain a custom `liveConnector`.

The known wart: a control POST and a reconnected SSE stream race. If a
subscribe POST arrives at `TopicDO` carrying a stale `epoch` (formerly
called `generation` in earlier drafts; renamed for unambiguous
distributed-systems vocabulary — Raft/Paxos/Zookeeper convention) after the
client's `ConnectionDO` has already bumped its epoch on reconnect,
`TopicDO` inserts the row, and the next publish prunes it as a
reachable-mismatch — silent missed event. The system **gracefully degrades**:
the client's next mount or re-subscribe heals it. For sözlük/pano-scale
read-mostly workloads the wart is acceptable.

Two redesigns were on the table:

- A custom client-side `liveConnector` over WebSocket — bidirectional one
  channel, instant subscribe-on-the-wire, smaller `epoch` surface, and
  the path to DO hibernation if scale grows.
- partysub (Cloudflare/PartyKit experimental) — topic pub/sub with wildcards,
  multi-topic subs per connection, the closest model fit to fate's needs.

## Decision

Stay on fate's native SSE + POST protocol. Do not write a custom WebSocket
connector. Do not migrate to partysub.

## Rationale

- **Cost of the alternative is non-trivial.** A WebSocket connector means
  reimplementing what `EventSource` gives for free: automatic reconnect with
  exponential backoff, `lastEventId` resume, transparent failover across
  network transitions. A WS upgrade handler on `ConnectionDO` and a new
  control-frame encoding on top of it. None of that is on phoenix's critical
  path today.
- **The race is gracefully degraded, not lost data in a strong sense.** The
  subscribe-race produces "one update arrives a navigation late". Cache reads
  on next mount catch up. For the products phoenix runs (a dictionary, a
  link-aggregator, a karma counter) that is well inside the acceptable band.
- **partysub** is the closest model fit to fate's needs — pub/sub with
  wildcards, multi-topic per connection — but the maintainers explicitly mark
  it "not yet recommended for production" and no durability/QoS story exists.
  Adopting it would mean owning the durability layer ourselves, which is
  exactly what `TopicDO` already does on top of `state.storage.sql`.

## Trigger to revisit

Revisit the WebSocket redesign when:

- A latency-sensitive feature ships where the gracefully-degraded "one update
  late on subscribe-race" is no longer acceptable. Concretely: live presence,
  multiplayer cursors, real-time collab editing, in-flight game state.
- `partysub` (or an equivalent CF-native pub/sub abstraction) ships a
  documented durability + QoS story. Quarterly check.

Until either trigger hits, the current topology stands.

## Consequences

- **`ConnectionDO` continues to hold an in-memory `ReadableStream`** — no DO
  hibernation, because SSE streams pin the DO in memory. At current scale
  that's fine.
- **`epoch` stays load-bearing.** The persisted counter is the only
  defense against the subscribe-race, and the reap algorithm
  ([0023](0023-live-views-sse-livedo.md)) depends on it.
- **The Connection→Topic edge stays.** Subscribe POST routes through
  `ConnectionDO`, which then registers on `TopicDO`. The fan-out direction
  is Topic→Connection. The bidirectional cycle is preserved, so the per-call
  sibling resolution rule from [0033](0033-mutual-do-layer-cycle-per-call-resolution.md)
  continues to apply.
- **The "considered alternatives" exploration is preserved as a reference
  doc** so the decision can be re-litigated against fresh evidence without
  re-doing the survey — see
  [`live-fan-out-options-considered.md`](../.patterns/live-fan-out-options-considered.md).
- See [fate-live-views.md](../.patterns/fate-live-views.md),
  [0023](0023-live-views-sse-livedo.md), and
  [0033](0033-mutual-do-layer-cycle-per-call-resolution.md).
