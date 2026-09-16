---
id: 0395
title: A graph route compiles on payload fit, and on kind only where there is no payload to read
status: accepted
date: 2026-09-15
tags: [tuval, ports, authoring, routes, schema]
---

# 0395 — A graph route compiles on payload fit, and on kind only where there is no payload to read

**What this decides:** `resolveRoute` (`apps/tuval/src/ports/compile.ts`) decides a route by
comparing the two ends' published payload schemas with the same `payloadFits` that decides whether
a program fills a `Program.shape` arg. Kind equality is the rule only when one of the two ends
publishes no schema. Fit is exact structural equality — the same relation, not a looser cousin of
it.

Direction recorded by the other maintainer on
[#8923](https://github.com/kamp-us/phoenix/issues/8923#issuecomment-5690072649) (2026-09-15),
following the founder's ruling on the same issue
(<https://github.com/kamp-us/phoenix/issues/8923#issuecomment-5625310635>, 2026-09-10 PT: "rec
(yes)" to "should a route between two programs be checked by comparing the two ports' payload
shapes, instead of requiring their name strings to match exactly").

## Context

`apps/tuval/src/authoring/port.ts` mints an authored port's kind as `` `${program}/${name}` ``, on
purpose: a port carries no version of its own (#8716 R13.1), so the program id is the whole
namespace. `resolveRoute` required the two ends' kinds to be equal. Together those two facts made
every authored-to-authored route in a config graph impossible — `desk/pr` can never equal
`pr-review/pr` — and there was no authoring vocabulary for saying "this port is the same kind as
that one". Two `defineProgram` programs in one graph is the ordinary case, and it failed at compile,
before boot, with no remedy an author could reach.

It also split the layer's compatibility story in two. `Program.shape` fits by payload and never by
version; a spawned child and a graph route are the two ways programs meet, and only one of them
kept that promise.

The issue named the objection to fixing it structurally: `accepts` is an opaque predicate and two
predicates cannot be compared. [#8959](https://github.com/kamp-us/phoenix/issues/8959) removed that
objection by putting `schema` beside `accepts` on every compiled port and giving the shipped
ai-agent rows theirs; [#8887](https://github.com/kamp-us/phoenix/issues/8887) had already built the
comparison itself.

## Decision

1. **Both ends publish a schema: the route compiles iff the payloads fit.** The relation is
   `payloadFits`, moved from `apps/tuval/src/authoring/shape.ts` to
   [`apps/tuval/src/registry/payload-fit.ts`](../apps/tuval/src/registry/payload-fit.ts) so the two
   slices that ask it share one implementation rather than two that could drift.
   `shape.ts` re-exports it and its behaviour is unchanged.
2. **Fit is exact structural equality over the canonical JSON Schema.** Not assignability, not
   width subtyping, not "the source has at least the target's fields". One meaning of "fits" across
   a spawn-arg and a route (R13.1), because those are the same promise made at two call sites.
3. **Either end publishes no schema: the kinds must be equal, exactly as before.** A hand-written
   row (`apps/tuval/src/ai-agent/ports/ports.ts`) has a predicate and no schema behind it; its
   routes are nominal and keep working untouched. This is a fallback for rows that cannot answer the
   structural question, not a second way to answer it.
4. **`IncompatibleRoute` carries a `reason`.** Either `kinds differ, no schema to compare: …` with
   both kinds, or `payload does not fit: at .properties, desk.pr carries {…} where pr-review.pr
   accepts {…}` — the first differing path in the canonical form, so the author sees which side to
   change instead of diffing two generated schema documents by eye.
5. **`CompiledRoute.kind` is the target's.** A structural route's two ends carry different kinds.
   The kind is read in exactly one place downstream — the `PayloadRejected` a delivery raises, which
   names the target end — so the target's is the honest one. For a route that compiled on kind
   equality it is both.

## Alternatives rejected

- **The issue's option 2, a `definePort` equivalent for authors.** Smaller, and it is what the
  hand-written rows do. It adds a second naming system beside `portKind`, which `port.ts`'s docblock
  deliberately kept out, and it leaves the split with R13.1 open: a shared kind is a name two
  authors agreed on, which is the version-flavoured coordination the epic exists to remove. The
  issue itself says a fix "probably wants" to be structural.
- **Assignability — the source fits if it carries at least what the target accepts.** This is the
  rule that would make `TurnResult{text, items, ok}` route into a port accepting `{text}`, and it is
  tempting for exactly that reason. Refused: `payloadFits` means exact equality today, so
  introducing assignability for routes alone creates a second compatibility relation with no owner
  and two different answers to "does this fit" depending on which call site asks. If Tuval wants a
  subtyping story, it is one decision covering both, argued on its own ticket — not a side effect of
  this one. The consequence is real and named below.
- **Kind equality *or* payload fit, whichever passes.** Strictly more permissive than today, so
  trivially backward compatible. Refused because it keeps the nominal check alive as a live rule
  rather than a legacy fallback, and a kind that agrees while the payloads do not is a route that
  will fail at the first delivery. Where a schema exists it is the more truthful of the two, and it
  decides.

## Consequences

- **Two authored programs route.** `apps/tuval/src/authoring/reload/fixtures/reviewing-desk.ts`'s
  `desk` and `sink` were plain rows hand-writing `pr-review`'s own kinds. They are `defineProgram`
  programs now, declaring only what they carry, and the fixture spells no kind at all.
- **A route whose payloads genuinely do not fit still refuses at compile**, now with the payload
  difference in the message rather than two kind strings that were never going to match.
- **`@cansirin/tuval-cron` → `@cansirin/tuval-notify` does not fit under this rule**, and that is
  the honest answer rather than a reason to widen it. `brief` carries `TurnResultSchema`
  (`{text, items, ok}`); a `message` in-port declared `Schema.Struct({text: Schema.String})` is a
  different payload. The consumer declares `message` over `TurnResultSchema`, or the emitter narrows
  what it announces. Either is one line, and both leave one meaning of "fits" in the tree.
- **A row publishing a schema on one end and not the other is decided nominally.** That is every
  two-way ai-agent kind today (`transcript-page`, `permission`, `mode`), whose tagged unions have no
  schema written yet. Nothing about their routing changes.
- **A hypothetical pair whose kinds agree while their schemas do not would now refuse.** No such
  pair exists in the tree — an ai-agent `PortEnd` publishes one schema that both of its ends carry —
  and `apps/tuval/src/ports/compile.unit.test.ts` holds the rule explicitly so the case is decided
  rather than discovered.
