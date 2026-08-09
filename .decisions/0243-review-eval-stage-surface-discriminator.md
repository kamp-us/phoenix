---
id: 0243
title: one `review` eval stage keyed by a `surface` sub-discriminator, graded per pair
status: accepted
date: 2026-08-09
tags: [fabrika, eval, corpus, review]
---

# 0243 — one `review` eval stage keyed by a `surface` sub-discriminator, graded per pair

**What this decides:** when the three v1 review gates become fabrika's single `review` skill, the
eval corpus keeps **one** `review` stage key, and every entry additionally carries a `surface` field
(`code` | `doc` | `skill`) that decides both which label shape is legal and which grader runs. A PR
that is reviewed on two surfaces gets two recorded rows — one per surface, same input — rather than
one row that averages them.

## Context

Fabrika collapses the v1 review family into one skill emitting N namespaced verdicts (ADR
[0242](0242-fabrika-skill-nouns-redefine-build-and-review.md) §3: `review-code`, `review-doc` and
`review-skill` are absorbed as three rubric *files* under one gate). The eval corpus was built
against the v1 shape, so the merge lands on a module whose stated central guarantee is at stake.

Three source facts fix the problem, and they were read rather than assumed:

- **The two review label shapes genuinely differ.**
  [`packages/fabrika-cli/src/eval/corpus.ts`](../packages/fabrika-cli/src/eval/corpus.ts) declares
  `ReviewCodeEntry` with `label: {verdict, acFindings}` and `ReviewDocEntry` with
  `label: {verdict, findings}` — different field names over different rubrics (acceptance-criteria
  findings versus doc findings), not one shape spelled two ways.
- **The module's guarantee is discrimination on `stage`.** `CorpusEntry` is
  `Schema.Union([...])` over five members each pinned by a `Schema.Literal` `stage`, and
  `CorpusManifest.stages` re-groups them under per-stage keys whose value schema is that stage's
  entry alone. The file states the intent outright: "a label whose shape doesn't match its stage is
  *unrepresentable*". Collapsing `review-code` and `review-doc` onto a bare `review` key would make
  *both* label shapes legal under one key — the guarantee's exact negation.
- **The grader dispatches on that same discriminator.**
  [`packages/fabrika-cli/src/eval/oracle.ts`](../packages/fabrika-cli/src/eval/oracle.ts)'s
  `gradeEntry` is a `switch (entry.stage)` selecting `gradeReviewCode` (compares `verdict` +
  `acFindings` as a set) or `gradeReviewDoc` (compares `verdict` + `findings` as a set). With one
  `review` case and no further key, two rubrics silently collapse onto one grader.

The wire vocabulary is already compatible and imposes no constraint the other way:
[`packages/fabrika-cli/src/wire/verdict-marker.ts`](../packages/fabrika-cli/src/wire/verdict-marker.ts)
fixes the namespace class as `/^review(-[a-z0-9]+)*$/`, so `review`, `review-code`, `review-doc` and
`review-skill` all remain valid namespaces under a `review` root. The data shape chosen here and the
marker vocabulary therefore agree rather than needing reconciliation — and the format itself is
untouched, staying owned by its schema module per ADR
[0241](0241-wire-formats-owned-by-schema-modules.md).

