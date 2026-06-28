# Token-economics measurement apparatus

The **baseline-first measurement apparatus** the token-economics epic
([#1356](https://github.com/kamp-us/phoenix/issues/1356)) is judged against. Three coupled
parts, one unit: a **frozen task set** (fixed inputs), a **reproducible token-measurement
procedure** grounded in the existing `spawn-guard` meter, and an **output-quality rubric** that
turns the epic's no-compromise constraint into a pass/fail signal. Every later lever child
(see [#1371](https://github.com/kamp-us/phoenix/issues/1371) /
[#1373](https://github.com/kamp-us/phoenix/issues/1373) /
[#1374](https://github.com/kamp-us/phoenix/issues/1374)) reports a before/after against the
numbers and reuses the rubric here. This child establishes the **before** picture only —
applying any optimization is out of scope.

This doc owns the **measurement method**, not the meter. The meter already exists — the
`spawn-guard` statusline reader — and this apparatus reuses it read-only rather than minting a
new one.

## 1. The frozen task set (fixed, named inputs)

Three fixed, real pipeline inputs, one per stage, chosen to be small and stable so a
before/after is apples-to-apples and reproducible from this description alone. Re-run the
stage's agent on the exact input named:

| Stage | Frozen input | What to run | Expected quality outcome (the rubric oracle, §3) |
|---|---|---|---|
| **triage** | issue [#1227](https://github.com/kamp-us/phoenix/issues/1227) | `triage` skill on the issue | classification = `type:decision` + `p2` + `status:triaged` |
| **write-code** | issue [#1223](https://github.com/kamp-us/phoenix/issues/1223) (the `biome.jsonc` CI-lint fix, shipped as PR [#1224](https://github.com/kamp-us/phoenix/pull/1224)) | `write-code` skill end-to-end on the issue (revert PR #1224 on a scratch branch to re-create the input state, then re-implement) | PR closes #1223 + green CI + a `review-code: PASS` |
| **review-code** | merged PR [#1199](https://github.com/kamp-us/phoenix/pull/1199) (shipper agent, Fixes #1190) | `review-code` gate against the PR head | `review-code: PASS`, same acceptance-criteria coverage |

The inputs are deliberately fixed identifiers, not "a recent issue": a lever's before/after is
only comparable when both runs consume the **same** input. When a frozen input is later mutated
(e.g. #1227 is re-triaged and its labels change), pin the comparison to the state recorded in §2
rather than the live issue.

## 2. The token-measurement procedure (grounded in `spawn-guard`)

### The meter is `spawn-guard`'s statusline reader — reuse it, do not reinvent

The fleet already has one per-session token/cost meter:
[`packages/pipeline-cli/src/tools/spawn-guard`](../packages/pipeline-cli/src/tools/spawn-guard).
It reads the figures Claude Code reports and renders one compact line. Two surfaces ground every
claim below:

- **`spawn-guard.ts:91-130`** — `SessionCostInput` + `formatSessionCost`. The input fields are
  exactly `totalCostUsd` ("as Claude Code reports it, e.g. `cost.total_cost_usd`") and
  `totalTokens` ("Total session tokens (input + output) where the harness exposes them"). This is
  the canonical per-session spend shape the epic measures against.
- **`command.ts:127-137`** — the `statusline` subcommand. It reads the Claude Code statusLine
  payload from stdin and extracts, in this precedence:
  - `totalCostUsd` = `payload.cost.total_cost_usd` ?? `payload.total_cost_usd`
  - `totalTokens` = `payload.cost.total_tokens` ?? `payload.total_tokens` ?? `payload.usage.total_tokens`

  So **`cost.total_tokens` / `cost.total_cost_usd` are the authoritative per-session figures**:
  Claude-Code-computed aggregates, not a hand-rolled sum.

### Live measurement (authoritative): capture `cost.total_tokens` at stage end

The figures `formatSessionCost` renders are only delivered live, through the statusLine hook — they
are **not persisted** in the session transcript (see the tooling gap below). To measure a stage
run authoritatively, capture the statusLine payload's `cost.total_tokens` / `cost.total_cost_usd`
at the **end** of the run (the cumulative session total). This is the single number a lever reports
its before/after against, and it is exactly what `spawn-guard statusline` already prints.

### Offline measurement (reproducible from a transcript)

Each pipeline-stage sub-agent run is **individually attributable**: it gets its own transcript in
the session store under `<parent-session-id>/subagents/agent-<agent-id>.jsonl` (the agent id is the
spawn's worktree/agent id; the first user message is the stage's task prompt, e.g. `Triage issue
#1227 …` / `Implement issue #1223 …` / `Review PR #1199 …`). Given a stage run's transcript,
reconstruct the same total `cost.total_tokens` would report by summing the four `usage` components
Claude Code itself aggregates — over every `assistant` message:

```
billed_tokens = Σ (input_tokens
                 + cache_creation_input_tokens
                 + cache_read_input_tokens
                 + output_tokens)
```

Reproducible one-liner over a transcript (`jq`), printing the four components + the total:

```bash
jq -s '
  [ .[] | select(.message.role=="assistant") | .message.usage
          | select(. != null) ]
  | { input:        (map(.input_tokens // 0)                | add),
      cache_create: (map(.cache_creation_input_tokens // 0) | add),
      cache_read:   (map(.cache_read_input_tokens // 0)     | add),
      output:       (map(.output_tokens // 0)               | add) }
  | . + { billed: (.input + .cache_create + .cache_read + .output) }
' <transcript.jsonl>
```

**Read `cache_read` separately, never collapse it into a headline.** `cache_read_input_tokens` is
re-reported on every turn (it is the cumulative cached prefix being re-read each message), so it
dominates `billed_tokens` and balloons with turn count — that domination is itself the
context-bloat signal a lever targets, so keep the four-way breakdown visible. The
**`ex-cache-read`** figure (`input + cache_create + output`) is the better cross-run comparator
because it is not re-counted per turn; report both.

### Recorded baseline — on the §1 frozen inputs (real measured numbers, opus-4-8)

The "before" number for each stage, measured with the offline procedure above from the actual
`claude-opus-4-8` sub-agent run **on the declared §1 frozen input** (the fleet's pinned model — the
`spawn-guard` `ALLOWLIST`, `spawn-guard.ts:25`). These are matched to §1 by construction: each row's
input is the same identifier §1 names, so a lever re-running §1 and comparing is apples-to-apples,
no re-measurement caveat.

| Stage | Frozen input (§1) | Sub-agent transcript | Turns | `billed_tokens` | `ex-cache-read` | output |
|---|---|---|---:|---:|---:|---:|
| triage | issue #1227 | `agent-af3afc3fc26976` | 19 | 592,499 | 175,425 | 4,595 |
| write-code | issue #1223 (→ PR #1224) | `agent-a734c4b6dc387a61` | 42 | 2,076,940 | 151,815 | 9,172 |
| review-code | PR #1199 | `agent-ad29433525afd436` | 31 | 1,325,645 | 181,422 | 5,557 |

Reading the numbers:

- **`billed_tokens` is the headline "before"** a lever reports its after against; **`ex-cache-read`**
  is the cross-run comparator that doesn't balloon with turn count. In every row `cache_read`
  dominates `billed_tokens` (compare the two columns) — the context each stage re-reads every turn,
  and the headline lever target.
- A lever re-runs the §1 input, measures the same way (live `cost.total_tokens` is preferred and
  authoritative; the offline reconstruction reproduces it), and reports both the token delta vs this
  row and the §3 quality verdict. A run that didn't change the input is comparable to the row above
  directly.

## 3. The output-quality rubric (the no-compromise gate)

A stage optimization is only acceptable if quality is **preserved or improved**. On each §1 frozen
input, the optimized stage must produce the **same decision artifact** as the baseline — a
reproducible, per-stage pass/fail:

| Stage | Quality oracle (pass iff…) |
|---|---|
| **triage** | re-triaging #1227 yields the **same classification** — `type:decision` + `p2` + `status:triaged` (type, priority, and status labels all match). |
| **write-code** | the rebuilt PR for #1223 **carries `Fixes #1223`**, every acceptance criterion stays checkable, **CI is green**, and an independent `review-code` run returns **`PASS`** (no AC-coverage regression vs baseline). |
| **review-code** | re-reviewing #1199's head returns the **same verdict** (`PASS`) with the **same set of AC findings** — no missed finding, no spurious new FAIL. |

**Quality gate = all three oracles pass.** A lever that lowers tokens but flips any oracle
(different classification, a lost AC, a changed verdict) **fails the epic's hard constraint** and is
rejected regardless of the token win. The gate is what makes "quality preserved" *checkable* rather
than asserted; every Phase-2/3 lever child runs this same rubric on the same frozen set and reports
both the token before/after (§2) and the rubric pass/fail (§3).

## Tooling gap (follow-up)

Per-stage token spend **is** individually attributable offline — each stage sub-agent has its own
`<parent-session-id>/subagents/agent-<agent-id>.jsonl` transcript (§2) — but Claude Code does **not**
persist its `cost.total_tokens` aggregate *into* that transcript; only the per-message `usage`
components are stored, so a number requires the §2 four-component reconstruction (a hand-run `jq`).
A small `pipeline-cli` reporter that, given a stage agent's transcript, emits the `formatSessionCost`
line (reusing `spawn-guard`'s pure core read-only) would make matched before/after measurement a
one-command step. Filed as report residue ([#1382](https://github.com/kamp-us/phoenix/issues/1382));
not built here to keep this child a non-control-plane doc artifact.
</content>
</invoke>
