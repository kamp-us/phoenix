---
id: 0025
title: Split LiveDO into ConnectionDO and TopicDO
status: accepted
date: 2026-05-24
tags: [live, durable-objects, sse]
---

# 0025 — Split LiveDO into ConnectionDO and TopicDO

## Context

[0023](0023-live-views-sse-livedo.md) packaged cross-isolate live fan-out as
**one** `LiveDO` class with two roles selected by the `fetch` path: a
`connection:<id>` instance owns a client's SSE stream, subscription list, and
`generation`; a `topic:<key>` instance owns only the `subscribers` SQL registry.

The two roles share no runtime state — an instance is always exactly one role,
never both. The union is a smell:

- **Invalid states are representable.** Nothing stops a `/publish` reaching a
  connection instance or a `/deliver` reaching a topic instance; the role
  discriminant is a path string with no type enforcement.
- **Every instance provisions storage it may never use.** The constructor runs
  `CREATE TABLE subscribers` on connection instances that never read it.
- The single class buys nothing semantically — there is no shared behavior and
  no instance that is legitimately both roles. It exists only to avoid a second
  Durable Object binding.

Amends [0023](0023-live-views-sse-livedo.md): its SSE-transport, DO-fan-out,
cookie-auth, and `generation` decisions all stand — only the one-class
packaging changes.

## Decision

Split `LiveDO` into two Durable Object classes sharing `live-protocol.ts` for
the wire vocabulary:

- **`ConnectionDO`** — owns one client's SSE stream, subscription list, and the
  persisted `generation`. Handles `/connect`, `/subscribe`, `/unsubscribe`,
  `/deliver`, `/probe`.
- **`TopicDO`** — owns the durable subscriber registry, the publish fan-out, and
  the alarm reap. Handles `/register`, `/deregister`, `/publish`.

Two bindings (`CONNECTION_DO`, `TOPIC_DO`) replace `LIVE_DO`; a `v2` migration
adds both `new_sqlite_classes` and `deleted_classes: ["LiveDO"]`. Cross-DO
stubs retarget: topic→connection deliver goes through `CONNECTION_DO`,
connection→topic register through `TOPIC_DO`.

The protocol is **unchanged**. Generation-based stale detection,
reachable-mismatch-only pruning, the consecutive-miss reap, and the 2s fan-out
timeout all behave identically. This is a structural split, not a semantics
change.

## Consequences

- **Easier:** invalid cross-role calls become unrepresentable; each constructor
  provisions only its own storage; each `fetch` router is half the size and
  role-typed.
- **Cost:** a second binding + a `v2` migration. The `deleted_classes: ["LiveDO"]`
  drops `LiveDO` instance storage, but that is regenerable live-session state —
  subscriber rows repopulate when clients re-subscribe on reconnect, and
  `generation` only needs monotonicity within a single stream lifetime. Worst
  case at deploy is in-flight SSE streams reconnecting, the same blip any deploy
  causes.
- Amends the one-class packaging of
  [0023](0023-live-views-sse-livedo.md); the rest of 0023 is untouched.
- See [fate-live-views.md](../.patterns/fate-live-views.md).

Amended in part by [0028](0028-effect-durable-object-model.md): both classes are
authored on alchemy's Effect DO model (typed RPC methods replace fetch-path
dispatch, `state.storage.sql` backs the registry, `TopicDO` resolves `ConnectionDO`
via `yield*` for fan-out). The connection/topic split decided here is unchanged.