This record transcribes the founder ruling of 2026-08-09 on
[#4976](https://github.com/kamp-us/phoenix/issues/4976) — option (a), the sub-discriminator. It does
not re-open the fork.

**Where this sits among the ADRs it refines rather than contradicts.** ADR
[0112](0112-token-measurement-no-quality-compromise-methodology.md) §3 defines a *per-stage*
output-quality oracle and ADR
[0146](0146-graded-corpus-oracle-for-stochastic-model-swap.md) generalizes it into a pass-rate over a
graded corpus; both rulings stand untouched. What changes here is mechanics inside one stage: the
`review` stage's oracle is keyed one level finer because the stage now carries three rubrics. No
status line moves. ADR [0236](0236-eval-harness-gains-a-spawning-shell.md)'s pure-core/IO-shell split
is likewise unaffected — the discriminator lives in the pure corpus and oracle cores.

Its sibling, ruled the same night on
[#4977](https://github.com/kamp-us/phoenix/issues/4977), is **recorded provenance wins**: a recorded
result's stage key is history, so already-committed v1-keyed rows keep their original stage keys and
are never re-keyed onto a live fabrika stage name. That ruling governs rows already on disk; this one
governs the live schema. They are referenced, not restated, and §5 states how they compose.

## Decision

**The eval corpus keeps one `review` stage key, and every review entry and label carries a `surface`
discriminator (`code` | `doc` | `skill`) that selects both the label shape and the grader —
`gradeEntry` dispatches per discriminated `(stage, surface)` pair, never per stage alone.**

### 1. `surface` is a discriminator, not an annotation

The `review` member of `CorpusEntry` is itself a union discriminated on `surface`, exactly as
`CorpusEntry` is discriminated on `stage`. Each member pins `surface` to a `Schema.Literal` and
admits exactly one label shape:

| `stage` | `surface` | admissible `label` |
|---|---|---|
| `review` | `code` | `{verdict, acFindings}` |
| `review` | `doc` | `{verdict, findings}` |
| `review` | `skill` | `{verdict, rigorFindings: {check, finding}[]}` (§1a) |

A `review` entry whose label shape does not match its `surface` stays **unrepresentable** — the
guarantee `corpus.ts` states for `stage` now holds for the `(stage, surface)` pair. `surface` is
therefore required on a `review` entry and carries no default; a `review` entry with no `surface` is
a decode failure, not a row graded by a fallback rubric.

### 1a. Amendment, 2026-08-09 — the `skill` surface's label shape ([#5038](https://github.com/kamp-us/phoenix/issues/5038))

The table above shipped with its third row open, because the founder ruling on
[#4979](https://github.com/kamp-us/phoenix/issues/4979) fenced designing that shape out of the lane
that built the stage. This amendment fills the cell; nothing else in the record changes.

The shape is:

```
{ verdict, rigorFindings: ReadonlyArray<{check, finding}> }
```

where `check` is one of a closed four-value vocabulary transcribed from
[`claude-plugins/fabrika/skills/review/rubrics/skill.md`](../claude-plugins/fabrika/skills/review/rubrics/skill.md):
`behavioral-correctness`, `trigger-description-quality`, `cross-skill-conflict`,
`fabrika-conventions`.

**The one live question was flat findings versus per-check attribution, and it resolves to
per-check.** Three reasons, in the order they carry weight:

- **The source already carries the attribution.** The skill rubric is the only one of the three
  whose checks are a *numbered, closed set* — `code`'s findings are per acceptance criterion and
  `doc`'s are a hygiene checklist with no fixed partition, which is why both of those flatten to a
  bare string array honestly. Flattening here would discard a distinction the rubric states, and no
  consumer could recover it.
- **It makes the rubric's own exclusion enforceable.** The rubric assigns gate-invariant
  preservation to the `governance` skill and says it is "never graded here". With a closed `check`
  vocabulary that omits it, a row attributing a finding to that check is *unrepresentable* — the
  fence becomes a decode failure instead of a convention. A flat array cannot express the fence at
  all, which is the same make-invalid-states-unrepresentable argument §6 uses to reject the superset
  struct.
- **It grades what a skill review is actually wrong about.** A right finding filed under the wrong
  check is a real miss of the rubric, and the pair label is what lets the oracle see it. The grader
  compares the *set of pairs*, in the same order-and-repeat-insensitive way the other two surfaces
  compare their finding sets (ADR 0112 §3), so no new grading regime is introduced.

**Not decided here, deliberately:** there is no recorded `review-skill` provenance key, because the
v1 gate committed no rows under one — a provenance key is minted by history
([#4977](https://github.com/kamp-us/phoenix/issues/4977)), never in advance. If the rubric later
renumbers its checks, that is a change to this closed vocabulary and to the rows keyed by it, and it
comes back through this record.

### 2. `gradeEntry` dispatches on the pair

`gradeEntry`'s `switch` on `entry.stage` narrows to `review` and then narrows again on
`entry.surface`, so each surface reaches its own grader with its own artifact schema. Dispatching on
`stage` alone is banned: it is precisely the silent two-rubrics-one-grader collapse the ruling exists
to prevent. The non-review stages keep single-key dispatch unchanged.

### 3. A mixed-surface PR is represented natively

One PR reviewed on two surfaces produces **one recorded label per surface for the same `inputRef`** —
two rows, each graded by its own grader. There is no composite label and no "primary surface"
tiebreak; `(stage, surface, inputRef)` is what identifies a review row, so the same `inputRef`
appearing under two surfaces is the normal, intended shape rather than a duplicate.

This mirrors the merged skill's runtime shape: one gate, three rubrics, with the namespace set derived
from the diff (ADR [0242](0242-fabrika-skill-nouns-redefine-build-and-review.md) §3). The corpus
represents what the gate actually does.

### 4. A merged `review` pass-rate is reported per surface, never averaged across surfaces

Direct consequence of §2 — stated here so the reporting child does not have to re-derive it: **a
pass-rate is only a measurement over one grading regime, so the report's cell key carries `surface`
and rows from different review surfaces are never aggregated into a single undifferentiated `review`
number.** Where a composite figure is rendered at all, the row must name what it aggregated; a bare
`review` pass-rate spanning two graders is not a measurement and must not be produced.

### 5. Scope boundary — eval-corpus data shape only

The ruling fences this explicitly, and the fence is part of the record: **this is eval-corpus data
shape only — no GitHub label, no triage involvement, and runtime routing stays derived-from-the-diff.**
`surface` is a field in the graded ground truth. It is not a label a human or an agent applies to an
issue, it is not an input to triage, and it does not become the mechanism by which the `review` skill
decides which rubrics to run at runtime — that selection stays derived from the diff.

Also out of scope, deliberately: any change under `packages/fabrika-cli/src/wire/` (the marker format
already admits every namespace this needs), and the fate of rows already committed under v1 stage keys
(that is [#4977](https://github.com/kamp-us/phoenix/issues/4977)'s ruling — those rows keep their
original keys as provenance and are not retro-fitted with a `surface`).

**Binding constraints.**
- `surface` is required on every `review` corpus entry and label; no default, no inference.
- `gradeEntry` selects a grader by the `(stage, surface)` pair.
- The report's bucket key carries `surface` for `review` rows.

**Banned.**
- Dispatching a review grade on `stage` alone.
- One `review` label shape that admits both `acFindings` and `findings` (see §6).
- Treating `surface` as a GitHub label, a triage input, or the runtime rubric-router.

### 6. The rejected alternatives, and why they cannot be reopened without new information

- **One union label under a bare `review` key.** Rejected: it makes both label shapes legal under one
  key, so a `{verdict, findings}` label sits happily on a code-review row — the module's stated
  unrepresentability guarantee is gone, and the grader is left with no key to dispatch on, which is
  the collapse in §2.
- **One superset struct** (`{verdict, acFindings?, findings?}`). Rejected for the same reason one
  level down: optional fields make "both present" and "neither present" representable, and the
  grader would have to *sniff* which fields arrived to pick a rubric. Sniffing a shape is the
  make-invalid-states-unrepresentable violation the corpus module was written to avoid.
- **Three separate stage keys** (keeping `review-code` / `review-doc` / `review-skill` as live
  stages). Not chosen: the skill merged into one gate (ADR
  [0242](0242-fabrika-skill-nouns-redefine-build-and-review.md) §3), and a stage vocabulary that
  contradicts the skill partition puts the harness back out of step with what it measures.

Reopening any of these needs new information about the module's guarantee or the skill's runtime
shape — not a fresh preference.

## Consequences

- The corpus schema, the manifest grouping and `gradeEntry` change together in one implementing
  child ([#4979](https://github.com/kamp-us/phoenix/issues/4979)); the reporting key change is
  [#4980](https://github.com/kamp-us/phoenix/issues/4980). Both build against this record.
- The unrepresentability guarantee survives the merge intact — it is restated over a pair rather than
  weakened. A future stage that also fans into rubrics has a precedent to copy.
- Adding a fourth review rubric later is a `surface` literal plus a grader, not a new stage key and
  not a new manifest group.
- Cost: every consumer that keyed on the review stage name alone now needs the pair. That is the
  point — the places that break are exactly the places that would otherwise have silently averaged
  two grading regimes.
- Rows already committed under v1 `review-code` keep that key as provenance
  ([#4977](https://github.com/kamp-us/phoenix/issues/4977)); they are read as history, not as
  pointers into the live stage set, so they do not need a `surface` and their presence does not
  contradict the single live `review` key.

## Records

- **Vocabulary impact: one term coined — `review surface`.** The `code` | `doc` | `skill` axis that
  discriminates a `review` corpus entry, selects its label shape and selects its grader. It is *not*
  a GitHub label, *not* a triage input, and *not* the runtime rubric-router (§5). Its route to
  [`.glossary/TERMS.md`](../.glossary/TERMS.md) already exists and is not re-filed here:
  [#4984](https://github.com/kamp-us/phoenix/issues/4984) carries `review surface` (with `live stage
  key` and `recorded provenance`) as a glossary deliverable, deliberately blocked until this ADR and
  [#4977](https://github.com/kamp-us/phoenix/issues/4977) rule. The row is written through the
  `glossary` skill rather than inline, so this PR stays purely additive and the term still gets its
  `Not` column.
- Records the founder ruling of 2026-08-09 on
  [#4976](https://github.com/kamp-us/phoenix/issues/4976) (option (a)); the sibling ruling on
  [#4977](https://github.com/kamp-us/phoenix/issues/4977) is referenced, not restated.
