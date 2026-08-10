---
id: 0258
title: the `Filed by an agent` footer is a wire format fabrika owns, pinned by one fixture every side tests against
status: accepted
date: 2026-08-10
tags: [fabrika, pipeline, contracts, wire, triage]
---

# 0258 — the `Filed by an agent` footer is a wire format fabrika owns, pinned by one fixture every side tests against

**What this decides:** The `Filed by an agent` report footer is the same kind of thing ADR
[0251](0251-shared-formats-are-pinned-not-reimplemented.md) settled for the `--epic` envelope — a
byte-level format two programs meet through — so it gets the same treatment: one schema module in
fabrika's `wire` group owns the bytes, one committed fixture carries them, and every writer and
every reader on either side of the seam asserts against that one fixture instead of against its own
copy of the string.

## Context

[#4759](https://github.com/kamp-us/phoenix/issues/4759) reported that the marker is a wire format
with no owner: two protections exist and both sit on the producer's side, so nothing pins the bytes
one side emits against the bytes another side looks for. Re-verified at `origin/main` while writing
this, the seam is:

**Producers.** `packages/fabrika-cli/src/report/compose.ts`'s `renderFooter` puts the literal first
in the `parts` array, outside the `.filter((p): p is string => p !== null)` that drops absent
optional fields, and renders `` `---\n<sub>${parts.join(" · ")}</sub>` ``. v1's
`claude-plugins/kampus-pipeline/skills/report/footer.sh` builds the same line in bash with the same
literal seeded into `parts` and prints `---\n<sub>…</sub>\n`. A third site,
`claude-plugins/kampus-pipeline/skills/wayfinder/SKILL.md`, does not compose the bytes in code at
all — it *instructs* its emitted issues to carry the footer, which is a producer with no executable
anything.

**Readers.** The report's picture of the consumer has since moved, and this changes the shape of the
fix. When #4759 was filed, and when triage re-checked it, the only consumer was prose in
`claude-plugins/kampus-pipeline/skills/triage/SKILL.md` — a model reading a skill body — so triage
recorded that there was no consumer-side artifact to pin *against*. There is one now:
`packages/fabrika-cli/src/triage/provenance.ts` ships `hasAgentFooter`, a real predicate matching
`/^<sub>Filed by an agent/m`, and `triage kill` re-runs it rather than trusting a caller. The seam
is code-to-code today, on both sides, and it is unpinned in exactly the way the report predicted.

**The two sides already spell the match differently, deliberately.** `provenance.ts` anchors at
line-begin because a foreign body that merely *quotes* the phrase would otherwise answer `agent`,
the close-eligible direction; `packages/fabrika-cli/src/report/file-verb.ts`'s read-back is a bare
`body.includes("Filed by an agent")`, which is correct there because the body is one the same
process just composed. Both files say so in their own docblocks. That divergence is a design
choice and this ADR keeps it — it is worth stating because a pin written carelessly would "fix" the
two into agreement and re-open the fail-open hole.

**What a fix must not regress**, all confirmed in source: the literal is unconditional, never a
droppable field; `file-verb.ts` refuses at file time on a body missing it; `report note` deliberately
omits it and `packages/fabrika-cli/src/report/note-verb.unit.test.ts` asserts the absence; a sparse
footer is still a footer, so no reader may require the optional fields.

**Why the failure is invisible.** If either side drifts, every fabrika-filed issue reclassifies as
human-typed. That fails *safe* — over-protection, never a wrong close — which is precisely what makes
it undetectable: the symptom is a kill sweep quietly finding nothing to close, byte-identical to a
healthy backlog. It is the same class this campaign has catalogued repeatedly ([#4520](https://github.com/kamp-us/phoenix/issues/4520),
[#4700](https://github.com/kamp-us/phoenix/issues/4700), [#4666](https://github.com/kamp-us/phoenix/issues/4666),
[#4752](https://github.com/kamp-us/phoenix/issues/4752), [#4754](https://github.com/kamp-us/phoenix/issues/4754)):
a check that cannot see what it is looking for, failing as a plausible value rather than as an error.

**The shape is already restated in two skill bodies.** `claude-plugins/fabrika/skills/report/contract.md`
carries a field table plus two rendered examples, and `claude-plugins/fabrika/skills/triage/contract.md`
re-derives the joining rule and the droppable-field behaviour in prose. ADR
[0241](0241-wire-formats-owned-by-schema-modules.md) bans restating a wire format's shape in a skill
body; there has been nowhere else to put it, which is the same position ADR 0251 found the `--epic`
envelope in.

Ruled 2026-08-10 under the standing founder trust ruling, recorded on
[#4759](https://github.com/kamp-us/phoenix/issues/4759#issuecomment-5234594386): *same ruling as
[#4892](https://github.com/kamp-us/phoenix/issues/4892), same owner.*

## Decision

**The `Filed by an agent` footer is a wire format owned by fabrika's `wire` group. It lands as one
schema module plus one registry row plus one committed fixture, and every other side conforms by
asserting against that fixture in a test of its own.**

This is ADR 0251's rule applied, not a new one: re-implement calls, pin formats. ADR
[0238](0238-fabrika-reimplements-v1-never-calls-it.md)'s ban is about calls and is untouched.

**Ownership.** The bytes move behind a schema module registered in
`packages/fabrika-cli/src/wire/registry.ts` on ADR 0241's terms — `emit` / `read` / `check`, a total
read answering `Found` / `Absent` / `Malformed`. `renderFooter` composes through the module's `emit`;
`hasAgentFooter` is the module's `read`, keeping its line anchor. `file-verb.ts`'s read-back stays a
bare substring over its own freshly-composed body: it asserts a different property (this process
composed a footer) than the format's `read` (a foreign body carries one), and collapsing the two
would reopen the quoted-phrase hole.

**The canonical bytes are a committed fixture file, not a TypeScript literal.** Every registered row
today carries its samples inline on the row, which is enough for laws that run inside `fabrika-cli`.
It is not enough here, because the second party is outside the package: `packages/pipeline-cli/`
cannot read an inline TS fixture without an import edge, and an import edge in either direction is
banned by ADR 0251. So this format's canonical bytes are committed as a file beside the module, read
verbatim by both sides (`packages/fabrika-cli/src/golden-fixture.ts` and
`packages/pipeline-cli/src/golden-fixture.ts` both already exist), and the row's samples derive from
that file rather than restating it. A file read at test time is not an import and not a call.

**Producers in scope, and what each owes.**

| Producer | Obligation |
|---|---|
| `packages/fabrika-cli/src/report/compose.ts` | emits through the module — it stops owning the bytes |
| `claude-plugins/kampus-pipeline/skills/report/footer.sh` | conforms: a test in `packages/pipeline-cli/` runs the script and asserts its output against fabrika's fixture. The test lives with v1 and is deleted with v1 |
| `claude-plugins/kampus-pipeline/skills/wayfinder/SKILL.md` | is **not** a producer. A skill instructing an agent to hand-write footer bytes has no pin a test can hold, so it calls the one emitter instead |

That third row is the honest limit of this ruling: prose telling a model to write a string cannot be
unit-tested, so the rule is *route through the emitter*, and `file-verb.ts`'s file-time read-back is
the runtime backstop for anything that slips.

**Authority splits in two, and both halves are named.** ADR
[0159](0159-never-auto-close-signal-is-the-report-footer.md) remains the authority on what the marker
*means* — present ⇒ agent-filed ⇒ never auto-closed. The wire module and its fixture become the
authority on what the marker *is*, byte for byte. v1's
`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` §4.5 is neither: it is v1's own
reader prose, and it retires with v1.

**`report note`'s omission is preserved and is not an oversight to fix.** The format is the *issue*
footer. A note is a comment, filing provenance does not belong on one, and the test asserting its
absence stays.

**The #4619 policy layer sits above this and is untouched.** The founder's 2026-08-09 ruling on
[#4619](https://github.com/kamp-us/phoenix/issues/4619) makes a filing authored by an operator-set
account agent-reported whether or not the footer is present. That is a policy about *who filed it*;
this ADR is the mechanical layer under it. Pinning the bytes neither strengthens nor weakens the
second signal, and the provenance predicate stays two-signal.

**Binding constraints.**

- The footer's bytes live in one `wire` schema module with one registry row; no second composer, no
  second matcher.
- The canonical bytes are a committed fixture file, so a non-fabrika side can pin them without an
  import.
- A non-fabrika producer conforms by a test it owns that reads that fixture — never by importing
  fabrika, and never the reverse.
- A skill that wants a footer calls an emitter; it does not describe the bytes for a model to
  reproduce.
- The optional fields stay droppable and no reader may require them.

**Banned.**

- A second hand-copied copy of the footer's bytes, in a test, a doc or a skill body.
- Restating the footer's shape in a skill body once the module exists (ADR 0241).
- Emitting the marker from `report note`.
- Collapsing `hasAgentFooter`'s line anchor into `file-verb.ts`'s substring check.
- Reading footer-absence as human-authored for an operator-set account (ADR 0159 as narrowed by the
  #4619 ruling).

## Sequencing

**The module, the fixture, the registry row and the two conformance tests land as one follow-up
slice, not here.** ADR 0241 stages a format with its first consumer; both consumers already shipped
(`report file` composes, `triage provenance` reads), so the staging condition is met and the slice is
unblocked. This ADR is the ruling; the code is filed as
[#5284](https://github.com/kamp-us/phoenix/issues/5284), exactly as ADR 0251 filed
[#5249](https://github.com/kamp-us/phoenix/issues/5249) for the envelope. The two shape
restatements in `claude-plugins/fabrika/skills/report/contract.md` and
`claude-plugins/fabrika/skills/triage/contract.md` move into the module on that slice — they stay
where they are until there is a module to hold them, because there is nowhere else for them to go.

## Not decided here

- **Whether the footer gains or loses fields.** This pins what is there; changing it is a separate
  decision, and the fixture is what would make such a change visible rather than silent.
- **Whether `wayfinder`'s emitted issues route through `footer.sh` or through `fabrika report file`.**
  That is v1-retirement sequencing, not a format question.
- **Whether v1 keeps its conformance test after v1-skill absorption.** ADR 0251 already fenced this
  off; the pin is correct whether v1 lives or goes.

## Deviations

**The ruling and the triage seed name different authorities, and this ADR follows the ruling.**
Triage's acceptance criteria on [#4759](https://github.com/kamp-us/phoenix/issues/4759#issuecomment-5160172573)
(2026-08-02) asked that the pin assert against *"the `gh-issue-intake-formats.md` §4.5 / ADR 0159
contract, not either implementation."* The founder-delegated ruling (2026-08-10) instead puts the
authority in fabrika's `wire` contract — *"one pinned byte-level spec + golden fixture in wire's
contract."* Those are not the same artifact: one is v1's formats doc, the other is fabrika's owner
module. The later ruling governs, so the bytes' authority is fabrika's module and fixture. The
seed's concern is met a different way — the authority is still *neither implementation*, since the
module owns the bytes and both `compose.ts` and `footer.sh` become conformers to it — and ADR 0159
keeps the authority the seed cared most about, the marker's meaning. **The veto is open**: if the
founder wants v1's §4.5 to hold the byte authority instead, this splits back apart and the ADR is
amended.

No other deviations.

## Consequences

**Easier.** A reword on either side reds a test on the side that reworded, instead of silently
flipping every agent-filed issue into a human-protected one. The two skill contracts stop carrying a
shape they cannot keep honest. A future reader of the footer has one place to ask what it is.

**Harder.** The footer now costs a module, a fixture, a registry row and a v1-side test rather than a
literal in two files — 0241's standing price. And v1 gains a test it did not have, which is a small
tax on a package already slated for retirement; it is bounded by dying with that package.

**Method lesson.** The report and triage both concluded there was no consumer artifact to pin
against, and both were right when they looked. A shipped verb appeared in between and made the seam
code-to-code. A decision written from an intake note that is a week old is written against a repo
that has moved — re-verify the seam at head before ruling on its shape, not just the claims about it.

## Records

Records the founder-delegated ruling on
[#4759](https://github.com/kamp-us/phoenix/issues/4759#issuecomment-5234594386) and closes that
issue. Applies ADR [0251](0251-shared-formats-are-pinned-not-reimplemented.md) to a second shared
format and inherits ADR [0241](0241-wire-formats-owned-by-schema-modules.md)'s ownership law. ADR
[0238](0238-fabrika-reimplements-v1-never-calls-it.md) stands unchanged on calls. ADR
[0159](0159-never-auto-close-signal-is-the-report-footer.md) keeps the marker's *meaning* and is not
superseded or amended by this — only the ownership of its bytes is settled here.

**No vocabulary impact.** *Wire format* is coined in ADR 0241 and applied here; *filing provenance*
and the *never-auto-close signal* are ADR 0159's and are used, not redefined.
