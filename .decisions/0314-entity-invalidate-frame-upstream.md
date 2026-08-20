---
id: 0314
title: fate-live gains an entity-level invalidate frame, and its client handler lands upstream in fate
status: accepted
date: 2026-08-20
tags: [fate, live, protocol, dependencies]
---

# 0314 — fate-live gains an entity-level invalidate frame, and its client handler lands upstream in fate

**What this decides:** a client holding a row through an entity subscription gets a way to be told
"re-read this row", the same way a connection subscriber already does, and the client half of that
is written in fate itself rather than patched into phoenix's copy of it.

## Context

A viewer-derived field cannot ride a live payload: the true new value differs per reader, so a
viewer-blind broadcast may not carry it and omitting the key preserves each subscriber's stale value
([`.patterns/fate-live-consistency.md`](../.patterns/fate-live-consistency.md#entity-frames-merge-whole)).
The honest repair is to make the subscriber read again. For a connection subscriber that repair
exists — `ConnectionFrame` carries `{type: "invalidate"}` and fate answers it by dropping the
connection and calling `loadConnection` again.

For an entity subscriber it does not exist, at either end of the wire:

- `EntityFrame` in [`protocol.ts`](../apps/web/worker/features/fate-live/protocol.ts) is exactly two
  variants, `{delete: true, id}` and `{data, select?}`. `live-publisher.ts` mirrors that — it builds
  entity frames for `update` and `delete` only, and `invalidate` exists solely on the topic builder.
- fate's own entity path has no invalidate arm either. Verified against the pinned
  `@nkzw/fate@1.3.1`: `LiveEventHandlers` is `{onData, onDelete?, onError?}`, `Transport.subscribeById`
  takes those handlers, and the SSE reader dispatches an entity message to `onDelete` when the body
  carries `delete` and to `onData` otherwise. `{type: "invalidate"}` appears only on
  `LiveConnectionEvent`. The store already has the machinery — `ViewDataCache.invalidate(entityId)`
  walks dependents — it is simply unreachable from a live entity event.

So the çaylak→yazar promotion repairs connections and nothing else. `publishPromotion` in
[`promote-live.ts`](../apps/web/worker/features/pasaport/promote-live.ts) invalidates the feed topic,
each swept comment's `Post.comments` thread and each swept definition's `Term.definitions` term, and
a post held through `subscribeById` — the detail page — sits in no connection, re-reads nothing, and
keeps a `sandboxedInPlace: true` that is now false until the reader navigates away and back
([#6565](https://github.com/kamp-us/phoenix/issues/6565)).

The fork was put to the founder as [#6589](https://github.com/kamp-us/phoenix/issues/6589), and it
was ruled twice on 2026-08-20. The first ruling took **Fork B — accept the documented limit**
([comment 5359042896](https://github.com/kamp-us/phoenix/issues/6589#issuecomment-5359042896)),
re-typed the issue to `type:chore` and scoped it to writing the limit down. The second ruling
replaced it with **Fork A** ([comment 5360552228](https://github.com/kamp-us/phoenix/issues/6589#issuecomment-5360552228)),
and that is the one this record transcribes per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). Fork B no longer holds because its whole
premise was that the cost bought one page: the second ruling weighs the same change as a *missing
primitive* instead, so the thing being bought is every future viewer-derived field, not the detail
page's marker. The accepted-limit note Fork B asked for must not be written.

This is a platform call, engineering-led under ADR
[0078](0078-product-driven-decisions-by-default.md), and it was taken by the founder because the
blast radius reaches every entity subscription. Nothing here is user-facing on landing:
`phoenix-caylak-visibility` serves off in production, verified live 2026-08-20, until the founder
flips it.

## Decision

**An entity subscription gets an invalidate path, because a subscriber with no way to be told to
re-read is a hole in the substrate rather than a defect on one page.**

- **`EntityFrame` gains a third variant.** The wire says "this row moved, ask again" for an entity
  exactly as `ConnectionFrame` already says it for a connection, and `WorkerLivePublisher` gains the
  entity-side `invalidate` beside its `update` and `delete`. The `LiveDO` relay carries it: the DO
  buffers and fans a `DeliverFrame` without inspecting the event body, so this is a frame the
  publisher and the client must both learn, not a new fan-out mechanism.
- **The client handler lands upstream in fate.** fate is the founder's own library, so its entity
  path gains an invalidate handler in fate's own source: `subscribeById` re-`fetchById`s the entity
  **against the subscriber's own viewer**, which is the property that makes an invalidation an
  honest repair for a viewer-derived field and a payload a dishonest one.
- **`publishPromotion` invalidates swept rows, not only swept topics.** `SandboxSweep`
  ([`sandbox-sweep.ts`](../apps/web/worker/features/pasaport/sandbox-sweep.ts)) carries topics and no
  row ids at all, and `readSandboxSweep` discards ids deliberately — its post query is a `limit(1)`
  existence check, and its comment and definition queries select the parent topic key rather than the
  row. Fork A widens that shape. The pre-batch capture is unchanged and load-bearing: after the batch
  `sandboxed_at` is null and a swept row is indistinguishable from one the author already had live.
- **This decision issue builds none of it.** The construction lands in three filed slices — the
  frame and its relay ([#6662](https://github.com/kamp-us/phoenix/issues/6662)), the upstream fate
  handler ([#6661](https://github.com/kamp-us/phoenix/issues/6661)), and the `publishPromotion`
  caller ([#6663](https://github.com/kamp-us/phoenix/issues/6663)) — and the fate slice ships first:
  the two phoenix slices cannot fully land until the upstream handler is released and phoenix's
  `@nkzw/fate` pin moves.

**Binding constraints.**

- **An entity invalidation carries no viewer-derived data.** It says re-read and nothing else. A
  frame that grew a payload to save a round trip would reintroduce exactly the broadcast this
  decision exists to avoid.
- **ADR [0038](0038-dependency-patches-local-only.md) still governs how phoenix consumes the fate
  change.** phoenix's build resolves against a released fate version or an in-repo `pnpm patch`,
  never a fork branch, a git dependency or an unmerged upstream PR. "Upstream rather than vendored"
  names where the handler is *authored and owned* — it does not license phoenix to depend on
  in-flight upstream state, and it does not decide whether a local patch bridges the wait, which is
  0038's existing order of preference to apply.
- **`phoenix-caylak-visibility` is not flipped by any slice.** The flag's serving state is the
  founder's, per its own release flow; a slice that lands the primitive still lands dark.

## Consequences

Easier: the next viewer-derived field that changes server-side has a seam to change through. Today
the answer is per-field and there is no honest one for an entity subscriber at all; after this there
is one repair — invalidate, re-read, re-derive — and it reads the same at both subscription shapes.
`ViewDataCache.invalidate` stops being machinery nothing on the wire can reach.

Harder: the work is cross-repo, so a phoenix slice's completion now depends on a fate release
landing, and the pin move is a step in the middle of a feature rather than routine maintenance.
Every entity subscription is in the blast radius of the fate change, which is why the client half is
written where its own tests live rather than in a patch phoenix reviews alone.

The Fork B outcome is spent work: [`.patterns/fate-live-consistency.md`](../.patterns/fate-live-consistency.md#viewer-derived-transitions)
already states the entity-subscriber gap honestly and points at #6565, so it needs no edit for the
retraction — but it will need one when the slices land, since the seam it describes as
connection-only stops being so.

## Records

No `.glossary/TERMS.md` row: the frame vocabulary is defined with the protocol type in
[`protocol.ts`](../apps/web/worker/features/fate-live/protocol.ts), following the same placement as
`ConnectionFrame`'s existing `invalidate`.

Sources: the founder ruling at
[#6589, comment 5360552228](https://github.com/kamp-us/phoenix/issues/6589#issuecomment-5360552228),
superseding [comment 5359042896](https://github.com/kamp-us/phoenix/issues/6589#issuecomment-5359042896);
[#6565](https://github.com/kamp-us/phoenix/issues/6565);
`@nkzw/fate@1.3.1`'s `Transport`/`LiveEventHandlers` declarations and its SSE entity dispatch;
[`protocol.ts`](../apps/web/worker/features/fate-live/protocol.ts),
[`live-publisher.ts`](../apps/web/worker/features/fate-live/live-publisher.ts),
[`live-do.ts`](../apps/web/worker/features/fate-live/live-do.ts),
[`promote-live.ts`](../apps/web/worker/features/pasaport/promote-live.ts),
[`sandbox-sweep.ts`](../apps/web/worker/features/pasaport/sandbox-sweep.ts),
[`Pasaport.ts`](../apps/web/worker/features/pasaport/Pasaport.ts).
