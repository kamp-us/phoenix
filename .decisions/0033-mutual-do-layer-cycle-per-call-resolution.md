---
id: 0033
title: Co-hosted mutual DOs cannot Init-bind each other — use per-call sibling resolution
status: accepted
date: 2026-05-29
tags: [durable-objects, alchemy, effect, layer, live]
---

# 0033 — Co-hosted mutual DOs cannot Init-bind each other — use per-call sibling resolution

## Context

phoenix's live fan-out is two co-hosted Durable Objects with a bidirectional
RPC edge ([0025](0025-split-livedo-connection-topic.md)): `ConnectionDO` resolves
`TopicDO` to register/deregister, and `TopicDO` resolves `ConnectionDO` to
deliver/probe. On the inline DO form (beta.44, [0028](0028-effect-durable-object-model.md))
the rule was *symmetric-lazy* — never `yield* OtherDO` in init, always inside
the RPC method body — because an eager pair OOM-ed the build.

The [0032](0032-alchemy-beta45-and-dev-model.md) upgrade introduces the
modular `.make()` Layer form for DOs. That form retires the `as never`
sibling-cast (the class Tag is split from the implementation Layer, so Layers
can compose cleanly), and the natural question is whether the sibling DO can
now be resolved in shared init — i.e. whether the per-call rule is still
needed. A spike on `2.0.0-beta.45` confirmed the rule stands, for a different
reason: the constraint is no longer build-time OOM, it is the Effect Layer
type system.

## Decision

When two co-hosted Durable Objects reference each other, the sibling DO is
resolved **per RPC call** (`Effect.map(SiblingTag, s => s.getByName(...))` or
`yield* SiblingTag` inside the method's `Effect.gen`), **never** in the shared
init of `.make()`. This is the same rule [0028](0028-effect-durable-object-model.md)
recorded for the inline form, restated against the new mechanism.

## Rationale — verified against the Layer type signatures

`Cloudflare.DurableObjectNamespace<Self, Shape>()("Name") {}` produces a class
whose `.make()` has signature (verbatim from alchemy's
`lib/Cloudflare/Workers/DurableObjectNamespace.d.ts`):

```
make<InitReq = never>(
  impl: Effect.Effect<
    Effect.Effect<Shape, never, DurableObjectServices>,
    never,
    InitReq
  >,
): Layer.Layer<Self, never, Worker | Exclude<InitReq, DurableObjectServices>>
```

where `InitReq` is the requirement set produced by yielding inside the outer
init Effect, and `DurableObjectServices = DurableObjectNamespace |
DurableObjectState | WorkerServices | WorkerEnvironment | PlatformServices`.
The `Exclude<InitReq, DurableObjectServices>` clause erases the DO-side
context services (`DurableObjectState`, the per-instance worker env, etc.)
that alchemy injects automatically — but it does **not** erase a sibling DO
class Tag. Each `Cloudflare.DurableObjectNamespace<Self, Shape>()("Name")`
class carries distinct `Context.Tag` identity (its `Self` type parameter) and
does not structurally extend the bare `DurableObjectNamespace` shape that the
`DurableObjectServices` union covers.

So if `ConnectionDOLive` resolves `TopicDO` in init, its Layer type carries
`TopicDO` in the requirements:

```
ConnectionDOLive: Layer<ConnectionDO, never, Worker | TopicDO>
TopicDOLive:     Layer<TopicDO, never, Worker | ConnectionDO>
```

`Layer.mergeAll(ConnectionDOLive, TopicDOLive)` then produces:

```
Layer<ConnectionDO | TopicDO, never, Worker | ConnectionDO | TopicDO>
```

— the cycle leaks unresolved into the requirements channel; the worker Layer
can't satisfy `ConnectionDO` and `TopicDO` from itself without circularity.
`Layer.provide` doesn't break it either (provide is one-directional).

The per-call resolution pushes the sibling Tag into the **RPC method's** `R`
channel instead, where alchemy satisfies it from the DO's own captured
services at invocation. The Layer requirements stay clean.

## `precreate` does NOT fix this

alchemy's `precreate` mechanism — described in the alchemy team's
"Circular references, without the deadlock" blog post — solves the
**deploy-time identifier reservation deadlock**: two resources that need each
other's stable IDs at creation time can reserve their IDs in pass 1 and wire
the cross-references in pass 2. That is unrelated to the Effect Layer
type-level cycle this ADR is about. The two problems get confused because
both involve circularity:

| problem | layer | what it is | what fixes it |
|---|---|---|---|
| Resource ID deadlock | alchemy reconcile | A's create needs B's id, B's create needs A's id | `precreate` two-pass planning |
| Layer requirements cycle | Effect runtime composition | `Layer<A, _, B>` + `Layer<B, _, A>` doesn't compose | Per-call resolution (push the Tag into method `R`) |

`precreate` is necessary for the cross-DO bindings to deploy at all (alchemy
needs both DO names reserved before either Worker class is created). It is
not sufficient to let init-time `yield* OtherDO` compose.

## Consequences

- **The pattern stays.** Both DOs keep the per-call `yield* TopicDO` /
  `yield* ConnectionDO` inside RPC methods (`subscribe`/`unsubscribe` on
  `ConnectionDO`; `publish`/`alarm` on `TopicDO`). The class-header docstring
  in each file records this rule for future agents.
- **Escape hatches that don't apply here.**
  - `Counter.from(WorkerA)` cross-script DO binding sidesteps the cycle by
    reference-by-script-name, but only for DOs hosted on **different** Workers.
    phoenix's live fan-out is co-hosted on one Worker; cross-script binding
    isn't an option without splitting the Worker.
  - Breaking the cycle architecturally (one-directional fan-out) — possible
    in principle (e.g. the topic owns the connection list and writes through
    a single queue), but inverts the connection-owns-stream invariant
    [0025](0025-split-livedo-connection-topic.md) is built on. Not pursued.
- **`Init`-bound siblings stay a type error.** The Layer signature is the
  guard: an accidental `yield* TopicDO` in `ConnectionDOLive`'s init reveals
  itself as a Layer requirement that won't compose against `TopicDOLive`'s
  mirror. The type system is the enforcement; no runtime check needed.
- See [alchemy-durable-objects.md](../.patterns/alchemy-durable-objects.md)
  (the per-call rule), [0028](0028-effect-durable-object-model.md) (the
  inline-form precedent), and [0032](0032-alchemy-beta45-and-dev-model.md)
  (the `.make()` upgrade that retired the sibling cast but not this rule).
