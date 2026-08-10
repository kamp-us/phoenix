---
id: 0251
title: fabrika pins a shared wire format rather than deriving it from v1, and owns the test that proves it
status: accepted
date: 2026-08-09
tags: [fabrika, pipeline, contracts, wire]
---

# 0251 — fabrika pins a shared wire format rather than deriving it from v1, and owns the test that proves it

**What this decides:** ADR [0238](0238-fabrika-reimplements-v1-never-calls-it.md)'s clean cut is
about **calls**. A byte-level format two programs meet through on a GitHub artifact is not a call,
and neither side can re-implement it — by definition both must agree on the same bytes. So the rule
is **re-implement calls, pin formats**. The `triage enrich --epic` envelope is a wire format owned by
fabrika's `wire` group, specified with a golden fixture; v1's `epic-splice` conforms by pinning that
same fixture in a test of its own, never by an import. Test ownership follows format ownership: a
test that asserts a fabrika property lives in fabrika's package.

## Context

[#4892](https://github.com/kamp-us/phoenix/issues/4892) reported, and re-verified at source, that
fabrika's `--epic` envelope is coupled to v1 in two ways that "calls `pipeline-cli` nowhere" does not
name.

**The behavioural pin.** `claude-plugins/fabrika/skills/triage/contract.md` argued the envelope's
survival from v1's implementation, citing `epic-splice.ts` line numbers at four sites. The shape of
the argument was: `epic-splice` cuts only on `## Dependencies` and `## Plan (plan-epic)`, therefore
fabrika's headings are bytes it can never touch. That is true today and true by accident. Grow v1's
anchor set and fabrika's guarantee becomes false with nothing in fabrika to notice.

**The test pin.** The block *the fabrika `--epic` envelope survives the splice* lives in
`packages/pipeline-cli/src/tools/epic-splice/epic-splice.unit.test.ts`, and it carries more than
assertions: fabrika's canonical envelope fixture and a re-implementation of fabrika's own detector
sit there too, under a docblock claiming the fixture is the envelope *byte for byte*. Under the
deletion test the repo uses as its yardstick, deleting v1 costs fabrika a guard fabrika never owned.

**The copy has already drifted, which settles the question empirically.** The founder ruling on
[#4866](https://github.com/kamp-us/phoenix/issues/4866) replaced the envelope's shape-based detector
with a marker line, and `composeBody` in `packages/fabrika-cli/src/triage/enrich.ts` now writes
`<!-- fabrika:enriched issue=<N> mode=<mode> -->` immediately above the preserved block. The v1
fixture that claims to be the envelope byte for byte carries no marker line at all. Nothing red. The
"byte for byte" claim in a docblock is exactly the sort of promise a comment cannot keep.

**One un-sanctioned pin, not a class.** The same sweep found three citation sets from fabrika into
`packages/pipeline-cli/`. `split-match.ts` is a scar read — a v1 defect fabrika designs out — and
needs nothing. The `pitch-guard` set is a **deliberate** deferral to a CI-live gate, which ADR 0238
already sanctions: *"Where a question is already decided by a gate, fabrika expects the answer and
does not recompute it."* Only `epic-splice` is drift. A rule written here without saying so would
read as banning the sanctioned deferral too.

**What 0238 covers and what it does not.** Its binding constraint *"a spec clause that defers to one
has derived nothing"* arguably already reaches the behavioural pin. It says nothing about **test
ownership**, and nothing about the case where two programs must agree on bytes rather than one
calling the other. Those two gaps are what this ADR fills.

Ruled 2026-08-09 under the standing founder trust ruling and recorded on
[#4892](https://github.com/kamp-us/phoenix/issues/4892#issuecomment-5234594233).

## Decision

**A byte-level format fabrika shares with any other program is a wire format fabrika owns, and every
other side conforms to it by pinning a golden fixture in a test.**

The `wire` group's charter line already says this — *own the byte-level formats two skills meet
through on a GitHub artifact* — so the `--epic` envelope belongs to `wire` the same way the
acceptance-criteria block and the verdict marker do, on the terms ADR
[0241](0241-wire-formats-owned-by-schema-modules.md) sets: one owner schema module, one registry row,
`emit` / `read` / `check`, a total read. What this adds to 0241 is the **fixture**: the envelope's
canonical bytes are committed as a golden fixture beside the module and read verbatim (ADR
[0180](0180-capture-real-runtime-artifact-before-coding.md)'s `readGoldenFixture`), so both sides of the seam assert
against one artifact instead of two hand-copied ones.

**The dependency direction flips.** fabrika stops arguing the envelope's survival from v1's source.
v1's `epic-splice` test reads fabrika's fixture and asserts that splicing preserves it. That is a
test-time file read, not an import and not a call, so it neither re-arms 0238 nor blocks v1's
retirement: a v1 that goes away takes its own conformance test with it and leaves fabrika whole.
When either side reworders the bytes, a fixture test reds on the side that reworded, instead of the
seam breaking silently in production.

**Test ownership follows format ownership.** A test asserting a *fabrika* property belongs in
`packages/fabrika-cli/`. A test asserting *v1's splicer preserves what it is handed* belongs in
`packages/pipeline-cli/` and is v1's own conformance obligation. The block at
`epic-splice.unit.test.ts` is both of those things fused, so it splits along that line: the fixture
and the detector go to fabrika, the preservation assertions stay with the splicer and read the
fabrika fixture.

**The gate-deferral carve-out is untouched and is not what this bans.** Where a question is already
decided by a CI gate — `pitch-guard`, `homing-guard`, `cp-classify` — fabrika expects that gate's
answer, designs its artifacts to satisfy it, and computes no second verdict (ADR 0238). Citing such a
gate's source to explain *why* an artifact is shaped the way it is stays correct. The difference is
authority: a gate is the authority on its own question, whereas `epic-splice` was never the authority
on fabrika's envelope — fabrika is.

**Binding constraints.**

- A byte-level format fabrika shares with another program is a wire format: owner module, registry
  row, and a committed golden fixture carrying the canonical bytes.
- fabrika prose never grounds a property of its own format in another package's implementation or its
  line numbers. It cites the owner module.
- A test asserting a fabrika correctness property lives in `packages/fabrika-cli/`.
- A non-fabrika side conforms by pinning fabrika's golden fixture in its own test — never by
  importing fabrika code, and never the reverse.
- Deferral to a CI gate's verdict remains sanctioned and is not a pin.

**Banned.**

- Citing another package's line numbers as the reason a fabrika format is safe.
- A second hand-copied fixture standing in for the shared one.
- An import edge in either direction between `fabrika-cli` and `pipeline-cli`.

## Sequencing

**The module, the fixture and the test split land as one follow-up slice, not here.** ADR 0241 stages
a format with its first consumer; `triage enrich` has since landed
([#4831](https://github.com/kamp-us/phoenix/issues/4831)), so that condition is already met and the
slice is unblocked. This ADR is the ruling and the doc reconciliation; the code slice is filed as
[#5249](https://github.com/kamp-us/phoenix/issues/5249) so the format lands as 0241 requires — one
module plus one row plus its narrative section — rather than half-built inside a decision PR. The
shape currently written out in `claude-plugins/fabrika/skills/triage/contract.md` moves into the
module on that slice or a second one; it stays where it is until there is a module to hold it.

**Remedy (c) is moot — [#4712](https://github.com/kamp-us/phoenix/issues/4712) already dissolved the
coupling.** #4892 offered a third remedy: make the `--epic` envelope independent of any splicer's
anchor set. There is nothing left to take. #4712 closed by shipping
`claude-plugins/fabrika/skills/plan-epic/contract.md`, which rules that *the plan region is located
by the enrichment marker, never by position*, and states the consequence outright — with the marker
doing the detecting, appending the plan below the brief envelope breaks no detector, so **#4892's
remedy (c) is thereby moot**. The contract left the write-up to this ADR rather than pre-empting it,
so here it is, verified at the owner module rather than taken on the contract's word: detection is
`MARKER_RE` in `packages/fabrika-cli/src/triage/enrich.ts`, a whole-line-anchored multiline pattern
matched at its **first** occurrence, so the read asks nothing about where anything sits and no
splicer anchor set can reach the answer. What remains between fabrika and `epic-splice` is the byte
agreement this ADR pins with a fixture — a conformance obligation, not an anchor dependency — and it
is the fixture, not a position argument, that turns a future drift into a red test.

**[#4879](https://github.com/kamp-us/phoenix/issues/4879) is untouched.** It is a live destructive
defect *in* v1's splicer, re-homed to `axis:pipeline-hardening` under the 2026-08-07 ruling. This ADR
is a dependency question *about* v1. The two are inverses and must not be merged.

## Not decided here

- **Whether v1 keeps its conformance test after v1-skill absorption.** Retiring
  `packages/pipeline-cli/` is a separate and larger question ADR 0238's own Consequences already
  fences off; the fixture pin is correct whether v1 lives or goes.
- **Whether `epic-splice`'s anchor set may grow.** That is v1's call, and the fixture test is what
  makes it a visible one rather than a silent break.

## Consequences

**Easier.** A format drift is a red test on the side that drifted, instead of a production seam that
stopped holding. fabrika's contract stops citing another package's line numbers, so it stops rotting
every time that file moves — the `:128-130` citation was already two lines stale when #4892 checked
it. The deletion test passes in the direction it was failing: v1 can go without taking a fabrika
guard with it.

**Harder.** The envelope now costs a schema module, a fixture and a registry row rather than a
paragraph, which is 0241's standing price and the reason formats land with their consumers. And the
shape currently spelled out in `claude-plugins/fabrika/skills/triage/contract.md` has to move into
that module when it lands — 0241 bans restating a wire format's shape in a skill body, and the
contract is doing exactly that today. That migration is named in the follow-up slice; until the
module exists there is nowhere to move it to, so the contract keeps the shape and stops resting its
*argument* on v1.

**Method lesson.** The couplings that survive a clean-cut rule are the ones the rule's noun does not
cover. "Calls nowhere" was audited as calls and passed. Formats and tests are two more edge kinds,
and both were carrying weight. A boundary rule should name the edge kinds it governs, not the one
that prompted it.

## Records

Records the founder-delegated ruling on
[#4892](https://github.com/kamp-us/phoenix/issues/4892#issuecomment-5234594233) and closes that
issue. Extends ADR [0238](0238-fabrika-reimplements-v1-never-calls-it.md) — which stands unchanged on
calls — and ADR [0241](0241-wire-formats-owned-by-schema-modules.md), whose ownership law this
applies to a format whose second party is outside fabrika. The fabrika README's absent-list and
`claude-plugins/fabrika/skills/triage/contract.md` are amended by the same change.

No vocabulary impact: **wire format** is already coined in ADR 0241 and this decision applies it.
