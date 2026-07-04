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

## Why it exists

ADR 0112's apparatus grades **one** frozen input per stage with a **binary** oracle —
enough for a deterministic lever flip, not for a stochastic model swap (Opus → Sonnet on a
stage), where an n=1 smoke test can't tell "good enough" from "got lucky." A labeled corpus
big enough for a meaningful pass-rate is the prerequisite for any model-tiering decision.
This module is the shared format that graded slice is built on.

## How to use

The core is a pure library — import `CorpusEntry`, `CorpusManifest`, `decodeManifest`,
`encodeManifest`, and `STAGES` from `corpus.ts`. The one CLI surface validates a manifest
file against the schema:

```bash
pipeline-cli eval-harness check <manifest>   # exit 0 if valid; non-zero on a bad manifest
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

## Out of scope (later children)

Populating real corpus entries, running any stage (collecting the transcripts), and
presenting the metric are separate slices under epic #1842 — not this core.
