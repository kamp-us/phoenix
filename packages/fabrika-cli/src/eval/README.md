# eval — fabrika's eval harness

The graded per-stage **corpus** apparatus for the token-economics program (epic
[#1842](https://github.com/kamp-us/phoenix/issues/1842), extending ADR 0112).

## What it is

A typed data model + on-disk format for a **labeled corpus per pipeline stage** — the
version-controlled ground truth every later evaluation slice reads and writes — plus the
**repair-churn cost** core that prices a stochastic model swap on net tokens. The first
slice ([#1848](https://github.com/kamp-us/phoenix/issues/1848)) shipped the corpus
**format + its decode/encode core**; the churn core
([#1850](https://github.com/kamp-us/phoenix/issues/1850)) is documented under
[Repair-churn cost](#repair-churn-cost-net-token-pricing-of-a-model-swap) below.

- `CorpusEntry` — one labeled input for one stage: `{ stage, inputRef, label }`, where
  `inputRef` is a reproducible identifier (issue/PR number) and `label` is the known-good
  decision artifact. It is a **discriminated union keyed on `stage`**, so a label whose
  shape doesn't match its stage is unrepresentable (make-invalid-states-unrepresentable):
  - `triage` → `{ type, priority, status }`
  - `build` → `{ fixesRef, ciGreen, reviewVerdict }`
  - `review` + `surface: "code"` → `{ verdict, acFindings }`
  - `review` + `surface: "doc"` → `{ verdict, findings }`
  - `review` + `surface: "skill"` → `{ verdict, rigorFindings: { check, finding }[] }`
  - `ship-it` → `{ merged, mergeSha }`
- `CorpusManifest` — the frozen ground truth: entries grouped under **live** stage keys, each
  key admitting only that stage's entry (the second half of the unrepresentable guarantee).

### The `review` stage's surface sub-discriminator

The v1 review gates merged into one `review` skill, so the corpus keeps **one** `review` stage key
and every review entry carries a `surface` that selects both its label shape and its grader ([ADR
0243](../../../../.decisions/0243-review-eval-stage-surface-discriminator.md)). The three label
shapes genuinely differ (`acFindings` vs `findings` vs `rigorFindings`), so the guarantee holds over
the **`(stage, surface)` pair**: a `review` entry whose label doesn't match its surface is
unrepresentable, and a `review` entry with **no** surface is a decode failure, never a row a
fallback rubric grades. `gradeEntry` narrows the same way — `stage` to `review`, then `surface` to
its own grader — because dispatching on `stage` alone is what would silently collapse three rubrics
onto one grader. One PR reviewed on two surfaces is two rows sharing an `inputRef`, each graded by
its own grader; that is the intended shape, not a duplicate.

`REVIEW_SURFACES` names all three: `code`, `doc` and `skill`.

The `skill` surface's label is the one that is not a flat array of finding strings. Its findings each
name the rubric check they came from, drawn from the closed vocabulary `SKILL_RIGOR_CHECKS` — the
four numbered checks in
[`rubrics/skill.md`](../../../../claude-plugins/fabrika/skills/review/rubrics/skill.md). That rubric
is the only one of the three whose checks are a fixed set, and it hands gate-invariant preservation
to the `governance` skill, so a row cannot attribute a finding to a check this surface does not own.
[ADR 0243 §1a](../../../../.decisions/0243-review-eval-stage-surface-discriminator.md) records the
derivation and why the findings are not flattened.

### Live stage key vs recorded provenance

`STAGES` is the **live** vocabulary — what `--stage` accepts and what a manifest groups under.
An entry's own `stage` is **provenance**: the stage that actually produced that row. The two
coincide for anything measured from now on and differ for the rows the v1 pipeline recorded.

The founder ruling on [#4977](https://github.com/kamp-us/phoenix/issues/4977) fixes what happens
to those rows: they keep their original key, because re-keying them would republish a v1
measurement as a fabrika one. So `build` is the live stage, `write-code` is not a stage any more,
and the three rows in `corpus/build.json` are still keyed `write-code` — the decoder accepts that
key on an already-recorded row and nowhere else. The same holds for the review merge: `review` is
the live stage, `review-code` and `review-doc` are not stages any more, and the rows in
`corpus/review.json` keep their `review-code` key and carry **no** `surface`, since `surface` is a
live-schema field. Read a record's stage key as *what was run*, never as a pointer into `STAGES`;
joins (the runner, the scorecard) key on the live stage.
- `decodeManifest(text)` — total: returns a typed `Result` failure (`malformed-json` or
  `schema-mismatch`) on bad input, never throws. `encodeManifest(manifest)` round-trips it.

## Stage-admission rule — a stage exists when its skill does

`STAGES` is not a plan of the fabrika skill set. It is a record of what this harness can actually
grade, so a name enters it when **both** of these are already true, and not before:

1. **Its skill exists** — there is a `SKILL.md` for it under
   [`claude-plugins/fabrika/skills/`](../../../../claude-plugins/fabrika/skills), so
   `fabrika eval run --stage <name>` has something real to spawn.
2. **There is something to grade under it** — committed ground truth (a corpus entry, or an eval
   set) that a grader arm can score, landing in the same change as the stage key.

Admitting a name earlier buys a permanently-empty manifest key and a grader arm nothing can reach,
and the vocabulary then describes stages nobody runs — the drift epic
[#4960](https://github.com/kamp-us/phoenix/issues/4960) exists to remove. So growth is per-skill and
demand-driven: the change that authors a skill's first cases is the change that adds its `STAGES`
member, its `CorpusManifest` key and its `oracle.ts` grader arm, together.

`stage-admission.data.unit.test.ts` is the enforcement — a `STAGES` member with no grader arm, no
manifest key, or no skill on disk turns the suite red, and an empty `STAGES` is a failure rather than
a vacuous pass (ADR [0092](../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)).

A stage key and its skill's directory name need not be identical; `ship-it` is the one that differs
today (its skill is `ship`). Renaming it is deliberately not this harness's call — #4960 leaves
`ship-it` alone pending the lane that owns skill naming.

### Fabrika surfaces that deliberately have no stage today

Named here so the gap reads as a decision rather than an oversight:

- `build-ui` — the skill exists, but no ground truth has been committed for a rendered-visual build,
  so clause 2 is unmet. It is admitted the moment its first cases land.
- `review-ui` — the same shape: the skill exists, its ground truth does not.
- `governance` — no skill exists yet. `review`'s skill rubric hands gate-invariant preservation to
  it, so the name is referenced before the skill is written; clause 1 is unmet.
- `check-epic-plan` — no skill exists yet. Plan review is `review`'s explicit non-scope, and until
  the skill is authored there is nothing to spawn.
- `build-epic`, `report`, `adr` — authored skills with no committed ground truth, so clause 2 is
  unmet for them too. They are not excluded on principle; nobody has recorded a baseline yet.

### Stages carrying zero committed corpus entries

A stage that is admitted but ungraded is a **recorded choice**, not an oversight, and it is listed
here so a reader can tell the two apart. The data test keeps this list honest in both directions: a
stage that drops to zero entries without being listed turns the suite red, and so does a stage
listed here that actually carries entries.

- `ship-it` — admitted before this rule was written, and no `ship` run has been recorded as ground
  truth yet. It stays in the vocabulary because `--stage ship-it` is accepted and its grader is
  reachable; its pass-rate is simply undefined until entries land.

## The graded oracle ([#1849](https://github.com/kamp-us/phoenix/issues/1849))

`gradeEntry(entry, artifact): Grade` (`oracle.ts`) is the per-corpus-entry quality grade. ADR
[0112](../../../../.decisions/0112-token-measurement-no-quality-compromise-methodology.md) §3
defines a per-stage output-quality oracle — a reproducible pass/fail that an optimized stage
reproduced the **same decision artifact** as the baseline — as a *binary* over one frozen input.
This generalizes it to grade **each** corpus entry, so the report slice can compute a pass-*rate*
over the whole set. It is pure and consumes an already-collected artifact — it does **not** spawn
a stage or call `gh` (that is the runner slice, #1851).

An entry passes iff the observed `artifact` reproduces its known-good `label`, per stage (ADR 0112 §3):

- `triage` — actual `{type, priority, status}` equals the label.
- `build` — the PR carries the labeled `Fixes #N` + CI green + an independent `review-code: PASS`
  (actual `{fixesRef, ciGreen, reviewVerdict}` equals the label).
- `review` / `code` — actual verdict + AC-finding **set** match the label (findings compared order-
  and duplicate-insensitively).
- `review` / `doc` — actual verdict + doc-finding set match the label.
- `ship-it` — actual `{merged, mergeSha}` equals the label.

The grade is a typed value, never a throw:

- `{ status: "pass" }`, or
- `{ status: "fail", mismatch }` where `mismatch` is either a `LabelMismatch` carrying the
  per-field observed-vs-expected diffs (so the report can attribute *why* a (stage × model) missed —
  a fail is never a bare boolean), or a `MalformedArtifact` with a stated reason. The grader is
  **total**: a malformed or absent artifact grades `fail` with a reason rather than throwing.

## The corpus runner ([#1851](https://github.com/kamp-us/phoenix/issues/1851))

`runner.ts` is the **collection layer** between the corpus format and the report slice: it turns
a corpus manifest into **graded runs** for a chosen (stage × model). For each corpus entry it
grades the entry's actual run `artifact` (via `oracle.ts` `gradeEntry`) and reconstructs the
run's token spend from its sub-agent transcript (via the [`token-spend`](../spend/token-spend.ts)
core, ADR 0112 §2), producing a `{entry, grade, spend}` **row**. A per-(stage × model) collection
of those rows is the raw material the report slice ([#1853](https://github.com/kamp-us/phoenix/issues/1853))
aggregates into pass-rate + churn cost.

The runner is a deterministic, side-effect-light **collector over runs that already happened** — it
spawns nothing itself, which is what makes it reproducible offline. That property still holds for
`runner.ts` and for every other core here, but it is **no longer true of the module**: `run` (below)
starts processes from `spawn-io.ts`. The reversal and its bounds are [ADR
0236](../../../../.decisions/0236-eval-harness-gains-a-spawning-shell.md).

`RunRow` is `{entry, grade, spend, provenance}` where `spend` is a **three-arm** `RunSpend` union — declared,
with `classifyRunSpend` that produces it, in [`../spend/token-spend.ts`](../spend/token-spend.ts)
next to the meter it wraps ([#5050](https://github.com/kamp-us/phoenix/issues/5050)):
`{_tag: "Reconstructed", spend}` (the `token-spend` `StageSpend`), `{_tag: "NoBilledTurns"}`, or
`{_tag: "TranscriptMissing"}`. None of the three can be mistaken for a genuinely free run — a
**missing transcript is graded and counted, never a crash**, and a transcript that is present and
well-formed but carries **zero billed assistant turns** gets its own arm rather than a zero-valued
`Reconstructed`: that is exactly what a run whose skill failed to resolve writes, and folding it in
would restore the fabricated zero this union exists to prevent.

Two modes, story-split:

- **Offline / replay (story 6)** — `collectRuns(inputs)` over already-loaded transcripts + recorded
  artifacts, where each `RunInput` is `{entry, transcript, artifact}` (a `null` transcript folds in as
  `TranscriptMissing`). This is the reproducible, no-spawn path a CI or a re-analysis uses. Grading is
  total (a malformed artifact grades `fail` via the oracle) and spend reconstruction is fail-open (a
  malformed transcript undercounts, never throws) — so a whole corpus resolves without a crash.
- **Capture-manifest (story 7)** — `CaptureManifest` is the documented shape naming, per run, the
  transcript path + the recorded artifact, keyed by `(stage, inputRef)` so a fresh live run folds
  into the corpus deterministically. The path takes either of the two real shapes: a **Task-spawned
  sub-agent**'s `<parent-session-id>/subagents/agent-<id>.jsonl` (ADR 0112 §2), or a **headless
  `claude -p` run**'s `<claude-data-root>/projects/<cwd-slug>/<session-id>.jsonl` — the latter is a
  top-level session, so it is not under `subagents/`. Both reconstruct through the same
  `token-spend` core, verified against the run's own `result.usage`. `decodeCaptureManifest(text)` is total (typed
  `Result` failure on malformed JSON or a schema mismatch). `collectFromCapture({stage, corpus,
  capture, loadTranscript})` joins each capture run to its corpus entry (for the ground-truth label),
  loads transcripts through the caller-supplied `TranscriptLoader` (keeping the core pure — the
  command shell supplies an fs-backed loader), and collects the graded rows.

```ts
import {collectRuns, collectFromCapture, decodeCaptureManifest} from "./runner.ts";
```

### What provenance a capture manifest carries ([#4996](https://github.com/kamp-us/phoenix/issues/4996))

A ledger (`--out`) and a capture manifest (`--capture-out`) are not equally attributable, and the
gap used to be silent. The ledger names the suite's skill, stage, model, CLI version and
`recordedAt` on its header and repeats them on every spend row; the manifest is the file the
scorecard and `collectFromCapture` actually read, and it survives on its own long after the ledger
is gone. So each `CaptureRun` now carries the two facts a graded row cannot be re-derived without:

| field | carried | why |
|---|---|---|
| `stage`, `inputRef` | yes | the join key onto the corpus's ground-truth label |
| `model` | yes | the model the run was **pinned** to (`--model`) — the axis the scorecard compares along |
| `arm` | yes | `with-skill` / `without-skill`, otherwise unrecoverable once both arms fold into one file |
| `transcriptPath` | yes | but it points **outside the repo**, under the `claude` data root: machine-local and perishable |
| skill name, CLI version, `recordedAt` | **no** | ledger-only; a manifest is a per-run artifact, not a suite record |

`model` and `arm` are `null` on a manifest written before they existed, and an absent key decodes
to `null` rather than failing — every already-written manifest stays readable. Read `null` as
*unrecorded*, never as a claim about the run.

The scorecard consumes this as a **preference, not a replacement**: `report.ts` buckets a row on
the model the run recorded, and falls back to the model reconstructed from the transcript only
when the row recorded none. That is what stops a row whose transcript is gone from bucketing as
`(unknown)` — it degrades exactly to the old behaviour, and only for the rows that predate the
field.

Presenting the collected rows (the two-axis scorecard) is the report slice
([#1853](https://github.com/kamp-us/phoenix/issues/1853)), documented next.

## The report — graded two-axis scorecard ([#1853](https://github.com/kamp-us/phoenix/issues/1853))

`report.ts` is the **top of the vertical slice** and the evidence artifact the model-tiering
decision ([#1576](https://github.com/kamp-us/phoenix/issues/1576)) consumes. It aggregates the
runner's graded `{entry, grade, spend}` rows into a per-(stage × model) **scorecard** on the ADR
0112 §4 two-axis gate, now graded:

- **Quality axis** — a **pass-rate** per (stage × surface × model) over the corpus
  (`passedRuns / gradedRuns`), the graded generalization of ADR 0112 §3's binary-per-run oracle.
- **Token axis** — the mean **billed** + **ex-cache-read** spend per run (ADR 0112 §2), plus the
  priced **repair-churn cost** (`repair-churn.ts`): the amortized true cost of one *accepted* run
  once the extra cycles a lower pass-rate forces are amortized in.
- **Net saving vs a baseline** — when a `baseline` cell is named, each other cell's
  `netSaving = baseline.billedPerRun − candidate.amortizedBilledPerRun`. A **negative** net saving is
  the epic's headline risk — a per-run token saving *eaten* by repair churn — rendered as
  `NET-NEGATIVE` in the table and `netNegative: true` in the JSON, so the crossover the
  binary-per-run gate cannot see is impossible to miss.

The report is **measurement, not a recommendation**: it states pass-rate + net-token cost per cell
and never selects or recommends a model — that call is #1576, a separate `type:decision`. Both
rendered surfaces carry a framing line pointing at #1576, and the JSON has no
`recommendation`/`selectedModel`/`winner` key by construction.

Pure + total: a `TranscriptMissing` run still counts toward the pass-rate but is absent from the
spend mean, and a cell with **no** reconstructed spend reports a `null` token axis rather than a
fabricated zero. `buildScorecard`, `renderTable`, `toJson`, and `decodeReportInput` are the exports.

#### The cell key carries the review surface

A pass-rate measures **one grading regime**, so the cell key is `(stage × surface × model)` and rows
from different review surfaces are never aggregated into a single undifferentiated `review` number
([ADR 0243 §4](../../../../.decisions/0243-review-eval-stage-surface-discriminator.md)). The
exported `CellIdentity` states that as a type: a `review` cell carries a `ReviewSurface`, every other
stage carries `null`, so a bare `review` cell is unrepresentable rather than merely unproduced. The
mixed-surface PR of ADR 0243 §3 — one `inputRef`, one row per surface — therefore reports two cells,
each rendering its own surface. A recorded v1 `review-code` row keeps its own cell and takes the
surfaceless arm, because its stage key is provenance, not a live `review` row
([#4977](https://github.com/kamp-us/phoenix/issues/4977)).

The baseline resolves against that same key, so it selects **at most one** cell. `--baseline-stage
review` therefore requires `--baseline-surface`: without one it names two graders, which is refused
at the flag rather than resolved to whichever surface buckets first.

### The CLI surface

```bash
# human table (default) — the founder reads this to decide #1576
fabrika eval report <rows.json>

# stable machine-readable JSON — a future gate / CI consumes this
fabrika eval report <rows.json> --json

# price net saving against a baseline (stage × surface × model)
fabrika eval report <rows.json> --baseline-stage build --baseline-model opus-4.8
fabrika eval report <rows.json> --baseline-stage review --baseline-surface code --baseline-model opus-4.8
```

`<rows.json>` is a serialized `RunRow[]` — the array `collectRuns` emits. `decodeReportInput` is
total: a malformed body or a shape mismatch exits non-zero with a typed reason, never a throw.

### The stable JSON shape (the contract a consumer decodes)

```jsonc
{
  "decisionRef": 1576,                       // the decision this evidence feeds — never made here
  "framing": "This scorecard is measurement feeding the model-tiering decision (#1576); …",
  "baseline": { "stage": "build", "surface": null, "model": "opus-4.8" } | null,
  "cells": [
    {
      "stage": "build",
      "surface": null,                        // "code" | "doc" on a `review` cell; null on every other stage
      "model": "opus-4.8" | null,            // the run's recorded model, else the transcript's; null when neither
      "gradedRuns": 3,                        // pass-rate denominator (includes transcript-missing runs)
      "passedRuns": 2,
      "passRate": 0.6667,                     // the graded quality axis
      "spend": {                              // the token axis — null when no run reconstructed
        "billedPerRun": 200,
        "exCacheReadPerRun": 180,
        "reconstructedRuns": 3,
        "transcriptMissingRuns": 0
      } | null,
      "churn": {                              // priced repair churn — null when no reconstructed spend
        "expectedExtraCycles": 0.5,
        "churnTokens": 100,                   // +Infinity when passRate === 0 (never adopt)
        "amortizedBilledPerRun": 300
      } | null,
      "netSaving": -400 | null,               // vs baseline; null on the baseline cell / no spend
      "netNegative": true                     // true iff netSaving is a finite number < 0
    }
  ]
}
```

The shape is stable: field names + nesting are the contract, and `toJson` is a thin projection of
the in-memory `Scorecard` so the JSON and the type never drift.

## The deterministic tier ([#4677](https://github.com/kamp-us/phoenix/issues/4677))

The no-model half of the fabrika eval layer (epic
[#4649](https://github.com/kamp-us/phoenix/issues/4649)). A case whose assertions are all
mechanically checkable never needs a model: it runs its CLI-layer command **once**, and its
assertions are read straight off what that run produced. This is the tier that keeps a
100%-and-growing regression floor cheap enough to sit on every change, and it is where
incident-derived cases are pushed by default (founder ruling 4 on
[#4637](https://github.com/kamp-us/phoenix/issues/4637)); the graded path is the justified
exception, and it is the review stage's, not CI's (the ruling on
[#4649](https://github.com/kamp-us/phoenix/issues/4649#issuecomment-5153280445)).

`deterministic-tier.ts` is the **pure core** — it imports nothing, so it can reach nothing
spawnable, and a unit test reads its import list to keep it that way.
`deterministic-shell-observer.ts` is the **one IO leg**: it spawns a *process*, never a model.

### The one-run protocol, and the flake stance as a mechanism

- `runDeterministicTier({cases, resolveCommand, observe, deferGraded})` routes each decoded case
  by its derived `tier` and executes the deterministic half **exactly once**. `deferGraded` is the
  handoff to the graded tier ([#4678](https://github.com/kamp-us/phoenix/issues/4678)) and the only
  seam here through which a model could ever be reached — it is never called for a deterministic
  case, which is what a caller (or a test) asserts against.
- Nothing in this module re-executes a case to obtain a pass. `reconcileRerun(first, rerun)` exists
  for the opposite purpose: an **agreeing** re-run returns the first row untouched (`runs` stays 1
  — the verdict came from one execution), and a **disagreeing** one returns a `flake` row plus a
  `FlakeDefect` to file through the normal `report` path. A deterministic case that does not
  reproduce is a bug in the case or in the CLI it exercises — surfaced, never quarantined, never
  retried into green.

### Everything unreadable is a case defect, never a pass

`readExpectation` reads a mechanical assertion's prose into a concrete expectation (an expected
exit code, a quoted output substring and its stream, a quoted file path, a quoted tool) with a
deliberately narrow literal reader. Every shape it cannot read becomes `Unreadable`, which reds
the case as `uncheckable`. The direction is the point: a permissive reader that *guessed* an
expectation would report a green nobody earned, whereas an `Unreadable` costs a one-line edit to
the case. The same rule covers a case with no assertions, a case declaring no command, an unknown
cue, and a `tool-invocation` assertion under the shell observer (which cannot see tool invocations
and says so, rather than answering "not invoked").

**Did-not-run is UNKNOWN, not a negative answer.** A command that never started (no binary, a bad
cwd) reports `notRun` and the case reds `uncheckable`; a command that started and was killed
reports `exitStatus: null` with `notRun: null` and genuinely fails. An `exit 127` from a shell that
*did* run is an ordinary answered status, distinct from both.

### One row shape, one aggregation path

Both tiers emit `EvalRow` — `{caseId, tier, outcome, runs, assertions, detail}`, where each
`AssertionOutcome` is the flat `{text, cue, status, detail}` (a judged assertion carries
`cue: null`). `summarizeEvalRows(rows)` is **the** aggregator: graded rows fold in here rather than
through a second path. Its verdict is green only when every row passed, and **zero rows is red**,
never a vacuous green over a corpus the suite could not see (ADR
[0092](../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)).

```ts
import {runDeterministicTier, reconcileRerun, summarizeEvalRows} from "./deterministic-tier.ts";
import {observeShellCommand} from "./deterministic-shell-observer.ts";
```

### Measured cost

**20 deterministic cases, two mechanical assertions each, real subprocess per case: 55–58 ms
(~2.8 ms/case)** — measured on macOS 14 / Node 26 over three consecutive runs. That is well inside
"sits on an ordinary change": the whole tier costs less than a single `tsc` file. The subprocess is
the only cost that matters; the pure judging is free.

Re-measure with the end-to-end suite, which prints the figure:

```bash
pnpm --filter @kampus/fabrika-cli exec vitest run \
  src/eval/deterministic-shell-observer.unit.test.ts --reporter=verbose
```

The suite asserts the observable outcome — a green over cases that hold, a **red** over one that
genuinely fails — and never a wall-clock threshold: a timing assertion is precisely the flaky test
the ruling this tier implements calls a bug. The figure above is measured over a 20-case
corpus-shaped stand-in, because the fabrika incident corpus
([#4675](https://github.com/kamp-us/phoenix/issues/4675)) has not landed yet; re-run the command
above against it once it does and update this number.

## Why it exists

ADR 0112's apparatus grades **one** frozen input per stage with a **binary** oracle —
enough for a deterministic lever flip, not for a stochastic model swap (Opus → Sonnet on a
stage), where an n=1 smoke test can't tell "good enough" from "got lucky." A labeled corpus
big enough for a meaningful pass-rate is the prerequisite for any model-tiering decision.
This module is the shared format that graded slice is built on.

## How to use

The core is a pure library — import `CorpusEntry`, `CorpusManifest`, `decodeManifest`,
`encodeManifest`, and `STAGES` from `corpus.ts`. The CLI has two surfaces — validate a manifest
against the schema, and render the graded scorecard over runner rows:

```bash
fabrika eval check <manifest>    # exit 0 if valid; non-zero on a bad manifest
fabrika eval report <rows.json>  # the graded two-axis scorecard (see below)
fabrika eval cases <evals.json>  # validate an authored eval set (see below)
```

## Repair-churn cost — net-token pricing of a model swap

ADR 0112's token-economics gate is **binary per run**: it prices a stage's spend on one
frozen input, enough for a deterministic lever flip but blind to the downstream cost of a
*stochastic* model swap (Opus → Sonnet on a stage). A cheaper model that fails the gate more
often forces extra write-code→review→repair cycles, and those cycles burn tokens the per-run
saving never counted — the epic's headline risk. `repair-churn.ts` prices that churn so a
swap is judged on **net** tokens, not the per-run delta alone.

Import `repairChurnCost`, `priceModelSwap`, and `tokensFromTranscript` from `repair-churn.ts`.

### The cost model (so the number is reproducible)

- A **repair cycle** is one downstream write-code→review→repair round forced by a gate
  **FAIL** — the pipeline's fix-and-re-review loop, each round costing one repair cycle's
  worth of tokens.
- **`passRate`** is the fraction of *graded* runs for a (stage × model) that **PASS** the
  gate. It counts only repair-forcing gate outcomes: a crash or infra flake is a
  `failure-classifier` **TRANSIENT** death (that classifier is a v1 module and did not move here,
  so it is named, not linked), not a fail the model owns, so it is **excluded** from `passRate` — otherwise churn would be
  inflated with flakiness the swap doesn't cause. Only a `logic`-class gate FAIL is churn.
- **Expected extra cycles** are derived as the **geometric expectation** from a per-attempt
  fail probability. Each attempt passes independently with probability `p = passRate`, so the
  number of attempts until the first pass is geometric with success probability `p`: expected
  attempts `= 1/p`, hence expected cycles **beyond the first** `= (1 − p) / p`.
- **Churn tokens** `= expectedExtraCycles × tokensPerRepairCycle`, and the true cost of one
  *accepted* run is `amortizedTokensPerRun = tokensPerRun + churnTokens`.

Boundaries: at `passRate = 1` the extra cycles are exactly `0` (zero churn); at
`passRate = 0` the model never passes and churn is `+Infinity` — the honest limit of
`(1 − p)/p`, signalling "never adopt" rather than a hidden `NaN`. Invalid inputs (a
`passRate ∉ [0, 1]`, a negative or non-finite token count) return a typed
`RepairChurnInputError` `Result` failure — a nonsense pass-rate is unrepresentable, never a
silent `NaN`.

`priceModelSwap({baselineTokensPerRun, candidate})` composes this into the net verdict:
`netSaving = baselineTokensPerRun − candidate.amortizedTokensPerRun`. A **negative**
`netSaving` is the crossover the binary-per-run gate cannot see — the cheaper model loses
tokens net once its repair churn is priced in.

### Token grounding (ADR 0112 §2 — no second meter)

The per-run and per-repair token inputs are the **billed** figure from the existing
[`token-spend`](../spend/token-spend.ts) reconstruction — the four-`usage`-component
offline sum (`input + cache_creation + cache_read + output`) over a stage's
`agent-<id>.jsonl` transcript (ADR 0112 §2). `tokensFromTranscript` reuses that core
**read-only**; the churn core never mints its own token meter. (`token-spend` also exposes
`exCacheRead` as a cross-run comparator that doesn't re-count the cached prefix per turn —
the churn function is agnostic to which figure the caller sources, but the default grounding
is the four-component `billed` sum.)

## The committed corpus

The frozen ground truth lives beside this module as one manifest per stage under
[`corpus/`](./corpus) (issue [#1854](https://github.com/kamp-us/phoenix/issues/1854)):

- [`corpus/triage.json`](./corpus/triage.json) — triage classifications
- [`corpus/build.json`](./corpus/build.json) — build outcomes (rows recorded by v1 `write-code`)
- [`corpus/review.json`](./corpus/review.json) — review verdicts (rows recorded by v1 `review-code`)

Each file is a `CorpusManifest` whose non-target stage arrays are empty, so it decodes
clean on its own and validates through `fabrika eval check`. Every entry is
covered by `corpus.data.unit.test.ts`, which decodes each committed file through
`decodeManifest` and asserts `Ok` — so a malformed corpus cannot land. A replay grades a
recorded run against these files with **no live network dependency**: the ground truth is
committed, and the `inputRef` pins a recorded state, not the live issue/PR.

Every entry is pinned by a reproducible identifier and carries the **recorded baseline
decision artifact** for that input — including the FAIL/red-CI edge cases (e.g.
[#1294](https://github.com/kamp-us/phoenix/pull/1294) genuinely failed CI + earned
`review-code: FAIL`). The label is what the baseline actually produced, so a model-swap
replay is graded against ground truth; a FAIL exemplar is as load-bearing as a PASS one —
it exercises the FAIL grading and the repair-churn cost the epic prices.

## Corpus-curation policy (ADR 0112 §1)

The corpus is governed by the **representative-task-set discipline** of ADR
[0112 §1](../../../../.decisions/0112-token-measurement-no-quality-compromise-methodology.md)
(frozen inputs, apples-to-apples). Three rules:

- **Selection — representative, stable, reproducible-from-id.** An entry is a real
  pipeline input chosen to be small and stable, pinned by its issue/PR **identifier** (never
  "a recent issue"). Each stage seeds the ADR 0112 §1 recorded input (triage
  [#1227](https://github.com/kamp-us/phoenix/issues/1227), build
  [#1223](https://github.com/kamp-us/phoenix/issues/1223) →
  [#1224](https://github.com/kamp-us/phoenix/pull/1224), review-code
  [#1199](https://github.com/kamp-us/phoenix/pull/1199)) and adds entries spanning the
  happy path plus at least one edge/error class per stage — so a pass-rate is meaningful,
  not n=1.
- **Grounding — the label is the recorded baseline, not a guess.** Each `label` is the
  decision artifact the baseline actually produced for that pinned input, verified against
  the repo/GitHub (the triage labels the issue carries, the `Fixes #N` + CI state + the
  `review-code` verdict a PR earned). A review-code `FAIL` label is anchored to the `FAIL`
  marker that persists immutably in the PR's comment history, so it stays reproducible from
  the id even after the PR moves on.
- **Growth — append, never mutate a pinned entry's recorded expectation.** The corpus grows
  by **adding** entries. A recorded expectation is frozen: when a pinned input later mutates
  (e.g. an issue is re-triaged), the comparison pins to the recorded state, not the live one
  — mutating a pinned label in place would break apples-to-apples across cost efforts. Only
  a genuine correction of a mis-recorded label edits an entry, and that is a re-grounding
  against the source, not a re-scoping.

**On the triage edge class.** triage's non-happy outcome (`status: needs-info`) has no
stably pinnable exemplar: a `needs-info` issue is relabeled once its info arrives, so it
does not reproduce from its id the way a persisted `review-code: FAIL` marker does. The
triage corpus therefore covers the edge by spanning the classification space (a routine
`p2` `decision`, an urgent `p0` `bug`, a `p1` `chore`) rather than pinning an unstable
`needs-info`.

## Authored eval-set ingestion ([#4674](https://github.com/kamp-us/phoenix/issues/4674))

An **eval set** is the collection of **eval cases** one skill's authoring session produced. fabrika
reuses `/skill-creator`'s authoring format verbatim (epic
[#4649](https://github.com/kamp-us/phoenix/issues/4649): the authoring tool owns eval *authoring*,
this epic owns eval *enforcement*), so `skill-eval-set.ts` **decodes** what a session already emits
and adds no required field to it. This model sits **beside** `CorpusManifest`, which is unchanged —
the stage-keyed corpus keeps serving the model-tiering scorecard.

The two authored files, and where their shapes come from:

- **`evals/evals.json`** — the case list, per the `skill-creator` plugin's
  `references/schemas.md` (`## evals.json`): `{skill_name, evals: [{id, prompt, expected_output,
  files?, expectations?}]}`, where each `expectations` entry is a verifiable statement in prose.
- **`eval_metadata.json`** — the per-case sidecar, per that plugin's `SKILL.md` ("Running and
  evaluating test cases", step 1): `{eval_id, eval_name, prompt, assertions}`.

Two things about that format are genuinely underspecified upstream, and are read tolerantly rather
than guessed at:

- **`expectations` vs `assertions`.** `schemas.md` names the `evals.json` field `expectations`;
  `SKILL.md` calls the same field "the `assertions` field". Both keys are accepted, `expectations`
  first.
- **An assertion's element shape.** `schemas.md` documents plain strings, and the sidecar's
  `assertions` is only ever shown as `[]` — no upstream consumer reads its elements. A bare string
  and a `{text}` object are both accepted; the string form is the documented one.

`id` and `prompt` are the only required per-case fields, because the authoring session writes
prompts first and drafts assertions later (`SKILL.md` step 1 → step 2) — a set captured between
those steps must still decode.

### The derived execution tier

The tier is **derived from a case's assertions, never authored** — that is what lets a runner route
a case without re-reading its prose while the authored format stays untouched:

- Each assertion is classified into a discriminated union on `kind`: `mechanical` (carrying the
  `cue` naming the observable it checks — `exit-status`, `file-artifact`, `output-content`,
  `tool-invocation`) or `judgment` (no cue). An assertion whose payload doesn't match its kind is
  unrepresentable.
- Classification is a small **literal-phrase lexicon** matched case-insensitively; anything
  unmatched falls through to `judgment`. The asymmetry is deliberate: a judgment case mis-derived
  as mechanical would skip the grading it needs and report a green it never earned, while a
  mechanical case mis-derived as judgment only costs a graded run.
- A case is `deterministic` iff it has assertions and **every** one is mechanical; otherwise
  `graded`. One judgment assertion puts the whole case on the graded path, and a case with no
  assertions yet is `graded`.

Executing either tier is out of scope here — the deterministic tier is
[#4677](https://github.com/kamp-us/phoenix/issues/4677), the graded axis
[#4678](https://github.com/kamp-us/phoenix/issues/4678), and the unattended runner
[#4676](https://github.com/kamp-us/phoenix/issues/4676).

`decodeSkillEvalSet(text)` and `decodeEvalCaseMetadata(text)` are **total**: a malformed body or a
schema mismatch returns a typed `SkillEvalSetDecodeError` `Result` failure (`malformed-json` /
`schema-mismatch`), never a throw — the same contract as `decodeManifest`. `withCaseMetadata(set,
sidecars)` joins sidecars onto a set by case id; the sidecar only *fills* (a name, or assertions for
a case that has none yet), because `evals.json` is the authored set of record.

```bash
# exit 0 on a valid set; non-zero with a named reason on a bad one
fabrika eval cases <path-to-evals.json>
```

The verb prints the skill name, the case count, the per-tier split, and one line per case. It reds
on an **empty** set as well as a malformed one: a set that decodes but carries zero cases would
report green while checking nothing, the zero-scope pass [ADR
0092](../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md) forbids.

An unedited authoring-session output shape is committed under
[`fixtures/skill-creator/`](./fixtures/skill-creator) and is what the unit tests decode, so "decodes
with no edits" is checked against the real shape rather than asserted.

## `fabrika eval run` — executing an eval set unattended (#4676)

```bash
fabrika eval run <evals.json> \
  --stage <triage|build|review|ship-it> \
  --plugin-dir <the candidate skill's plugin dir> \
  --model <model> \
  [--arms with-skill,without-skill] [--json-schema <schema.json>] \
  [--timeout-ms 900000] [--out ledger.json] [--capture-out capture.json] \
  [--spend-ledger .fabrika/spend-ledger.jsonl] [--dry-run]
```

One command runs a skill's whole eval set with nobody watching. Per (case × arm) it invokes
`claude -p "<case prompt>" --output-format json --session-id <uuid> --model <m> [--plugin-dir …]`,
locates the pinned session's transcript, classifies the run, and folds the collectable ones into the
**capture manifest** `collectFromCapture` already consumes. Grading, spend reconstruction and the
scorecard are all pre-existing code paths — this verb adds no oracle, no meter and no renderer.

### The `--model` contract ([#5158](https://github.com/kamp-us/phoenix/issues/5158))

`--model` is **required** and its value is **normalized, not policed**. The spelling you pass is
canonicalized through fabrika's one alias table ([`../models.ts`](../models.ts)) before it reaches a
planned run, so `--model <alias>` and `--model <its canonical id>` are the same run, the same argv,
and — because the ledger and capture manifest record the canonical spelling — the same scorecard
cell. That is the whole change: there is **no allowlist**, **no default**, and **no rejection**. A
model the table has never heard of canonicalizes to itself and runs exactly as named, which is what
keeps [#4680](https://github.com/kamp-us/phoenix/issues/4680)'s model-churn re-run contract (ADR
0236 §2) intact — a new model can be evaluated the day it exists, without editing this package.
`fabrika eval report --baseline-model` is normalized the same way, so a baseline named in either
spelling still matches the cell it means. The ruling behind this is
[#5148](https://github.com/kamp-us/phoenix/issues/5148) (option B), and the table lives in one place
by ADR [0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md) — nothing under
`src/eval/` declares a second copy.

### What each run cost, attributed to the run ([#5008](https://github.com/kamp-us/phoenix/issues/5008))

The runner already reconstructed every run's transcript to detect a silent green and then threw the
number away. It now keeps it. Each completed run carries its `RunSpend` on its outcome, and the
ledger's `spendRows` hold one **spend row** per completed run — the spend plus the identity fabrika
already had for it: skill, stage, case id, arm, model, session id, CLI version, and the suite's
`recordedAt` stamp. A `Failed` run gets no row; a row's `stage` is provenance — the key the row was
written under — never a pointer into the live stage table (#4977).

The three-arm `RunSpend` union is reused verbatim, so the states that are not a number stay
distinguishable to the last layer. `renderLedger` prints per-run `billed` / `ex-cache-read` and a
suite total, and it prints `n/a (transcript missing)` — never `0` — for a run it could not measure. A
suite that measured nothing prints `spend: unmeasured`, because a `billed 0` total reads exactly like
a suite that genuinely cost nothing. A run whose transcript bills zero turns never reaches a row at
all: it is already the counted `NoModelTurns:zero-assistant-turns` failure above.

The figures come from `src/spend/token-spend.ts` through `classifyRunSpend`. No second sum is added
here — this change in fact removes the runner's own second `reconstructSpend` call.

### Where those rows survive ([#5009](https://github.com/kamp-us/phoenix/issues/5009))

A spend row used to live only in the `--out` file the operator named, so every measurement was as
durable as one shell history. Once the suite completes, the runner now appends its rows to a **spend
ledger** — `.fabrika/spend-ledger.jsonl` by default, `--spend-ledger <path>` to put it elsewhere.
The default is repo-relative and gitignored; the format and both halves of its contract live in
[`../spend/ledger.ts`](../spend/ledger.ts).

Three properties are the point:

- **It is the only durable write, and it is on the completion path.** Nothing hooks session start,
  session end, or a tool call — the epic's second no-go. A `--dry-run` spawns nothing and so records
  nothing.
- **A re-run appends.** The earlier suite's lines are still there, byte for byte; nothing truncates,
  rewrites or repairs a line already on disk.
- **It cannot change what the run reports.** A ledger that cannot be written is one line on stderr.
  The exit code and the suite's outcome are untouched, because the measurement is a by-product of the
  run and must never become a way for it to fail.

**The two arms are `--plugin-dir` present or absent.** That is the whole difference in the argv, and
it is the arm variable the /skill-creator methodology means by with-skill vs without-skill. Two flags
are deliberately never emitted: `--no-session-persistence` (it suppresses the transcript this path
exists to collect) and `--disable-slash-commands` (measured: against a loaded plugin it
short-circuits to zero turns and `$0`, so it is not a usable arm toggle).

**A `/<skill>` case prompt makes the without-skill arm structurally unrunnable** — with no plugin
loaded there is no such command, so that arm reports `NoModelTurns:unknown-command` rather than a
score. That is the runner telling the truth, not a defect: a case meant to be run on both arms is
written as plain task text, and only a with-skill-only case names the slash command.

### The failure mode this verb exists to catch

**An unresolvable skill is a silent green.** Measured on `claude` 2.1.220:
`claude -p "/not-a-skill"` exits **0** with `is_error: false`, `subtype: "success"`,
`num_turns: 0`, `total_cost_usd: 0`, `modelUsage: {}` — and fabrika's token meter (`src/spend/token-spend.ts`) reconstructs
its transcript to well-formed **zeros, also at exit 0**. Nothing errors. A with-skill arm whose
plugin failed to load therefore degrades into a without-skill arm and scores as a legitimate free
run, which is precisely the class of silent pass this whole epic exists to end.

So the runner **synthesizes the signal the platform does not give it**. A run is a counted
`NoModelTurns` failure — never a pass, never a graded fail — when any of these hold:

| signal | what it caught |
|---|---|
| `unknown-command` | the result text starts `Unknown command:` — the skill did not resolve |
| `zero-turns` | `num_turns === 0` |
| `empty-model-usage` | `modelUsage` is `{}` |
| `zero-assistant-turns` | the transcript reconstructs to zero billed assistant turns |
| `missing-structured-output` | a `--json-schema` was requested and no `structured_output` came back |

Alongside these, a run that never started (`SpawnFailed`), one past its stated bound (`TimedOut`),
unreadable stdout (`UndecodableResult`), a run the CLI itself flagged (`ReportedError`), and a
healthy run whose transcript cannot be found (`TranscriptNotFound`) are all typed, counted outcomes.
**The suite always completes** — a dying case is classified and the next one runs.

The **exit code reports executability only**: zero when every planned run was collected, non-zero
when any died *or* when the set planned nothing (zero scope reds, [ADR
0092](../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)). Whether the cases
*passed* is the oracle's answer, read off the capture manifest downstream.

### Where it may be invoked — and where it may not

Its supported sites are **an operator's shell** and a **`review-skill` review-stage spawn**.
**Model-in-the-loop execution never runs in CI**, per the founder ruling on epic
[#4649](https://github.com/kamp-us/phoenix/issues/4649) (comment 5153280445). The stated reason is
**cost** — there are no credits for model runs inside the CI provider — and it is recorded as a cost
constraint, *not a principle*, so a future reader knows what would have to change to revisit it. No
workflow ships with this verb, and a unit test reds if any `.github/workflows/*` file ever calls it.
CI's own eval legs (#4677's deterministic tier, #4681's presence/head-binding/bar check) run no
model at all.

### Shape

`spawn.ts` is pure — planning, argv, result decode, classification, the capture fold — and is what
the unit tier drives through a **stubbed executor**, so no unit test spends a cent. `spawn-io.ts` is
the only file in the module that imports `node:child_process`. The reversal that lands here (this
module could previously not spawn anything) and its bounds are recorded in [ADR
0236](../../../../.decisions/0236-eval-harness-gains-a-spawning-shell.md).

## The fabrika incident corpus ([#4675](https://github.com/kamp-us/phoenix/issues/4675))

`incident-corpus/` is a **second, separate** body of ground truth, and the name matters: the
per-stage *corpus manifest* above serves model-tiering, while the **incident corpus** is the
committed set of incident-derived eval cases fabrika's 100% regression floor is measured against
(epic [#4649](https://github.com/kamp-us/phoenix/issues/4649)). They share this module and nothing
else.

- `incident-corpus/evals.json` — the cases, authored in the reused `/skill-creator` format and
  decoded by `skill-eval-set.ts`. No second format is invented for them.
- `incident-corpus/provenance.json` — the sidecar binding each case to the artifact it pins:
  the `#NNNN` incidents, how membership was verified, the tier, and any later **correction**.
  `incident-provenance.ts` decodes it; a `graded` case without a written rationale is
  unrepresentable, because the ruled bar makes graded the exception that must justify itself.
- `incident-corpus/README.md` — the intake path: what makes an incident a case, who writes it,
  the days-scale expectation from the [#4637](https://github.com/kamp-us/phoenix/issues/4637)
  ruling, and how a case is corrected rather than rewritten.

## Out of scope

**Making the tiering call** is [#1576](https://github.com/kamp-us/phoenix/issues/1576), a
separate `type:decision` — the harness supplies the graded evidence, the human decides.

**The tier protocols.** `run` executes and collects; it does not implement the deterministic tier's
mechanical checks (#4677) or the graded tier's 5-run median (#4678), and it renders no scorecard
series (#4680).
