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
| **write-code** | merged PR [#1224](https://github.com/kamp-us/phoenix/pull/1224) (single-file CI fix) | revert the PR on a scratch branch, re-run `write-code` to re-implement | equivalent diff + green CI + a `review-code: PASS` |
| **review-code** | merged PR [#1199](https://github.com/kamp-us/phoenix/pull/1199) (shipper agent) | `review-code` skill against the PR head | `review-code: PASS`, same acceptance-criteria coverage |

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

When you only have a completed stage run's session transcript (Claude Code's standard per-project
session store; each hook payload also carries its own `transcript_path`), reconstruct the same
total by summing the four `usage` components Claude Code itself aggregates into `cost.total_tokens`
— over every `assistant` message:

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

### Recorded baseline (real measured numbers, opus-4-8)

Real measurements taken with the offline procedure above, from the most recent clean
`claude-opus-4-8` run of each stage class in the session store at authoring time (2026-06-27). The
model is the fleet's pinned `claude-opus-4-8` (the `spawn-guard` `ALLOWLIST`, `spawn-guard.ts:25`).
These establish order-of-magnitude and prove the meter works; a lever should **re-measure on the
§1 frozen inputs** (live `cost.total_tokens`) to get a matched before/after pair.

| Stage class | Provenance (session) | Turns | `billed_tokens` | `ex-cache-read` | output |
|---|---|---:|---:|---:|---:|
| triage / intake | `c2e4d7ba` (`/report` intake run) | 16 | 793,668 | 196,067 | 9,147 |
| write-code | `5746409d` (build, PR [#24](https://github.com/kamp-us/phoenix/pull/24)) | 123 | 25,718,127 | 2,402,657 | 362,456 |
| review-code | `84eead39` (emitted `review-code: PASS`) | 238 | 27,026,867 | 994,119 | 371,908 |

Provenance caveats, stated plainly because [#1356](https://github.com/kamp-us/phoenix/issues/1356)
agent 2.2 builds on these:

- **Single-sample, not the frozen inputs.** The recorded sessions are not runs on the §1 fixed
  inputs (a clean opus-4-8 run on each exact input was not in the store). They are real magnitude
  references, not matched pairs — the *procedure* + *frozen set* are the reproducible apparatus;
  these numbers are the "before" snapshot. Re-run §1 to replace a row with a matched figure.
- **The triage row is a `/report` intake run**, the closest clean opus-4-8 intake-class sample; a
  `triage`-proper run (often a multi-issue batch) measures identically via the same procedure.
- **`cache_read` dominates `billed_tokens`** in every row (compare `billed` vs `ex-cache-read`) —
  the context a stage re-reads each turn. This is the headline lever target.

## 3. The output-quality rubric (the no-compromise gate)

A stage optimization is only acceptable if quality is **preserved or improved**. On each §1 frozen
input, the optimized stage must produce the **same decision artifact** as the baseline — a
reproducible, per-stage pass/fail:

| Stage | Quality oracle (pass iff…) |
|---|---|
| **triage** | re-triaging #1227 yields the **same classification** — `type:decision` + `p2` + `status:triaged` (type, priority, and status labels all match). |
| **write-code** | the rebuilt PR for #1224 **closes its issue**, every acceptance criterion stays checkable, **CI is green**, and an independent `review-code` run returns **`PASS`** (no AC-coverage regression vs baseline). |
| **review-code** | re-reviewing #1199's head returns the **same verdict** (`PASS`) with the **same set of AC findings** — no missed finding, no spurious new FAIL. |

**Quality gate = all three oracles pass.** A lever that lowers tokens but flips any oracle
(different classification, a lost AC, a changed verdict) **fails the epic's hard constraint** and is
rejected regardless of the token win. The gate is what makes "quality preserved" *checkable* rather
than asserted; every Phase-2/3 lever child runs this same rubric on the same frozen set and reports
both the token before/after (§2) and the rubric pass/fail (§3).

## Tooling gap (follow-up)

Per-stage token spend is **not directly attributable offline** in the current setup: pipeline
sub-agents leave no sidechain entries, and Claude Code does **not** persist its `cost.total_tokens`
aggregate into the transcript — only the per-message `usage` components are stored, requiring the
§2 reconstruction. A small `pipeline-cli` reporter that, given a stage agent's transcript, emits the
`formatSessionCost` line (reusing `spawn-guard`'s pure core read-only) would make matched
before/after measurement a one-command step instead of a hand-run `jq`. Filed as report residue;
not built here to keep this child a non-control-plane doc artifact.
</content>
</invoke>
