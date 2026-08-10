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
nothing. A "two-week decline" (#4680) is a mean drop of more than 5 points between two non-overlapping
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

### 3. A "two-week decline" is a separated half-window drop of more than 5 points

**The input series.** One point per **committed scorecard**
(`claude-plugins/fabrika/reports/eval/<date>.json`), carrying that scorecard's graded pass rate for a
**single** `(stage × surface × model)` cell. Points from different cells are never mixed — a pass
rate measures one grading regime, so one series exists per cell key. Order by the scorecard's
`recordedAt`, ties broken by file name ascending.

**The ordering key does not exist yet, and this record does not pretend otherwise.** `Scorecard`
(`packages/fabrika-cli/src/eval/report.ts`) carries `decisionRef`, `framing`, `baseline` and
`cells` — no timestamp of any kind — and the `committed scorecard` glossary row already says so,
recording the date pin as one of #4680's open calls. So the criterion here is **specified ahead of
its input: it cannot be evaluated until #4680 lands the date pin its own AC1 requires.** That
dependency is the blocker, not a caveat. `recordedAt` is this ADR naming the spelling that pin
should use — the same word the spend ledger already stamps on its header and every row, so the
package keeps one name for one thing. If #4680 rules a different spelling, the ordering key is
whatever it rules; nothing else below changes.

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

1. `round(mean(old) − mean(new), 4) > 0.05`
2. `max(new) < min(old)`

Otherwise the series is `steady`. **Both clauses are strict**: a drop of exactly 5 points is
`steady`, not `declining`. The calibration below is why the boundary sits there.

Rates are the individual `passedRuns / gradedRuns` values at full precision. The **only** rounding
is the one written into clause 1 — applied to the half-mean difference, immediately before the
comparison, at 4 decimal places — and it is load-bearing rather than cosmetic. `0.05` is exactly
the drop one regressing case produces in a twenty-case corpus, and in IEEE-754 that drop straddles
the constant instead of landing on it: two arithmetically identical one-case regressions compute
`0.04999999999999982` and `0.050000000000000044`, on opposite sides of `0.05` under *either*
polarity. Without a stated rounding, the criterion's answer at its own boundary would depend on
which cases happened to move. Four decimal places is about a trillion times coarser than the
double error and one five-hundredth of a case, so it settles the boundary without hiding any
movement a twenty-case corpus can produce.

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
| `0.95, 0.95, 0.95` \| `0.90, 0.90, 0.90` | 0.05 | none (0.90 < 0.95) | `steady` — clause 1 is strict |
| 5 points, 2 of them in the newer half | — | — | `insufficient-data` |

Row 3 is the noisy-flat case clause 2 exists for. **Row 4 is the boundary**, and it is the one row a
reader is most likely to guess wrong: one regressed case out of twenty, the halves cleanly separated,
clause 2 satisfied — and still `steady`, because clause 1 is strict and the drop is exactly `0.05`.
That row is the one fixture the discriminating test in #4680 most needs.

**Where 0.05 comes from, and how far to trust it.** Five points is the whole distance from a healthy
0.95 to the ruled 0.90 bar, and — the reason clause 1 is strict — it is *exactly* one case in a
twenty-case corpus. A threshold that fires on one case's worth of movement is not a threshold; it is
"something moved down", and clause 2 already rejects scatter. So the line is drawn just above the
corpus's own smallest step: **one case regressing is `steady`, two cases (a `0.10` drop) is
`declining`.** Drawing it just below instead would have made every single-case regression a flag,
which is the inclusive reading this record deliberately does not take.

It is deliberately strict for the same reason: while the gate is unarmed a missed decline costs a
week of watching, and once armed a false flag blocks healthy work. The three numbers — `0.05`, the
3-point minimum, and the 14/7-day window — are a **starting point calibrated against the
observe-only record before they may block anything** (§4), not a measured constant. The twenty-case
corpus the derivation leans on is provisional too: today's figure is measured over a corpus-shaped
stand-in until the fabrika incident corpus ([#4675](https://github.com/kamp-us/phoenix/issues/4675))
lands. If the corpus size moves, the one-case step moves with it and `0.05` has to be re-derived.

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

**The criterion is blocked on one input it does not own.** Ordering the series needs a per-scorecard
timestamp, and `Scorecard` carries none — so #4680 must land the date pin its own AC1 requires before
anything here can be evaluated, even observe-only. §3 names `recordedAt` as the spelling to use;
until it exists, this record is a specification, not a computation.

`dispersion` costs two extra integers on every eval-result artifact and one extra column on a
scorecard row. That is the price of being able to tell a 3–2 pass from a 5–0 one after the fact.

While the co-gate is unarmed the pipeline can regress for two weeks without a merge being blocked for
it. That is accepted on the guardrail's own argument: an unwatched threshold with merge authority is
the worse failure, and the 90% bar is still armed the whole time.

The 0.05 threshold, the 3-point minimum and the 14/7-day window are the most likely things in this
record to change. They are written here rather than in code comments so that changing them is a
recorded decision.
