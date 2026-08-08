# fabrika wire formats — the index

A **wire format** is the byte-level agreement two fabrika skills meet through on a GitHub artifact.
This page is the map of them: for each registered format, its owner module, who writes those bytes
and who reads them, and why the two sides need an agreement at all.

It is a map, never the territory. **The shape lives in the owner module and is cited here, never
restated** — no fields, no example bytes, no heading spellings, no exit codes. A shape copied into
prose is the v1 failure this whole arrangement replaces, and it drifts silently the first time the
module moves. Where you want the shape, open the module. The *why* lives in ADR
[0241](../../../.decisions/0241-wire-formats-owned-by-schema-modules.md), which this page points at
rather than re-derives, per [`README.md`](README.md).

The **live** list is the registry itself —
[`packages/fabrika-cli/src/wire/registry.ts`](../../../packages/fabrika-cli/src/wire/registry.ts),
one row per format — and `fabrika wire formats` projects it at runtime
([`wire/command.ts`](../../../packages/fabrika-cli/src/wire/command.ts)). Run that verb when you need
the current inventory; read this page when you need to know what the agreement is *for*. If the two
ever disagree, the registry is right and this page is the doc to fix.

## The staging rule — an unwritten format is not a missing one

Formats arrive **with their first consumer**, never in a batch. Two are here because the `review`
authoring session had to derive its contract against both at once: the format it grades a PR
against, and the one it emits. Every later format lands when the skill that first reads or writes it
is authored. So a format you cannot find below is almost certainly *unwritten* — its consumer does
not exist yet — rather than missing; check the registry before assuming a gap.

## Registered formats

### `acceptance-criteria`

- **Owner module:** [`packages/fabrika-cli/src/wire/acceptance-criteria.ts`](../../../packages/fabrika-cli/src/wire/acceptance-criteria.ts)
- **Producers:** `triage`, `build-epic` · **Consumers:** `build`, `review`

This is the checkbox contract a gate grades a PR against, carried on the sub-issue body. The two
sides never meet: the skill that writes the criteria has long finished by the time a gate reads them
back, and the only thing connecting them is the block's placement in a body neither one owns
outright. That is exactly the seam an agreement is for. The producer touches it once, at intake or
at decomposition; the consumers touch it twice more, when a coder builds to it and when a reviewer
grades against it. Drift here is worse than loud failure — a block that has shifted out of
recognition reads back as *a body with no criteria*, which is byte-identical to a body that
genuinely has none, so a grader scores against nothing and passes. Reading through the owner module
is what keeps a drifted block reportable as a defect instead of arriving as a plausible empty
answer.

### `verdict-marker`

- **Owner module:** [`packages/fabrika-cli/src/wire/verdict-marker.ts`](../../../packages/fabrika-cli/src/wire/verdict-marker.ts)
- **Producers:** `review` · **Consumers:** `build`, `ship`

This is the first line of a gate's verdict comment on a PR, and the artifact the merge decision
rests on. A gate writes it once, when it finishes reviewing; a repairing coder reads it to learn
whether it owes a fix, and a shipper reads it to learn whether it may merge. The agreement has to
carry more than the outcome, because a verdict attests the exact tree it was formed over — so the
head the reviewer inspected is bound into the marker, and a marker bound to a head that has since
moved is stale rather than passing. Drift costs both directions: a marker the readers cannot
recognise makes a reviewed PR look unreviewed and stalls it, while one whose binding is lost would
let a stale approval carry an unreviewed tree through a merge. The module owns the composing and the
reading, including the staleness question; the skills keep the judgement of when to flip a verdict.

## Adding a format

A new format lands as a sibling schema module plus one registry row — never as a branch inside a
verb, and never as a paragraph in a skill body. Add its entry here at the same time, in the shape
above: owner module, producers and consumers, one paragraph of protocol narrative. The interface and
totality law the module meets are stated once in ADR
[0241](../../../.decisions/0241-wire-formats-owned-by-schema-modules.md) and typed in
[`wire/format.ts`](../../../packages/fabrika-cli/src/wire/format.ts).
