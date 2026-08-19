---
id: 0236
title: The eval-harness gains a spawning IO shell — its pure cores stay spawn-free, and no CI job ever spawns a model
status: superseded by [0303](0303-retire-kampus-pipeline-plugin.md)
superseded_by: 0303
date: 2026-08-01
tags: [pipeline, eval-harness, tooling, fabrika, cost]
---

# 0236 — The eval-harness gains a spawning IO shell — its pure cores stay spawn-free, and no CI job ever spawns a model

**What this decides:** `packages/pipeline-cli/src/tools/eval-harness/` may now start a process. The
spawning is confined to one IO file (`spawn-io.ts`), every core it feeds stays pure and
offline-replayable, and the spawning verb's supported invocation sites are an operator's shell and a
`review-skill` review-stage spawn — never a CI job.

## Context

The module was built (epic #1842, ADR [0112](0112-token-measurement-no-quality-compromise-methodology.md)) as a
**collector over runs that already happened**. Both its README and `runner.ts`'s header state the
property explicitly: *"it does NOT spawn stage agents (spawning is the operator's act)"*. That was a
real design property, not an omission — it is what makes the offline replay path reproducible.

Fabrika's eval system (epic [#4649](https://github.com/kamp-us/phoenix/issues/4649)) needs the
half that was deliberately absent. Its story 2 is *"run my skill's whole eval set unattended with
one command"*; there is no way to reach that without something starting a process. The epic resolved
where it lives — the existing module, extended, because a second module would fork the token meter
and break apples-to-apples against every prior cost measurement (ADR 0112 §2) — and the
[#4673 spike](https://github.com/kamp-us/phoenix/issues/4673) established, against the real tool,
that `claude -p "/<skill>" --output-format json --session-id <uuid>` is the invocation and that the
existing spend reconstruction reads its transcript unchanged. The spike explicitly deferred this
ADR to the landing that causes the reversal, so the *why* attaches to the diff.

Two further constraints arrived from outside the module:

1. **The founder ruling on #4649 (comment 5153280445): no model-in-the-loop execution runs in CI.**
   The stated reason is **cost** — there are no credits to spend on model runs inside the CI
   provider. It is recorded as a cost constraint rather than a principle so a future reader knows
   what would have to change to revisit it. The graded axis therefore rides the review stage, which
   already pays for a model.
2. **`spawn-guard` is a `PreToolUse` hook on `Task|Workflow`** and denies on `tool_input.model`. A
   `claude -p --model <x>` subprocess is not a `Task` tool call, so the two surfaces are disjoint —
   measured on the spike. Which surface the runner uses is therefore load-bearing, not incidental.

## Decision

**1. The reversal is scoped to one file.** `spawn-io.ts` is the only place in the module that
imports `node:child_process`. `spawn.ts` plans the invocations, decodes the result payload and
classifies each run; `runner.ts`, `oracle.ts`, `report.ts` and `repair-churn.ts` are untouched in
their purity. The offline replay path and its tests keep passing unchanged, which is the property
worth preserving — a reproducible re-analysis must not need a model.

**2. The runner spawns as a CLI subprocess, never as an in-session `Task`.** Beyond keeping the
spawn out of the agent's tool surface, this is what makes #4680's model-churn re-run contract
satisfiable at all: a named-model re-run through `Task` is a hard deny under `spawn-guard`'s
allowlist, while the same run as a subprocess is unimpeded. Re-implementing this as a `Task` spawn
would silently break that contract.

**3. A run that never reached a model is a typed failure, never a free pass.** This is the finding
that shapes the whole design and it is the module's own failure class staring back. `claude -p
"/not-a-skill"` exits **0** with `is_error: false`, `subtype: "success"`, `num_turns: 0`,
`total_cost_usd: 0`, `modelUsage: {}` — and `pipeline-cli token-spend` reconstructs its transcript to
well-formed **zeros, also at exit 0**. (Measured on `claude` 2.1.220 during the spike and reproduced
independently while landing this.) Nothing in the platform reports the failure, so a with-skill arm
whose plugin failed to load **silently degrades into a without-skill arm and scores as a legitimate
free run**. The runner therefore synthesizes the missing signal: `num_turns === 0`, a
`^Unknown command:` result, an empty `modelUsage`, a requested-but-absent `structured_output`, or a
transcript reconstructing to zero billed assistant turns each make the run a counted `NoModelTurns`
failure, and only a run that survives all five becomes a `CaptureRun`.

**4. `RunSpend` gains a third arm, `NoBilledTurns`.** The union existed to stop a fabricated zero
from being read as a genuinely free run, and it had exactly two arms — `Reconstructed` and
`TranscriptMissing`. A zero-turn run defeats both: its transcript *is* present and *does* parse, and
reconstructs to a real zero. Folding it into `Reconstructed` would put the fabricated zero back.

**5. No CI workflow invokes the model-spawning verb, and that is asserted rather than described.**
The runner ships with no workflow, and a unit test reds if any `.github/workflows/*` file calls
`eval-harness run` (failing closed on zero scope per ADR
[0092](0092-gates-fail-closed-on-zero-scope.md)). CI's own eval work — the deterministic regression
floor (#4677) and the presence/head-binding/bar check over recorded results (#4681) — is
string-and-number comparison with no model and no credential.

## Consequences

- The module's stated "does not spawn" property is now **false for the module and true for its
  cores**, and the README says so in those words rather than being quietly edited.
- An operator can run a whole eval set with one command; `review-skill` can invoke the same verb;
  neither path is reachable from CI without tripping (5).
- The runner's exit code reports **executability only** — whether every planned case ran. Whether
  cases *passed* stays the oracle's answer, read off the capture manifest downstream. Bundling the
  two would make a legitimately-failing eval indistinguishable from a harness malfunction, which is
  the distinction this whole epic exists to draw.
- Dollars are recorded opportunistically (`total_cost_usd` exists only at the headless site), but the
  cost axis stays **token-grounded** per ADR 0112 §2. There is no second meter.

## Alternatives considered

- **A separate module for execution.** Rejected upstream by the epic: it forks the token meter and
  breaks comparability with every prior measurement.
- **Trusting the CLI's exit code / `is_error` / `subtype`.** Rejected on measurement — all three
  report success on a run that never reached a model.
- **`--disable-slash-commands` as the with/without arm toggle.** Rejected on measurement: against a
  loaded plugin it short-circuits to zero turns and `$0`, so both arms would be un-run. The toggle is
  the presence of `--plugin-dir`.
- **Re-deriving the transcript's `<cwd-slug>` directory instead of scanning.** Rejected: the slug is
  a lossy separator flattening, so a re-derivation answers "no transcript" for runs that produced
  one.
