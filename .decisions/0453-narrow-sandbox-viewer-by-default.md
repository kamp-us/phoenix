---
id: 0453
title: A resolver's sandbox viewer is narrow by default, and a read requests the in-place widening by name
status: accepted
date: 2026-10-04
tags: [sozluk, pano, search, security]
---

# 0453 — A resolver's sandbox viewer is narrow by default, and a read requests the in-place widening by name

**What this decides:** a read shows çaylak content to an opted-in yazar only when its resolver asks
for that view by name; the viewer a resolver gets without asking never shows it.

## Context

Çaylak content is held out of public view until it is promoted. ADR
[0206](0206-caylak-containment-over-pagination-truncation.md) ruled that this containment outranks a
pagination nicety. [#6423](https://github.com/kamp-us/phoenix/issues/6423) then added a third viewer
class: a yazar who opts in sees çaylak content in place, carried on the viewer as
`seesSandboxedInPlace`. [#6424](https://github.com/kamp-us/phoenix/issues/6424) wired that viewer
through the pano and sözlük reads and kept it out of search, because search ranks over a corpus and
would surface the content out of context.

#6424 kept search narrow with an opt-out. Every resolver read `currentSandboxViewer`, which carried
the widening, and search alone passed it through `withoutInPlaceVisibility`. The mask cannot tell a
term page from a ranked search, so the only thing separating the two was whether the resolver's
author remembered that call. The next discovery surface would start from the same line every other
resolver uses and be wide, and the failure would be silent, since a wider read returns more rows
rather than an error. [#6467](https://github.com/kamp-us/phoenix/issues/6467) put the question to
the founder.

Founder ruling, 2026-08-20, recorded on
[#6467, comment 5363122857](https://github.com/kamp-us/phoenix/issues/6467#issuecomment-5363122857),
as the issue quotes it:

> #6467 Çaylak widening is opt-out: Yes — wide view must be explicitly requested

This record is that ruling written down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). The ruling picked the direction. The
mechanism below is the build's, chosen as the smallest one that meets it.

## Decision

**`currentSandboxViewer` resolves `seesSandboxedInPlace: false` for every viewer, and
`currentInPlaceSandboxViewer` is the one export that can resolve it `true`.**

- **The default is narrow.** `currentSandboxViewer` in
  [`apps/web/worker/features/kunye/sandbox.ts`](../apps/web/worker/features/kunye/sandbox.ts) keeps
  the viewer's identity and moderator authority and drops the in-place widening, for an opted-in
  yazar with `phoenix-caylak-visibility` on as for everyone else.
- **The widening is requested per call site.** A resolver that serves an in-place read takes
  `currentInPlaceSandboxViewer`. Grepping that name lists every widened read.
- **`withoutInPlaceVisibility` is deleted.** With a narrow default there is nothing to opt out of.
  Search takes the default and makes no narrowing call of its own.
- **The reads that had the widening keep it.** Every pano, sözlük and pasaport call site that read
  the wide viewer before this record now requests it by name. No read changes what it returns.
- **Both paths read one resolution.** They share the per-request memo, so a request that mixes them
  still resolves the moderator probe, the tier and the opt-in once.

**Binding constraints.**

- A new discovery surface (search, browse, trending, recommendation) takes `currentSandboxViewer`.
- `currentInPlaceSandboxViewer` is taken only where a row is met where it lives, and by the
  re-read of a mutation over such a row.
- The moderator axis stays separate. `canSeeSandboxed` is not merged into the in-place axis, and
  `moderatorSandboxViewer` keeps `seesSandboxedInPlace: false`.
- The SQL mask rule does not move. This record changes which viewer reaches it.

**Banned.**

- A helper that narrows a wide viewer after the fact.
- A second export that resolves the widening.

## Consequences

**Forgetting is safe.** A resolver written from the plain line is narrow, so the next discovery
surface contains çaylak content without anyone remembering anything.

**The failure flips to the visible side.** An in-place read that forgets to ask shows an opted-in
yazar less than they expect. That is a missing row someone reports, where the old failure was
newcomer content surfacing out of context with no error.

**The types do not enforce it.** Both paths return the same `SandboxViewer`, so a discovery
resolver can still import the widening by name. The name and the grep are the control. A distinct
type for the widened viewer would close that, and it is not part of this record.

## Records

- References [#6467](https://github.com/kamp-us/phoenix/issues/6467) and its ruling comment.
- Containment lineage: [#6423](https://github.com/kamp-us/phoenix/issues/6423),
  [#6424](https://github.com/kamp-us/phoenix/issues/6424), ADR
  [0206](0206-caylak-containment-over-pagination-truncation.md).
- The rule a resolver author reads is in
  [`.patterns/caylak-content-containment.md`](../.patterns/caylak-content-containment.md).
- No vocabulary impact: no term is coined or redefined.
