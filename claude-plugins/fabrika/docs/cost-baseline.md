# The v1 cost baseline — the method, and how to reproduce it

Phase 1 of the ruled cost axis is one sentence: **fabrika's spend on the incident corpus must be at
or below what v1 spent on the same corpus** ([#4637](https://github.com/kamp-us/phoenix/issues/4637)
ruling 3). This doc is the reproducible method behind the committed baseline that ceiling is measured
against, and behind the published fabrika-vs-v1 comparison on identical inputs — they are the same
artifact ([#4679](https://github.com/kamp-us/phoenix/issues/4679)).

A baseline nobody can re-run cannot ceiling anything, so everything below is repo-relative and
machine-independent by construction.

## Where the runs happen — an operator's machine, never CI

Ruled on [#4679](https://github.com/kamp-us/phoenix/issues/4679#issuecomment-5247166010)
(2026-08-10): eval and baseline runs execute **in a live agent session on whatever machine invokes
them**. CI runs no model at all — it only reads the artifacts a run produced, on the cost constraint
recorded for epic [#4649](https://github.com/kamp-us/phoenix/issues/4649).

The run machine is therefore interchangeable, and that is the whole reason nothing here is personal:
the procedure, the corpus, the runner and the verbs are all resident in the repo, so any clone can
produce the same artifact. This is ADR
[0273](../../../.decisions/0273-fabrika-ships-as-an-installed-plugin-from-day-one.md)'s rule applied
to the runner — *a fabrika skill may depend only on inputs it can obtain by opening the repo it is
installed into* — which is why the outputs land on committed files and PR comments and never on a
home-directory path.

**Packaging the invocation as a repo-level skill is not this lane's.** The runner's shape is designed
by [#4678](https://github.com/kamp-us/phoenix/issues/4678)'s lane, per the intake note on
[#4679](https://github.com/kamp-us/phoenix/issues/4679#issuecomment-5247171842); what this doc fixes
is the procedure such a skill invokes, so the two cannot disagree about how a baseline is produced.

## No new meter, and no v1 dependency

Every token figure is reconstructed by
[`src/spend/token-spend.ts`](../../../packages/fabrika-cli/src/spend/token-spend.ts) — the ADR 0112 §2
four-`usage`-component offline sum — persisted by
[`src/spend/ledger.ts`](../../../packages/fabrika-cli/src/spend/ledger.ts), and priced against
[`src/eval/repair-churn.ts`](../../../packages/fabrika-cli/src/eval/repair-churn.ts) where churn is
wanted. Re-deriving either would break apples-to-apples against every prior cost effort.

Those cores are fabrika's own reimplementations, not calls into v1 (ADR
[0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). v1 appears here only as
the **thing measured**, never as a thing depended on.

## The v1 arm is the same runner with a different plugin dir

This is the adapter, and it needs no code: `fabrika eval run`'s with-skill arm loads whatever
`--plugin-dir` names, so pointing it at the v1 plugin runs the v1 suite unattended through the
identical harness, the identical transcript reconstruction and the identical ledger.

```
--plugin-dir claude-plugins/kampus-pipeline   # the v1 arm
--plugin-dir claude-plugins/fabrika           # the fabrika arm
```

The incident-corpus prompts are plain task text rather than slash commands, which is what lets both
arms run the same cases; a case that named `/<skill>` would be structurally unrunnable on an arm that
does not load it.

## What "the same corpus" is

**66 members + 1 pending**, enumerated in
[`incident-corpus/ruled-keeps.json`](../../../packages/fabrika-cli/src/eval/incident-corpus/ruled-keeps.json)
— never the superseded figure of 74, which double-counted the 7 borderline issues (that file's own
`derivation.arithmetic` records the correction). The executed set is the authored cases in
[`incident-corpus/evals.json`](../../../packages/fabrika-cli/src/eval/incident-corpus/evals.json).
Both counts are read out of the committed files by `baseline record`, never asserted on the command
line.

**The comparable unit is the corpus-level total, not a stage-keyed row.** After the partition, v1's
30 skills and fabrika's 18 map many-to-one and one-to-many in both directions — v1's five review
skills land on fabrika's one `review` plus `check-epic-plan`, `write-code` splits into `build` and
`build-ui`, and three v1 skills have no counterpart at all — so no stage key is shared by both arms
and no stage-keyed row can be the ceiling. A per-skill breakdown may be reported alongside the total,
with its mapping stated; it is never the comparison on its own.

## Reproducing it

Run from the repo root, on a machine with a clone and the `claude` CLI. Each step names the pin it
produces.

**1 — measure the arm.** One run per case; the spend ledger is the durable output.

```bash
node packages/fabrika-cli/src/bin.ts eval run \
  packages/fabrika-cli/src/eval/incident-corpus/evals.json \
  --stage build \
  --plugin-dir claude-plugins/kampus-pipeline \
  --model opus \
  --arms with-skill \
  --spend-ledger .fabrika/v1-baseline.jsonl
```

`--model` is normalized through fabrika's one alias table, so `opus` and `claude-opus-4-8` are the
same run and the same recorded spelling. The verb's exit code reports **executability only** — that
every planned run started and was collected — never whether the cases passed.

**2 — record the baseline.** The verb folds the ledger's rows and attaches the pins.

```bash
node packages/fabrika-cli/src/bin.ts eval baseline record \
  --ledger .fabrika/v1-baseline.jsonl \
  --arm with-skill \
  --suite v1 \
  --corpus packages/fabrika-cli/src/eval/incident-corpus/ruled-keeps.json \
  --corpus-revision "$(git rev-parse HEAD)" \
  --cases packages/fabrika-cli/src/eval/incident-corpus/evals.json \
  --plugin-dir claude-plugins/kampus-pipeline \
  --harness-revision "$(git rev-parse HEAD)" \
  --out claude-plugins/fabrika/reports/eval/baseline-v1-$(date -u +%F).json
```

**3 — commit it.** The file is the baseline; a measurement that lives only in one shell is not one.

### Which pin comes from where

| Pin | Source |
|---|---|
| corpus revision | `--corpus-revision`, the commit the corpus files were read at |
| corpus size (66 + 1) | read out of `ruled-keeps.json`, never asserted |
| case count | read out of `evals.json` |
| run count | counted off the ledger rows in scope |
| model | read off the ledger rows; two models in one fold is refused |
| CLI version | read off the ledger rows; two versions in one fold is refused |
| harness version | `--harness-revision`, the commit the harness ran from — a commit pins it exactly, where the package semver has never moved off `0.1.0` |
| adapter | `--plugin-dir`, recorded on the artifact so a later reader knows which suite was measured |

## The comparison surface

One question, answered by an exit code so nothing has to parse prose:

```bash
node packages/fabrika-cli/src/bin.ts eval baseline compare \
  claude-plugins/fabrika/reports/eval/baseline-v1-<date>.json \
  --ledger .fabrika/fabrika-arm.jsonl
```

| exit | verdict | meaning |
|---|---|---|
| `0` | `at-or-below` | fabrika spend on the same corpus is inside the phase-1 ceiling (a tie passes — the bar is `≤`) |
| `15` | `above` | a cost regression against v1 on the same corpus |
| `16` | `incomparable` | the two sides did not price the same work — a different case count, a different model, or a candidate that measured nothing |

`incomparable` is a real third answer, never a pass. It is what stops a candidate that quietly ran a
smaller case set from reading as a cheaper one.

## Two refusals, and why they are refusals

- **A baseline over zero measured runs is refused, not recorded as zero** ([ADR
  0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)). A ledger whose every row is
  `TranscriptMissing` describes a suite nobody could measure, and a `0` there reads exactly like a
  suite that was free — the same fabricated-zero class the three-arm `RunSpend` union exists to keep
  out.
- **Rows from two models, or two CLI versions, are refused.** They are two experiments, and a
  baseline that names one of them misstates the other by an unknown amount.

## Phase 2 is deferred, and the artifact says so

Absolute per-stage token budgets wait for roughly three months of fabrika's own p95 data (#4637).
Nothing here introduces one, and every recorded baseline carries the deferral sentence in its
`phase2` field so a reader learns it from the artifact rather than from a cross-read.

## What this method does not own

- **The scorecard series mechanics** — how runs accumulate and how the trend co-gate reads them back
  — are [#4680](https://github.com/kamp-us/phoenix/issues/4680)'s.
- **The merge gate that enforces the ceiling** is [#4681](https://github.com/kamp-us/phoenix/issues/4681)'s.
- **The eval-result record** is a PR comment, per ADR
  [0253](../../../.decisions/0253-eval-record-is-an-eval-namespaced-pr-comment.md), and never rides
  inside a baseline file.
