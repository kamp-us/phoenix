# eval-harness

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
  - `write-code` → `{ fixesRef, ciGreen, reviewVerdict }`
  - `review-code` → `{ verdict, acFindings }`
  - `review-doc` → `{ verdict, findings }`
  - `ship-it` → `{ merged, mergeSha }`
- `CorpusManifest` — the frozen ground truth: entries grouped under per-stage keys, each
  key admitting only that stage's entry (the second half of the unrepresentable guarantee).
- `decodeManifest(text)` — total: returns a typed `Result` failure (`malformed-json` or
  `schema-mismatch`) on bad input, never throws. `encodeManifest(manifest)` round-trips it.

## The graded oracle ([#1849](https://github.com/kamp-us/phoenix/issues/1849))

`gradeEntry(entry, artifact): Grade` (`oracle.ts`) is the per-corpus-entry quality grade. ADR
[0112](../../../../../.decisions/0112-token-measurement-no-quality-compromise-methodology.md) §3
defines a per-stage output-quality oracle — a reproducible pass/fail that an optimized stage
reproduced the **same decision artifact** as the baseline — as a *binary* over one frozen input.
This generalizes it to grade **each** corpus entry, so the report slice can compute a pass-*rate*
over the whole set. It is pure and consumes an already-collected artifact — it does **not** spawn
a stage or call `gh` (that is the runner slice, #1851).

An entry passes iff the observed `artifact` reproduces its known-good `label`, per stage (ADR 0112 §3):

- `triage` — actual `{type, priority, status}` equals the label.
- `write-code` — the PR carries the labeled `Fixes #N` + CI green + an independent `review-code: PASS`
  (actual `{fixesRef, ciGreen, reviewVerdict}` equals the label).
- `review-code` — actual verdict + AC-finding **set** match the label (findings compared order- and
  duplicate-insensitively).
- `review-doc` — actual verdict + doc-finding set match the label.
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
run's token spend from its sub-agent transcript (via the [`token-spend`](../token-spend/token-spend.ts)
core, ADR 0112 §2), producing a `{entry, grade, spend}` **row**. A per-(stage × model) collection
of those rows is the raw material the report slice ([#1853](https://github.com/kamp-us/phoenix/issues/1853))
aggregates into pass-rate + churn cost.

The runner is a deterministic, side-effect-light **collector over runs that already happened** — it
does **not** spawn stage agents. Spawning is the operator's act, and the fleet's model is pinned by
`spawn-guard`; keeping the runner spawn-free is what makes the harness reproducible.

`RunRow` is `{entry, grade, spend}` where `spend` is a `RunSpend` union — either
`{_tag: "Reconstructed", spend}` (the `token-spend` `StageSpend`) or `{_tag: "TranscriptMissing"}`.
The missing case is a distinct, counted outcome rather than a fabricated zero the report could
mistake for a genuinely free run — a **missing transcript is graded and counted, never a crash**.

Two modes, story-split:

- **Offline / replay (story 6)** — `collectRuns(inputs)` over already-loaded transcripts + recorded
  artifacts, where each `RunInput` is `{entry, transcript, artifact}` (a `null` transcript folds in as
  `TranscriptMissing`). This is the reproducible, no-spawn path a CI or a re-analysis uses. Grading is
  total (a malformed artifact grades `fail` via the oracle) and spend reconstruction is fail-open (a
  malformed transcript undercounts, never throws) — so a whole corpus resolves without a crash.
- **Capture-manifest (story 7)** — `CaptureManifest` is the documented shape naming, per run, the
  transcript path (`<parent-session-id>/subagents/agent-<id>.jsonl`, ADR 0112 §2) + the recorded
  artifact, keyed by `(stage, inputRef)` so a fresh live run (spawned by the **operator**, not this
  tool) folds into the corpus deterministically. `decodeCaptureManifest(text)` is total (typed
  `Result` failure on malformed JSON or a schema mismatch). `collectFromCapture({stage, corpus,
  capture, loadTranscript})` joins each capture run to its corpus entry (for the ground-truth label),
  loads transcripts through the caller-supplied `TranscriptLoader` (keeping the core pure — the
  command shell supplies an fs-backed loader), and collects the graded rows.

```ts
import {collectRuns, collectFromCapture, decodeCaptureManifest} from "./runner.ts";
```

Presenting the collected rows (the two-axis scorecard) is the report slice
([#1853](https://github.com/kamp-us/phoenix/issues/1853)), documented next.

## The report — graded two-axis scorecard ([#1853](https://github.com/kamp-us/phoenix/issues/1853))

`report.ts` is the **top of the vertical slice** and the evidence artifact the model-tiering
decision ([#1576](https://github.com/kamp-us/phoenix/issues/1576)) consumes. It aggregates the
runner's graded `{entry, grade, spend}` rows into a per-(stage × model) **scorecard** on the ADR
0112 §4 two-axis gate, now graded:

- **Quality axis** — a **pass-rate** per (stage × model) over the corpus (`passedRuns / gradedRuns`),
  the graded generalization of ADR 0112 §3's binary-per-run oracle.
- **Token axis** — the mean **billed** + **ex-cache-read** spend per run (ADR 0112 §2), plus the
  priced **repair-churn cost** (`repair-churn.ts`): the amortized true cost of one *accepted* run
  once the extra cycles a lower pass-rate forces are amortized in.
- **Net saving vs a baseline** — when a `baseline` (stage × model) is named, each other cell's
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

### The CLI surface

```bash
# human table (default) — the founder reads this to decide #1576
pipeline-cli eval-harness report <rows.json>

# stable machine-readable JSON — a future gate / CI consumes this
pipeline-cli eval-harness report <rows.json> --json

# price net saving against a baseline (stage × model)
pipeline-cli eval-harness report <rows.json> --baseline-stage write-code --baseline-model opus-4.8
```

`<rows.json>` is a serialized `RunRow[]` — the array `collectRuns` emits. `decodeReportInput` is
total: a malformed body or a shape mismatch exits non-zero with a typed reason, never a throw.

### The stable JSON shape (the contract a consumer decodes)

```jsonc
{
  "decisionRef": 1576,                       // the decision this evidence feeds — never made here
  "framing": "This scorecard is measurement feeding the model-tiering decision (#1576); …",
  "baseline": { "stage": "write-code", "model": "opus-4.8" } | null,
  "cells": [
    {
      "stage": "write-code",
      "model": "opus-4.8" | null,            // reconstructed from the transcript; null when unattributable
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
[0092](../../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)).

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
pnpm --filter @kampus/pipeline-cli exec vitest run \
  src/tools/eval-harness/deterministic-shell-observer.unit.test.ts --reporter=verbose
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
pipeline-cli eval-harness check <manifest>    # exit 0 if valid; non-zero on a bad manifest
pipeline-cli eval-harness report <rows.json>  # the graded two-axis scorecard (see below)
pipeline-cli eval-harness cases <evals.json>  # validate an authored eval set (see below)
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
  `failure-classifier` **TRANSIENT** death (see [`failure-classifier`](../failure-classifier/failure-classifier.ts)),
  not a fail the model owns, so it is **excluded** from `passRate` — otherwise churn would be
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
[`token-spend`](../token-spend/token-spend.ts) reconstruction — the four-`usage`-component
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
- [`corpus/write-code.json`](./corpus/write-code.json) — write-code outcomes
- [`corpus/review-code.json`](./corpus/review-code.json) — review-code verdicts

Each file is a `CorpusManifest` whose non-target stage arrays are empty, so it decodes
clean on its own and validates through `pipeline-cli eval-harness check`. Every entry is
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
[0112 §1](../../../../../.decisions/0112-token-measurement-no-quality-compromise-methodology.md)
(frozen inputs, apples-to-apples). Three rules:

- **Selection — representative, stable, reproducible-from-id.** An entry is a real
  pipeline input chosen to be small and stable, pinned by its issue/PR **identifier** (never
  "a recent issue"). Each stage seeds the ADR 0112 §1 recorded input (triage
  [#1227](https://github.com/kamp-us/phoenix/issues/1227), write-code
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
pipeline-cli eval-harness cases <path-to-evals.json>
```

The verb prints the skill name, the case count, the per-tier split, and one line per case. It reds
on an **empty** set as well as a malformed one: a set that decodes but carries zero cases would
report green while checking nothing, the zero-scope pass [ADR
0092](../../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md) forbids.

An unedited authoring-session output shape is committed under
[`fixtures/skill-creator/`](./fixtures/skill-creator) and is what the unit tests decode, so "decodes
with no edits" is checked against the real shape rather than asserted.

## Out of scope

Running any stage (collecting the transcripts) is the operator's act, not this tool.
**Making the tiering call** is [#1576](https://github.com/kamp-us/phoenix/issues/1576), a
separate `type:decision` — the harness supplies the graded evidence, the human decides.
