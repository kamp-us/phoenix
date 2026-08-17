---
id: 0288
title: A wire producer runs its consumer's reader before posting, refusing anything but Found
status: accepted
date: 2026-08-17
tags: [fabrika, pipeline, cli, contracts]
---

# 0288 — A wire producer runs its consumer's reader before posting, refusing anything but Found

**What this decides:** Any fabrika verb that writes a machine-read wire section must run that
section's consumer-side `read` over the exact bytes it is about to post, and refuse to post when
the answer is not `Found` — so a section a gate would later reject can never reach the board.

Founder ruling on [#5735](https://github.com/kamp-us/phoenix/issues/5735) (2026-08-16, in
session): accepted.

## Context

ADR [0241](0241-wire-formats-owned-by-schema-modules.md) moved every wire format's grammar into a
typed schema module with a total `read` (`Found` / `Absent` / `Malformed`), registered as one row
in [`packages/fabrika-cli/src/wire/registry.ts`](../packages/fabrika-cli/src/wire/registry.ts).
That fixed who *owns* the bytes. It left open who *checks* them at write time: the producing verbs
composed their sections from prose instruction and posted them unread, while the consuming gates
ran the strict reader a review round later.

The asymmetry was measured, not hypothetical. Every review FAIL on 2026-08-16 was wire grammar,
none were substance: the acceptance-criteria heading defect four times, the Deviations grammar
four times, an eighth lane bitten the same night. Each mismatch cost a full review round plus a
repair spawn. The producing verbs (`triage enrich`/`apply` for criteria; `build pr` for
deviations, before #5566) carried zero references to the reader that would later reject their
output — and Deviations was not a registered format at all, its grammar held privately by the
review side, so no producer *could* have checked it.

The counter-example already existed in-tree:
[`packages/fabrika-cli/src/epic/brief-verb.ts`](../packages/fabrika-cli/src/epic/brief-verb.ts)
imports both `emit` and `read` from the criteria module and reads back what it wrote, at a cost of
roughly twenty lines. The rule below generalizes that shape to every registered format, so the
class dies rather than the two instances.

## Decision

**A producer verb runs the consumer-side `read` of every registered wire format it authors, over
the final bytes it is about to post, and refuses the write unless the read answers `Found` (or the
format's explicit empty claim, such as deviations' `None.`).**

The mechanics, settling the four forks #5735 posed:

1. **Refuse, with emit-from-fields preferred where fields exist — one answer for all formats.**
   Where the producer holds structured fields, it composes through the row's `emit` half, making
   the grammar unauthorable-wrong in the first place. But emit alone is not the invariant: the
   binding check is the `read` over the final artifact bytes, because a section can be emitted
   correctly and still land unreadable in its surrounding document (the criteria heading demoted
   by an enclosing template, a body arriving pre-composed on stdin). Refusal names the defect the
   reader found, pushing the fix onto the composing model at authoring time instead of onto a
   reviewer a round later.
2. **Per-verb read-back, backed by a registry-driven guard.** The mechanism is the in-process
   import the brief-verb pattern proved: the producer resolves the format's own `read` (the same
   module the registry row names) and runs it before posting. The enforcement that this happens is
   not diligence: a conformance-style law over `registeredFormats` fails closed on any row whose
   named producer verbs never resolve that format's reader — the
   `catalog-guard`/`fanout-guard` idiom, zero scope refusing rather than passing (ADR
   [0092](0092-gates-fail-closed-on-zero-scope.md)). Per-verb-only was rejected because it is
   forgotten on format eleven, exactly as per-format conformance tests were before
   [`wire/conformance.ts`](../packages/fabrika-cli/src/wire/conformance.ts) moved the laws over
   the registry. Emit-only was rejected because not every producer holds fields, and emit cannot
   see the enclosing document.
3. **Deviations is a registered wire format.** Enforcement can only reach a format the registry
   names, so any grammar two verbs meet through must have a row — deviations included. This
   landed with #5566: [`packages/fabrika-cli/src/wire/deviations.ts`](../packages/fabrika-cli/src/wire/deviations.ts)
   is the registered module, `build pr` reads it at write time via
   [`packages/fabrika-cli/src/build/pr-body.ts`](../packages/fabrika-cli/src/build/pr-body.ts),
   and the review side projects from the same wire read. A privately-held grammar like the old
   review-side deviations reader is the banned shape.
4. **The grammar-teaching prose deletes on the implementing PR.** A spawn-prompt or skill
   paragraph restating a wire grammar exists only because authoring was blind; once the producer
   verb refuses an unreadable section at write time, that paragraph is a second source of truth
   ADR 0241 already bans, and it goes on the same PR that arms the read-back — a pointer to the
   format module or `fabrika wire formats` may stay. The residual question of how a hand-authoring
   human learns a format's shape is #5743's, not reopened here.

**Where the convention lives:** this ADR plus the registry module's own docblocks are the rule's
home. No `CLAUDE.md` line — the rule binds `fabrika-cli` producer verbs, not repo-wide authoring —
and no `.patterns/` doc until the registry-driven guard exists to shape one around.

**Binding constraints.**

- A verb that posts a machine-read section without running that format's registered `read` over
  the final bytes is defective, whatever its output looks like.
- A wire grammar held outside the registry — in a consumer's private module or in prose — is the
  defect, not a tolerated variant; registration precedes enforcement.
- The read-back's refusal names the reader's defect verbatim; a producer never paraphrases a
  grammar it does not own (ADR [0251](0251-shared-formats-are-pinned-not-reimplemented.md)).

## Consequences

- A wire section that does not parse never reaches the board; the whole class of
  grammar-only review FAILs (eight in one day) dies at authoring time, saving a review round and
  a repair spawn per instance.
- #5565 (criteria producers) implements this rule; #5566 already landed the deviations half. The
  registry-driven producer guard is follow-up work this ADR shapes but does not schedule.
- Producers grow one in-process read per format they author — proven at ~20 lines each — and any
  future format is born checked, because its row is what the guard iterates.

## Records

no vocabulary impact
