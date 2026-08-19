---
id: 0308
title: A fabrika verb's output field is an answer-array or an evidence-array, and evidence collapses to counts
status: accepted
date: 2026-08-19
tags: [fabrika, pipeline, token-economics, cli]
---

# 0308 — A fabrika verb's output field is an answer-array or an evidence-array, and evidence collapses to counts

**What this decides:** every array a fabrika verb prints on the answer channel is classified once as
an **answer-array** — a skill instructs its reader to iterate the rows — or an **evidence-array** —
cited only so a short or empty answer is auditable, with no skill reading its rows by name.
Answer-arrays stay whole. Evidence-arrays collapse to a reason histogram, or to a cap-and-count where
a histogram does not fit. No flag, no second verb, per field.

## Context

An agent pays for a command's stdout on **every later turn**, not once. Measured on this repo on
2026-08-15 for [#5641](https://github.com/kamp-us/phoenix/issues/5641): one `fabrika build pick` call
printed a 21,478-byte payload of which the `excluded` array was **18,013 bytes — 84%**, roughly 5–6k
tokens. Those 266 rows carried exactly **two** distinct reasons (155 `audience-not-agent`, 111
`out-of-focus`). Across 22 measured workflow runs, cache reads were ~55% of the bill. A full source
sweep for the [#6147](https://github.com/kamp-us/phoenix/issues/6147) plan found **35 verb files**
printing at least one array-valued evidence field, across 20 of the CLI's verb groups.

The volume is not an accident to fix quietly. `claude-plugins/fabrika/skills/build/contract.md`
defends `excluded` outright: each excluded issue is reported with its reason "so a shortened or empty
pool is auditable from the answer itself rather than only from the counts". Any ruling had to answer
that rationale rather than step over it — which is why this was one decision, not 35 bug fixes.

Three shapes were on the table. Founder ruling on 2026-08-18, recorded at
[#5641, comment 5334469355](https://github.com/kamp-us/phoenix/issues/5641#issuecomment-5334469355):
option **(c)**, bounded evidence.

**This record rides a build rather than its own decision issue.** A builder refuses to claim a
`type:decision`, so the ADR a ruling implies is minted by the ruling's first build child — the
[#5909](https://github.com/kamp-us/phoenix/issues/5909) to
[#6143](https://github.com/kamp-us/phoenix/issues/6143) precedent.

## Decision

**Classify per field, collapse only evidence.**

- **Answer-array** — a skill or contract instructs its reader to iterate the rows, or the rows are
  what the caller asked for. Untouched. If it needs bounding it gets an explicit cap the caller
  controls (`build pick`'s `--limit`, `report dedup`'s `--limit`), never a silent collapse.
- **Evidence-array** — printed so the answer is auditable, with no skill reading a row by name. It
  collapses:
  - to a **reason histogram** — `{"audience-not-agent": 155, "out-of-focus": 111}` — when its rows
    carry a small fixed vocabulary. This is the default: the vocabulary is exactly what a reader acts
    on, so the histogram preserves the auditability the contract defends at ~2% of the bytes.
  - to a **cap-and-count** — the first N rows plus a remainder — when there is no such vocabulary.
- **The bounded tail is not collapsed.** An evidence-array that is structurally small (a flag echo, a
  proof-of-write read-back, a fixed-length list) is recorded in the table below as deliberately left
  whole. Collapsing a two-element array is self-generated churn.
- **Both channels move together.** A verb that mirrors an array into a tab-line grammar collapses
  both; a JSON-only collapse desyncs the two, and several skills read the line form.
- **One shared helper, not a per-verb shape.**
  [`packages/fabrika-cli/src/evidence.ts`](../packages/fabrika-cli/src/evidence.ts) exports both
  collapses as pure functions. It sits beside the `answer()` seam in
  [`packages/fabrika-cli/src/verb.ts`](../packages/fabrika-cli/src/verb.ts) rather than inside it,
  because that module owns the answer channel and takes an already-serialized string — payload
  shaping happens before serialization and is a different concern. The five private tallies in the
  package (`spend/rollup.ts`, `ci/changelog.ts`, `map/frontier.ts`, `governance/roots.ts`,
  `review/classes.ts`) are each shape-specific and stay where they are.
- **Histogram key order is count-descending, ties on the reason.** The object is serialized straight
  into the payload, so key order is bytes a reader and a golden fixture both see; deriving it from
  row order would make one tally print two ways depending on which issue the board listed first.

### Why (a) and (b) lost

- **(a) Quiet by default, full payload behind a flag.** It needs the same per-field
  answer-vs-evidence judgement anyway — a quiet mode has to know what to keep — so its 24-file seam
  refactor (`answer()` taking an object plus a projection, plus the copied `emit` adapter in every
  group's `command.ts`) buys nothing the classification does not already deliver. It also adds a
  user-facing surface, and a caller who forgets the flag gets a silently narrower answer.
- **(b) Evidence moves to a separate verb.** ~35 new verbs, and a second round-trip for any caller
  that genuinely wants the evidence — which, on the measurement, is nobody.

### The governance readings

- **ADR [0112](0112-token-measurement-no-quality-compromise-methodology.md)'s measurement gate does
  not apply.** That methodology gates levers that *trade* quality for tokens: a frozen task set, a
  reproducible meter, and quality regression as a veto. Collapsing rows no caller reads trades no
  quality — there is no output whose quality could regress, because no skill's behaviour depends on
  the rows. What replaces the gate is the classification itself: the risk here is mis-classifying an
  answer as evidence, and that is caught by reading the field's skill/contract corpus per field, not
  by a token meter.
- **ADR [0200](0200-reject-context-mode-token-lever.md) is a different lever, and there is no
  contradiction.** 0200 rejected an external context-mode plugin partly because context volume was
  not the dominant spend axis on the evidence then. This is not that plugin and not that mechanism:
  it removes bytes the CLI itself emits, with no new dependency, no hooks and no MCP surface. The
  later measurement (cache reads ~55% of the bill) updates the evidence 0200 read, it does not
  overturn 0200's rejection of that tool.

### Two of the ruling's own examples flipped under the per-field check

The ruling demanded the classification be verified per field before any collapse. Two of the
examples named in the ruling and the report did not survive that check the way they were named:

- **`grill read`'s `questions` is an answer-array and is not touched.**
  `claude-plugins/fabrika/skills/grilling/contract.md:760` states the prose is carried "so a caller
  can name the open questions to the founder without a second read", and
  `claude-plugins/fabrika/skills/grilling/SKILL.md:160` makes one state row per question the
  done-condition. It was cited as the worst evidence offender; it is the clearest answer-array in the
  CLI.
- **`build pick`'s `excluded` survives as evidence**, and is the exemplar collapse.
  `claude-plugins/fabrika/skills/build/SKILL.md:53` hands the reader the reason *vocabulary* — a
  histogram satisfies it exactly — and nothing anywhere reads an excluded issue's number or home.

## Per-field classification

Seeded here with the `build` group; the remaining groups are filled in by the closing sweep of epic
[#6147](https://github.com/kamp-us/phoenix/issues/6147), so no field is re-litigated ticket by
ticket. A field absent from this table has not been classified yet and stays whole until it is.

| Verb | Field | Class | Shape | Why |
|---|---|---|---|---|
| `build pick` | `pool` | answer | whole, `--limit`-capped | the reader picks from it (`build/SKILL.md:51-52`) |
| `build pick` | `excluded` | evidence | reason histogram | reason vocabulary is all a reader acts on; no row is read by name (`build/SKILL.md:53`) |
| `build pick` | `campaigns.milestones` | evidence | whole — bounded | one entry per active campaign; the skill reads the state beside it, not the rows |
| `build check` | `unvalidated` | answer | whole | the skill routes on it: a file class here sends the reader to another surface (`build/SKILL.md:181-185`, `:190`) |
| `build check` | `ran` | evidence | whole — bounded | an echo of the declared validators (config-bound; ≤2 on the prose/plan surface) |
| `build issue` | `criteria.items` | answer | whole | every criterion must map to something the builder can point at (`build/SKILL.md:153`) |
| `build issue` | `labels` | evidence | whole — bounded | an issue's labels; shape-documented only, never iterated by a skill |
| `build verdicts` | `rows` | answer | whole | "Act only on rows it prints" (`build/SKILL.md:340`) |
| `build verdicts` | `frozenCriteria` | answer | whole | the skill is told to note each row (`build/SKILL.md:359-360`) |
| `build verdicts` | `clearances` | evidence | whole — bounded | the decision is `capReached`, never a count derived from these rows (`build/SKILL.md:342`); one row per grant, and always empty on the `--issue` arm |

The `build` group's other verbs (`branch`, `commit`, `clear`, `pr`, `pr-body`, `claim`, `confirm`,
`release`, `adopt`, `note`, `eligible`, `scratch`, `tree`, `push`) print no array-valued field on the
answer channel — their multi-line context rides the stderr notes channel, which is not this ADR's
surface.

## Consequences

- `build pick`'s payload drops from ~21,478 bytes to roughly 3,500 on the measured board, with the
  auditability the contract defends intact: the reasons and their counts are still on the answer
  channel.
- **A mis-classification is a silent break.** Collapsing an answer-array leaves the skill that
  iterates it reading a shape that no longer exists, and nothing fails loudly. Every collapse
  re-verifies the field against the live skill/contract corpus first — the ruling's own examples show
  why a remembered classification is not one.
- **Contracts move with their verb, in the same PR.** A contract line pinning the old array shape is
  a reader acting on a shape that is gone.
- Each collapsing change asserts the new shape in that verb's own unit test; the helper is pure and
  tested directly. No new gate.
- This is a CLI-output convention, not product vocabulary: **answer-array** and **evidence-array**
  are defined here and `.glossary/LANGUAGE.md` is untouched.

## Grounding

- [#5641](https://github.com/kamp-us/phoenix/issues/5641) — the question, the measurement, and the
  ruling comment.
- [#6147](https://github.com/kamp-us/phoenix/issues/6147) — the epic executing it, with the full
  source sweep behind the table above.
- [`packages/fabrika-cli/src/evidence.ts`](../packages/fabrika-cli/src/evidence.ts) — the two
  collapses.
- [`claude-plugins/fabrika/skills/build/contract.md`](../claude-plugins/fabrika/skills/build/contract.md)
  — the exemplar's pinned output shape.
