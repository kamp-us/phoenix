---
id: 0391
title: A Tuval hand-verification binds the ui files' content, never the record's own head
status: accepted
date: 2026-09-11
tags: [fabrika, review-ui, tuval, pipeline, governance]
---

# 0391 — A Tuval hand-verification binds the ui files' content, never the record's own head

**What this decides:** under the interim Tuval `review-ui` exception, the builder's hand-verification
stays current across commits as long as no `ui`-class file changed between the head it ran at and the
head the `routed-elsewhere` record binds. `review-ui route` enforces that; no gate judges it by eye.
Founder ruling on [#8703](https://github.com/kamp-us/phoenix/issues/8703), 2026-09-10:
[the ruling comment](https://github.com/kamp-us/phoenix/issues/8703#issuecomment-5625303347), filled
in by [the driver note](https://github.com/kamp-us/phoenix/issues/8703#issuecomment-5628378239) under
the standing delegation of founder ruling #8807 R4.1.

## Context

The 2026-09-06 interim exception on [#7306](https://github.com/kamp-us/phoenix/issues/7306) lets a PR
whose `ui`-class files all sit under a Tuval `uiSurfaces` prefix resolve the `review-ui` namespace
with a `routed-elsewhere` record instead of a rendered verdict, on the condition that the builder
posted a hand-verification — a scratch desk run with timings, or a screenshot in the PR body.
`apps/tuval` deploys to no preview ([0345](0345-tuval-lives-under-apps.md)), so there is no address
at which the reviewer can render it, and the hand-verification is the whole of the evidence standing
in for the render.

The two halves of that condition bound different things. The record is head-bound: `runRoute` in
[`route-verb.ts`](../packages/fabrika-cli/src/review-ui/route-verb.ts) refuses on `STALE_TREE` unless
`--sha` matches the live head, and reads the posted record back to confirm the sha it carries. The
hand-verification was bound to nothing at all. The condition's text names no head, and `runRoute`
reads the hand-verification nowhere.

PR #8449 is what that cost. The hand-verification ran at `8efd315a`; the record bound `fb01065b`. One
commit apart, and it moved two rendered readouts of the exact surface the record stood in for — the
doubling usage header ([#8695](https://github.com/kamp-us/phoenix/issues/8695)) and the cut reply row
now carrying `interrupted: true` ([#8693](https://github.com/kamp-us/phoenix/issues/8693)). Neither
rendered state was hand-verified at any head. What made the record postable was a check that gate
invented for itself: that `8efd315a..fb01065b` touches nothing under `apps/tuval/src/agy/window/` or
`apps/tuval/src/page/`, so the composition is byte-identical. No verb asked for it, and the next gate
had to invent it again.

The failure is quiet. The `routed-elsewhere` format carries no polarity and no attached captures, so
a record backed by current evidence and one backed by stale evidence read identically, and `ship
gate` resolves both as `routed`. The exception is running hot — #7306's sunset list is past 60
entries — and a repair round is both when the window reopens and when the rendered surface is most
likely to have moved.

## Decision

**A hand-verification is current when no `ui`-class file changed between its head and the record's,
so a commit that moves no rendered surface does not void it.**

1. **The condition, stated so a reader can check it.** Take `H`, the head the hand-verification ran
   at, and `R`, the head the `routed-elsewhere` record binds. The hand-verification stands for `R`
   exactly when no file changed in `H..R` satisfies `isUiSurface` over this repo's declared
   `uiSurfaces` prefixes — the same predicate
   ([`classes.ts`](../packages/fabrika-cli/src/review/classes.ts)) that raised the `ui` class and that
   `review-ui route` already re-uses. Otherwise the evidence is spent and a fresh desk run is owed.
   A reader holding the PR and the record needs the two heads and that one range, and nothing else.
2. **The hand-verification states its own head.** Evidence that does not name the tree it was taken
   at cannot be compared to anything, and the near-miss above is what an unnamed head looks like when
   someone finally goes looking.
3. **`review-ui route` enforces it, not the gate's own reading.** The verb takes the
   hand-verification's head as an operand and refuses when the range to the record's sha raises the
   `ui` class. A condition each gate re-derives is a condition each gate can re-derive differently,
   and the one gate that derived it did so by hand with no verb asking. The implementation is
   [#9178](https://github.com/kamp-us/phoenix/issues/9178); until it lands, the condition binds the
   gate as written text on #7306 rather than as a mechanical refusal.
4. **The record's own head binding is untouched.**
   [0316](0316-a-gate-records-that-it-owes-no-verdict.md)'s "head-bound, never content-bound" governs
   the `routed-elsewhere` record, and it still does: every push voids the record and the new tree is
   attested afresh. This decision governs only whether the evidence the record rests on is still
   evidence of the tree being attested.
5. **The exception's text carries the condition.** It lands on #7306 as a dated amendment below the
   2026-09-06 ruling, never as an edit to it, because the tracker keeps no body history and the
   sunset list has to stay readable against the text each entry was posted under.

**Rejected: binding the hand-verification to the record's own head.** It is the simpler sentence and
the cheaper check, and it throws away good evidence on every commit that changes no rendered
surface — a docs-only commit, a fabrika-side fix, a rebase. The cost lands as a full desk session per
repair round, which is the price that gets a hand-verification skipped altogether; #8449 reached a
gate carrying none.

**Sunset.** This decision lives exactly as long as the exception it conditions. When #7306 lands a
trusted evidence path and the exception ends, this record is retired with it rather than left
standing as law over a route nobody takes.

## Consequences

- A Tuval PR that rebases, or lands a commit outside the declared prefixes, keeps its
  hand-verification. Repair rounds on those PRs stop owing a desk run they gain nothing from.
- A Tuval PR whose repair round touches a declared prefix owes a fresh hand-verification at the new
  head, and #9178 will refuse the route until it has one.
- Every hand-verification posted from here names the head it ran at. One that does not cannot be
  checked against this condition, and a gate reading one treats the record as unsupported.
- Until #9178 lands, a gate still checks the range by hand — but against a stated condition rather
  than one it invents, and two gates now answer the same way.
- The sunset list on #7306 gains a fact worth carrying per entry: the hand-verification's head beside
  the record's, so the first real Tuval UI review can see which entries rested on a range and which
  on an exact head.

## Records

no vocabulary impact
