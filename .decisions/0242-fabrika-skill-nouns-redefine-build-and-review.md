---
id: 0242
title: the eight fabrika skill nouns enter the register, and build and review are redefinitions
status: amended-in-part by [0284](0284-retire-epic-conduction-onto-lane-machines.md)
date: 2026-08-09
tags: [fabrika, glossary, vocabulary, pipeline]
---

# 0242 — the eight fabrika skill nouns enter the register, and `build` and `review` are redefinitions

**What this decides:** the eight skill names the fabrika partition locked — `build`, `build-ui`,
`review`, `review-ui`, `governance`, `build-epic`, `front-door`, `check-epic-plan` — are canonical
domain nouns and get rows in [`.glossary/TERMS.md`](../.glossary/TERMS.md). Two of them displace a
meaning that is live in this repo today, and this entry is the dated record of that displacement.
`review-ui` also shares its spelling with a name coined, for a different scope, by ADR
[0144](0144-depo-internal-asset-cdn.md); §4 records how the two coexist.

## Context

The founder locked fabrika's skill set on wayfinder:map
[#4891](https://github.com/kamp-us/phoenix/issues/4891) (2026-08-08). Epic
[#4904](https://github.com/kamp-us/phoenix/issues/4904) transcribed that partition onto the board —
fourteen children, all landed — and its `### Vocabulary impact` block named the eight nouns the whole
authoring wave now builds against. It deliberately minted no child for the glossary rows: the epic's
item list was founder-fixed and transcription-only, so it routed them out as follow-up
([#4919](https://github.com/kamp-us/phoenix/issues/4919)).

Until now the only durable statement of the eight names was an issue body, which is not canon. That
matters most for the two names that are not additions:

- **`review` was a family.** ADR [0079](0079-reviewer-authored-acceptance-criteria.md) says "all four
  `review-*`"; ADR [0226](0226-cp-advisory-never-carries-a-failing-criterion.md) says "the four review
  gate templates". The directory is wider still —
  [`claude-plugins/kampus-pipeline/skills/`](../claude-plugins/kampus-pipeline/skills/) carries **six**
  `review-*` skills. So the word names a family of four in the decision corpus and six on disk, and
  after #4904 it names one skill.
- **`build` was the general act.** `CLAUDE.md` uses `pnpm build` as the build verb; the `platform lane`
  row in [`.glossary/TERMS.md`](../.glossary/TERMS.md) defines itself as "an active build lane"; every
  ADR names the builder `write-code`.

A renamed-but-unrecorded noun does not fail loudly. It gives a reader a confident wrong answer — the
failure mode this repo keeps paying for. And `TERMS.md` cannot fix it alone: the register is
present-tense with no history, so a row that replaces a meaning represents the *new* reading and
erases the fact that a reading moved. A register can state a term. It cannot state a diff. That is
what this entry is for.

## Decision

### 1. The eight nouns are canon, and each gets a `TERMS.md` row

They name fabrika skills under the modality partition: the factory is cut by **text versus
rendered-visual**, symmetrically on both sides — `build` / `build-ui` constructing, `review` /
`review-ui` judging — plus `governance` (corpus integrity, guarding from outside), `build-epic` (the
conductor), `front-door` (the `/fabrika` operating entry) and `check-epic-plan` (plan-checking, in the
planning lane).

Each row states **only the current reading**. The register describes what a word means now.

### 2. `build` — from the general act to one skill, without erasing the general act

**Before:** the act of building, in three live senses — the `pnpm build` compile step, the *build lane*
of the WIP model, and the v1 builder skill `write-code`.

**Now:** `build` names fabrika's **text-construction skill** — code, prose and plans, and nothing
rendered-visual (brief [#4707](https://github.com/kamp-us/phoenix/issues/4707), amended under
[#4906](https://github.com/kamp-us/phoenix/issues/4906)). The three UI-only branches that lived inside
v1 `write-code` move out to `build-ui`.

**The other senses survive as compounds and are not renamed.** `pnpm build` is still the compile step;
*build lane* is still the WIP unit. What changed is that the **bare noun**, in a fabrika context, now
names a skill. This is a homonym we accept rather than a rename we propagate: rewriting `pnpm build`
or *build lane* to dodge the collision would churn two settled vocabularies to protect a third. The
`Not` column carries the boundary.

### 3. `review` — from a family to one skill, and the family disperses six ways

**Before:** the review family. Four in the corpus, six on disk.

**Now:** `review` names fabrika's **one text-review skill**, emitting **N namespaced verdicts** rather
than N skills each emitting one (brief [#4959](https://github.com/kamp-us/phoenix/issues/4959)). The
verdict-marker format already admits it: its namespace class is `/^review(-[a-z0-9]+)*$/` in
[`packages/fabrika-cli/src/wire/verdict-marker.ts`](../packages/fabrika-cli/src/wire/verdict-marker.ts),
so `review`, `review-code`, `review-doc` and `review-skill` all conform unchanged.

The collapse is **not** a four-to-one merge, and calling it one understates what moved. The six v1
`review-*` skills disperse four ways:

| v1 skill | where its judgement goes |
|---|---|
| `review-code`, `review-doc`, `review-skill` | absorbed into `review` as three rubric **files**, under the leaf rule (a leaf becomes a skill only when consumed by ≥2 skills or needing its own eval identity) |
| `review-plan` | out of the review family entirely → **`check-epic-plan`**, in the planning lane ([#4948](https://github.com/kamp-us/phoenix/issues/4948)) |
| `review-design` | renamed → **`review-ui`** ([#4718](https://github.com/kamp-us/phoenix/issues/4718)) |
| `review-trivial` | killed ([#4715](https://github.com/kamp-us/phoenix/issues/4715)) |

Two judgements are carved out of the absorbed three rather than travelling with them:
**governance-corpus integrity** (v1's ADR-contradiction sweep in `review-doc` plus its
gate-invariant-preservation check in `review-skill`) becomes the dedicated **`governance`** skill,
which `review` invokes and does not own; and **visual calibration** is `review-ui`'s.

### 4. `review-ui` — two distinct names that coexist; this entry claims nothing over ADR 0144

ADR [0144](0144-depo-internal-asset-cdn.md) already coined `review-ui`: "the Playwright step that
captures UI screenshots on UI-affecting PRs and embeds them via `depo put` is a distinct new
**`review-ui`** skill, filed as its own epic." That is a narrower scope than #4904's visual-modality
gate, so a reader who meets the bare name needs to know which one is meant.

**In a fabrika context, `review-ui` names the visual-modality review gate.** That is a statement about
fabrika's own vocabulary and nothing more. **ADR 0144 is not overturned** — it keeps `status: accepted`
and every word of its decision text (founder ruling (a), 2026-08-08 on epic
[#4904](https://github.com/kamp-us/phoenix/issues/4904), transcribed into
[#4951](https://github.com/kamp-us/phoenix/issues/4951)). The two names coexist, and the qualifying
note #4951 adds at 0144's clause is what tells a reader landing there which reading is which.

The coexistence is safe because the two readings converge on one artifact rather than competing for it:

- **0144's `review-ui` was never built as a skill.** No `review-ui` directory exists under any plugin.
- **Its function was built — inside the gate that now carries the name.** The capture-and-embed leg
  landed as `review-design`'s evidence path over the `@kampus/design-capture` seam, with the bytes in
  depo per ADR [0183](0183-golden-screen-storage-depo-git-pointer.md).
- **#4904 renames that gate `review-ui`**, and its brief is explicit that `review-design` "is **not** a
  second skill and **not** a predecessor to be ported: it is this same skill under its superseded name."

So the capture step is a **leg of the visual gate** rather than a standalone skill — a fact about what
got built, not a supersession this entry asserts. depo's own decision, and the decoupling 0144's clause
protects, stand untouched.

## Consequences

- `.glossary/TERMS.md` gains a `fabrika skill nouns` section with the eight rows. The `build` and
  `review` rows carry their superseded reading in the `Not` column, pointing here.
- A reader of any pre-#4904 ticket, ADR or skill doc that says `build` or `review` has one place to
  learn that the word moved and what it used to mean.
- **No landed ADR is edited by this entry — not its decision text, not its status line.** ADR 0144
  keeps `status: accepted`; the qualifying note that disambiguates the shared `review-ui` name is
  #4951's to write, not this entry's. ADR 0079's "all four `review-*`" and ADR 0226's "the four review
  gate templates" stay untouched too — nothing supersedes them; they describe v1, which is frozen and
  still on disk. This entry is the bridge, not a retraction.
- The register alone would not have carried this. Every future redefinition of a live noun needs the
  same pair — a row for the new reading, a dated entry for the change.
- Nothing here re-opens a ruling. Every name is founder-fixed on #4891 and transcribed by #4904; this
  entry records vocabulary, it does not decide scope.
