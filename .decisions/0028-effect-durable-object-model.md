---
id: 0028
title: Port Durable Objects to alchemy's Effect DO model
status: accepted
date: 2026-05-25
tags: [durable-objects, effect, live]
---

# 0028 — Port Durable Objects to alchemy's Effect DO model

## Context

phoenix's `ConnectionDO` and `TopicDO` — split per
[0025](0025-split-livedo-connection-topic.md), over the SSE fan-out of
[0023](0023-live-views-sse-livedo.md) — are plain `cloudflare:workers`
`class extends DurableObject`: raw `Request`/`Response` dispatch on
`url.pathname`, raw `ctx.storage.sql`, no Effect. They are the one corner of the
backend still hand-rolling request routing and JSON (de)serialization.

alchemy provides an Effect-native DO model:
`Cloudflare.DurableObjectNamespace<Self>()(name, body)`, where `body` is a
two-phase Effect — a shared init that runs once per namespace, then a
per-instance Effect that closes over instance state. Methods returned from the
per-instance Effect become **typed RPC** on the stub; `Cloudflare.DurableObjectState`
exposes `storage.sql.exec`, `storage.get/put`, alarms, and WebSocket hibernation
as Effects.

Amends [0023](0023-live-views-sse-livedo.md) and
[0025](0025-split-livedo-connection-topic.md): only the DO authoring model changes.

## Decision

Port both DOs to the Effect DO model.

- **Named RPC replaces fetch-path dispatch.** `register`, `publish`, `deliver`,
  `probe` (etc.) become typed methods on the stub instead of `url.pathname`
  branches — deleting the manual routing and the request/response (de)serialization.
  `fetch` is reserved for genuinely request-shaped interactions (the SSE upgrade
  on `ConnectionDO`).
- **`state.storage.sql.exec<Row>(...)`** backs `TopicDO`'s subscriber registry.
- **`TopicDO` resolves `ConnectionDO` with `yield* ConnectionDO`** in its shared
  init and fans out via `connections.getByName(id).deliver(frame)`. The cross-DO
  direction stays binding-enforced — a namespace cannot resolve its own kind, so
  topic→topic and connection→connection calls don't type-check.
- **`ConnectionDO` holds its SSE stream's controller in the per-instance closure**
  (where instance fields lived) and returns the stream via `HttpServerResponse.fromWeb`.

The connection/topic split, SSE transport, generation-based stale detection, and
the alarm reap are **unchanged** — only the authoring model (Effect DOs + typed RPC
vs. raw classes + path dispatch) changes.

## Consequences

- **Easier:** typed cross-DO RPC; one Effect idiom across the whole backend; far
  less hand-rolled request routing and JSON in the DOs.
- **Partially spike-verified** (alchemy `2.0.0-beta.44`, effect `4.0.0-beta.70`)
  under `alchemy dev`'s local runtime: the **topic→connection fan-out**,
  **`state.storage.sql`**, and **held-stream delivery** (enqueueing into a stream
  held in one DO from another DO's RPC) all work — subscribe → publish → the frame
  arrived on the held SSE stream.
- **Risk — unverified, needs a spike:** the **bidirectional DO↔DO binding**
  (connection↔topic — phoenix needs the reverse `ConnectionDO`→`TopicDO` leg for
  subscribe→register, a circular binding with no precedent in the alchemy examples)
  and **name-based addressing** (`getByName` only; `idFromName`/`idFromString`/`get`
  are unavailable on the alchemy stub, so the `generation` stale-detection invariant
  must be re-confirmed) were **not** spiked. Spike both in the modular `.make()` form
  before treating the port as proven.
- **Constraint:** the **modular `.make()` form is required** because the two DOs
  reference each other — the class (identifier) must stay separate from `.make()`
  (impl) so neither DO pulls the other's runtime into its bundle.
- **Cost:** the DOs move into the alchemy resource graph — they are no longer plain
  classes.
- See [alchemy-durable-objects.md](../.patterns/alchemy-durable-objects.md) and the
  umbrella [0026](0026-adopt-alchemy-effect-infra.md).
