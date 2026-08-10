---
id: 0252
title: dispersion is a minority-verdict count, a two-week decline is a separated half-window drop, and the trend co-gate ships observe-only
status: accepted
date: 2026-08-10
tags: [fabrika, eval, decisions]
---

# 0252 — `dispersion` is a minority-verdict count, a two-week decline is a separated half-window drop, and the trend co-gate ships observe-only

**What this decides:** the two values the fabrika grading chain names and never defines. `dispersion`
(#4678) is the minority-verdict count of the graded axis's five runs, it is recorded, and it gates
nothing. A "two-week decline" (#4680) is a mean drop of at least 5 points between two non-overlapping
7-day halves of the trailing 14 days. And the trend co-gate ships **observe-only**: it reports its
answer and cannot red a PR until the criterion has been watched against a real series.

## Context

The grading chain under epic [#4649](https://github.com/kamp-us/phoenix/issues/4649) names two
load-bearing values and defines neither.

- [#4678](https://github.com/kamp-us/phoenix/issues/4678) requires `dispersion` as an output of the
  5-run graded axis and requires the head-bound eval-result artifact to carry it. Nothing says what
  it is. A count, a spread, a variance and a per-run list are all consistent with the text.
- [#4680](https://github.com/kamp-us/phoenix/issues/4680) states the trend co-gate in prose only —
  "a two-week decline in the graded pass rate is flagged *before* the 90% line is crossed" — with no
  input series, no window arithmetic, no minimum sample, no threshold, and no rule separating
  declining from flat or noisy. Its own acceptance criterion demands a unit test that discriminates
  exactly that, which is unsatisfiable against nothing.
- [#4681](https://github.com/kamp-us/phoenix/issues/4681) makes the undefined half a merge verdict:
  `below-bar` reds when the recorded graded pass rate is under 90% **or** the trend co-gate flags a
  two-week decline.

So an implementer had to invent a threshold, and the invention would sit inside a fail-closed merge
gate where nobody would see it again ([#4766](https://github.com/kamp-us/phoenix/issues/4766)).

Two rulings bound this record. [#4637](https://github.com/kamp-us/phoenix/issues/4637) ruling 2 made
the trend a co-equal gate that flags before the 90% line is crossed; that ruling states the concept
and not the formula, so naming the formula is a specification act, not a re-opening of a ruled
number. The founder ruling on #4766 then delegated both definitions to engineering — the eval
harness is pipeline infrastructure, which is engineering's lane under ADR
[0078](0078-product-driven-decisions-by-default.md) — under one binding guardrail:

> Whatever threshold is picked, it must never red a PR until it has been observed working on real
> data first.

#4766's triage also corrected the reported shape of the `dispersion` half: neither #4680 nor #4681
mentions `dispersion` anywhere, so it is a required output with no consumer that names it, and the
founder asked engineering to decide whether it is defined or dropped rather than defined by default.

## Decision

### 1. `dispersion` is the minority-verdict count over the graded axis's five runs

The graded axis runs a case five times and takes the median verdict. Each run's verdict is binary,
so five runs split into a majority and a minority, and the minority count is the whole of what the
median throws away.

```
dispersion = min(passed, runs − passed)
```

- **Shape:** one integer. **Units:** runs. **Range at `runs = 5`:** 0, 1 or 2.
- **Reading:** `0` is unanimous, `1` is a 4–1 split, `2` is a 3–2 split — a verdict that came down to
  one run.
- **Derivation:** from the five per-run verdicts alone. It needs no model, no history and no second
  pass over the case.

The head-bound eval-result artifact #4678 requires carries it as three integers beside the verdict:

```json
{"runs": 5, "passed": 3, "dispersion": 2, "verdict": "pass"}
```

`runs` and `passed` are carried too so a reader re-derives `dispersion` instead of trusting it. A
stored aggregate whose inputs are absent is a number nobody can check.

### 2. `dispersion` is recorded and read; it never gates

`dispersion` is **defined, not dropped**, and its consumer is named: the committed scorecard row
(#4680) carries it, and a human reading a scorecard or an eval-result artifact is who reads it. The
bar gate (#4681) does **not** read it — no verdict in that gate's list branches on `dispersion`, now
or at arming.

It is kept because a 3–2 median-pass and a 5–0 median-pass are the same verdict and different facts:
the first is a case one run away from failing, and the artifact is the only place that difference
survives the median. It gates nothing because a flakiness signal wired into a merge verdict blocks
work on variance the change under review did not cause.

#4678's prose claim that "the trend gate later reads" `dispersion` is **wrong and is corrected
here**: the trend gate reads the pass-rate series and nothing else.

### 3. A "two-week decline" is a separated half-window drop of at least 5 points

**The input series.** One point per **committed scorecard**
(`claude-plugins/fabrika/reports/eval/<date>.json`), carrying that scorecard's graded pass rate for a
**single** `(stage × surface × model)` cell. Points from different cells are never mixed — a pass
rate measures one grading regime, so one series exists per cell key. Order by the scorecard's
`recordedAt`, ties broken by file name ascending.

**The window.** Let `T` be the `recordedAt` of the most recent point in the series. The window is
`[T − 14 days, T]`, split at the 7-day mark:

- older half: points in `[T − 14 days, T − 7 days)`
- newer half: points in `[T − 7 days, T]`

The window is anchored on the newest point, not on wall-clock now, so the answer is reproducible
from the committed files alone — the same property the head-bound verdict depends on.

**Minimum sample.** At least **3 points in each half**. Below that the answer is
`insufficient-data`.

**The criterion.** With `old` and `new` the two halves' pass rates, the series is `declining` iff
**both** hold:

1. `mean(old) − mean(new) ≥ 0.05`
2. `max(new) < min(old)`

Otherwise the series is `steady`. Rates are compared at full precision as `passedRuns / gradedRuns`,
with no rounding before the comparison; clause 1 is inclusive at the boundary and clause 2 is strict.

**The three outcomes are `declining`, `steady`, and `insufficient-data`.** The third is not a pass:
a window that cannot be read is unknown, and folding it into `steady` is the zero-scope green ADR
[0092](0092-gates-fail-closed-on-zero-scope.md) forbids.

**Why clause 2 exists.** Clause 1 alone is cleared by a noisy flat series often enough to be
useless — half-means wander. Requiring the halves not to overlap says every recent measurement is
below every earlier one, which is drift and not scatter. That clause is also what makes #4680's
acceptance criterion — "a declining series flags, a flat or noisy series does not" — a test somebody
can actually author. Worked, with three points per half:

| series (old \| new) | mean drop | overlap | answer |
|---|---|---|---|
| `0.98, 0.97, 0.96` \| `0.90, 0.89, 0.88` | 0.08 | none (0.90 < 0.96) | `declining` |
| `0.95, 0.94, 0.96` \| `0.95, 0.94, 0.96` | 0.00 | overlaps | `steady` |
| `0.99, 0.85, 0.98` \| `0.99, 0.80, 0.83` | 0.067 | overlaps (0.99 ≥ 0.85) | `steady` |
| 5 points, 2 of them in the newer half | — | — | `insufficient-data` |

**Where 0.05 comes from, and how far to trust it.** Five points is one case in a twenty-case corpus
and half the distance from a healthy 0.95 to the ruled 0.90 bar, so a single case regressing does not
flag and two do. It is deliberately strict: while the gate is unarmed a missed decline costs a week
of watching, and once armed a false flag blocks healthy work. The three numbers — `0.05`, the
3-point minimum, and the 14/7-day window — are a **starting point calibrated against the
observe-only record before they may block anything** (§4), not a measured constant.

### 4. The trend co-gate ships observe-only, and `below-bar` does not read it yet

The founder guardrail is binding, so the sequencing is: **define it, ship it observing, watch it
against a real series, and only then let it block.**

- #4681's `below-bar` reds on **one** condition: the recorded graded pass rate is under the ruled
  90%. The trend clause is **not** part of that red today.
- The trend answer is reported on the same verdict as an advisory line —
  `trend: declining | steady | insufficient-data`, naming the cell and the window it read — and it
  never changes the exit status.
- Every evaluation is recorded, including the ones that would have flagged. The record is what a
  later arming decision is ruled on; a gate nobody watched has nothing to arm from.

**Arming is a separate, later decision** and needs a record to rule on: at least eight weeks of
committed scorecards evaluated observe-only, **zero** flags on series a reviewer judges healthy, and
either one correctly-flagged real decline or an explicit ruling to arm on the false-positive record
alone. That decision gets its own ADR, and it is the one that edits `below-bar`.

This does not weaken #4637 ruling 2. The trend still flags before the 90% line is crossed — flagging
is what observe-only does. What is deferred is only its authority to block, which is exactly what the
guardrail defers.

## Consequences

A builder of #4678, #4680 and #4681 now implements against written arithmetic instead of inventing a
threshold, and #4680's discriminating unit test can be authored from the worked table above.

The chain's issue bodies still say what they said. This ADR is the source; the amendments that make
#4678, #4680 and #4681 cite it are a separate write, and until they land a builder who reads only the
issue body will not find this file. That is the residue #4766 leaves open, not a claim that it is
closed.

`dispersion` costs two extra integers on every eval-result artifact and one extra column on a
scorecard row. That is the price of being able to tell a 3–2 pass from a 5–0 one after the fact.

While the co-gate is unarmed the pipeline can regress for two weeks without a merge being blocked for
it. That is accepted on the guardrail's own argument: an unwatched threshold with merge authority is
the worse failure, and the 90% bar is still armed the whole time.

The 0.05 threshold, the 3-point minimum and the 14/7-day window are the most likely things in this
record to change. They are written here rather than in code comments so that changing them is a
recorded decision.
