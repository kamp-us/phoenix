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

## 4. Applied-lever results — #1374 fan-out economics

The **fan-out-economics lever** ([#1374](https://github.com/kamp-us/phoenix/issues/1374), the
sibling of the read-economics child [#1373](https://github.com/kamp-us/phoenix/issues/1373))
acts on the audit's headline: **43–60% of every stage's billed spend is resident scaffolding
re-read every turn, and a fanned-out batch re-pays that scaffolding N× with zero sharing**
([token-economics-audit.md](./token-economics-audit.md) Ranks 1/3/4). The brief named three
coupled sub-levers; each is reported below against the §1/§2 recorded baseline (offline
four-component reconstruction from the actual sub-agent transcripts — `triage agent-af3afc3fc26976`,
19 turns, billed 592,499; `write-code agent-a734c4b6dc387a61`, 42 turns, billed 2,076,940), with
the §3 rubric as the no-compromise gate. The frozen inputs are unchanged, so each row is
apples-to-apples against the baseline.

### Sub-lever 1 — tighter prompts + thin-core skill surface (SHIPPED)

The audit's Rank-1 lever: shrink the resident scaffolding each fanned agent re-pays, **without
dropping a load-bearing instruction**, by (a) deslopping verbose restatement to the
[CLAUDE.md comment-discipline](../CLAUDE.md) ("collapse a docblock that re-derives an ADR's *why*
to a pointer"), and (b) extending the established thin-core / lazily-`Read`-contract split (the
`gh-issue-intake-formats` / preflight-detail precedent) by lifting one **off-hot-path** block out
of the resident core. Applied to the two non-gate, baseline-measured skills:

| Skill (resident core) | on-disk before | after | resident Δ | what moved |
|---|---:|---:|---:|---|
| `triage/SKILL.md` | 8,583 tok | 8,077 tok | **−506 tok** (−42 ln) | deslop + the **rare** close-not-planned protocol lifted to [`triage/close-not-planned.md`](../claude-plugins/kampus-pipeline/skills/triage/close-not-planned.md) (681 tok), `Read` **on-demand only on a kill** — never resident on the common triaged / needs-info paths |
| `write-code/SKILL.md` | 26,277 tok | 26,213 tok | **−64 tok** (−5 ln) | deslop of the `gh api` + glossary boilerplate (within the resident first-~837-line window — see the caveat below) |

**Translating the resident Δ to billed tokens, grounded in the transcript.** `cache_read` is the
resident prefix re-charged every turn (§2). The per-turn `cache_read` series of the triage baseline
shows the skill enters the cached prefix at **turn 10** (`cache_read` steps 12,981 → 29,023 as the
~16k skill+context block becomes resident) and stays resident through turn 19 — **10 of 19 turns**.
So a −506 tok core shifts the entire tail of that series down by 506:

```
triage, per fanned agent:
  cache_read saved   = 506 tok × 10 resident turns      = 5,060 tok
  one-time ingest    = 506 tok (the turn-10 cache_creation) ≈   506 tok
  billed saved/run   ≈ 5,566 tok   (vs baseline billed 592,499 → ~586,933, −0.94%/run)
```

The per-run figure is modest **by design** — it is one disciplined, quality-safe extraction, not an
aggressive cut. Its weight is the **Rank-4 multiplier**: the triage loop fans **1–9 agents per
batch** (one per issue), each re-paying the scaffolding with no sharing, so the saving is paid back
N×:

```
9-issue triage batch:  9 × 5,566 ≈ 50,094 tok saved, before any issue-specific work
```

This is the fan-out lever's actual mechanism (audit Rank 4): the realized cross-fan-out win is the
**indirect N× multiplication of every scaffolding token trimmed**, not a shared cache. write-code's
−64 tok is reported transparently as a small contribution; its larger structural smell — the skill
exceeds a single `Read`'s return cap, so the baseline `agent-a734c4b6dc387a61` `Read` it once with
no pagination and operated on the **truncated first ~837 lines** — means trims *past* that window do
not reduce *this* initial-build baseline's resident prefix (it was already truncated away). Only
trims inside the resident window (where the boilerplate deslop lands) count against this baseline;
the full thin-core restructure that would bring write-code under the `Read` cap is left as the
forward Rank-3 lever, not forced here.

**Quality gate (§3) — PRESERVED, by construction.** The trim relocated and compressed; it removed
**no decision rule**. For the triage oracle (`#1227` → `type:decision` + `p2` + `status:triaged`):
the type table, the boundaries-that-bite, the priority table, the enrich/split rules, the
human-vs-agent judgment, and the Step-0 claim protocol are all byte-substance-unchanged, and the
extracted close-not-planned path is **never on `#1227`'s outcome** (a triaged decision, not a kill),
so the classifier's inputs — and thus its output — are identical. For the write-code oracle (`#1223`
→ `Fixes #1223` + green CI + `review-code: PASS`): only `gh api`/glossary prose changed, no step of
the build procedure. `validate-skills` passes (16 skills valid), and every cross-reference still
resolves (Step 3 → Step 6 → the contract). The gate here is the structural no-rule-dropped argument
plus this PR's independent review — not a paid oracle re-run (per the lever brief, an expensive
re-run is not required to measure a relocation whose decision path is provably unchanged).

### Sub-levers 2 & 3 — shared-context reuse / cache-window scheduling (EVALUATED, NOT SHIPPED)

Both target *cross-spawn* reuse, and both are blocked by the same measured fact the audit already
established (Rank 4): **separate sub-agent sessions share no prompt-prefix cache.** A 5-min cache TTL
(sub-lever 3) and a "pass the shared context once" scheme (sub-lever 2) only pay off *within one
session's* turn sequence — which the harness already caches automatically. Across the fan-out the
agents are independent sessions by construction, so neither can reduce billed tokens without
collapsing N issues into one shared session — which would **break the one-agent-per-issue isolation
AC3 forbids** (one issue's context must never leak into another's verdict). There is therefore **no
quality-neutral, isolation-preserving token reduction** to measure for 2 or 3; shipping a
speculative scheduler change with no measured win would violate the "real reduction **and** rubric
pass" bar. Per the lever's own discipline (*ship only what wins; under-claiming beats a regression*),
they are recorded as not-applicable-as-direct-levers, and the realized fan-out win is sub-lever 1
multiplied N× (above).

### Net recorded delta (against the §2 baseline)

| Lever | Measured before/after | Quality gate (§3) | Outcome |
|---|---|---|---|
| 1 — thin-core skill / tighter prompts | triage core −506 tok → **≈5,566 tok/run**, **≈50k/9-issue batch**; write-code core −64 tok | PRESERVED (no rule dropped; oracle inputs unchanged) | **SHIPPED** |
| 2 — shared-context reuse | no isolation-preserving reduction (separate sessions, no shared prefix cache) | n/a (would break AC3 isolation) | not shipped |
| 3 — cache-window scheduling | no cross-session reduction (5-min TTL is intra-session only) | n/a | not shipped |

**Net: 1 of 3 sub-levers shipped** — a real, quality-preserved scaffolding reduction whose value is
the Rank-4 N× fan-out multiplication. The remaining two are honestly out, grounded in the audit's
measured cross-session-cache finding, not shipped as speculation.

## 5. Applied-lever results — #1373 read economics (measured-negative on the frozen set)

The **read-economics lever** ([#1373](https://github.com/kamp-us/phoenix/issues/1373), the sibling
of the fan-out child [#1374](https://github.com/kamp-us/phoenix/issues/1374)) acts on the audit's
**Rank 5** ([token-economics-audit.md](./token-economics-audit.md)) — *full-file `Read` vs excerpt*,
explicitly named there as **the smallest controllable surface on the frozen set**, "situational, not
headline." The lever: where a pipeline skill has a sub-agent `Read` a **whole file** when an
`offset`/`limit` excerpt or an `Explore` sub-agent (excerpts, not whole files) carries the same
signal, prefer the cheaper read — **without losing grounding**. The discipline (per the lever brief):
apply only where the baseline-vs-after number shows a real reduction **and** the §3 rubric confirms
accuracy held; a measured-negative is a legitimate, recorded outcome — honesty over a forced edit.

### Measurement — the read surface, per frozen-set transcript (reproduces §2 billed exactly)

Per-`tool_result` size attributed by tool-use id over the three §1/§2 baseline sub-agent transcripts
(`triage agent-af3afc3fc26976`, `write-code agent-a734c4b6dc387a613`, `review-code agent-ad29433525afd436`).
The four-component `usage` reconstruction reproduces each recorded `billed_tokens` exactly
(592,499 / 2,076,940 / 1,325,645), so the read attribution rests on the same anchored numbers.

| Stage | `Read` calls | `Read` tok (≈chars/4) | what was read | excerptable **source** Read |
|---|---:|---:|---|---|
| triage #1227 | 1 | ~9,084 | `triage/SKILL.md` **whole** (the agent's own procedure) | **none** |
| write-code #1223 | 3 | ~14,680 | `write-code/SKILL.md` whole + `biome.jsonc` whole (~505 tok) + `biome.jsonc` again **already `limit=20`** | **`biome.jsonc` (~505 tok)** |
| review-code #1199 | 1 | ~133 | `ship-it/SKILL.md` **already `offset=744 limit=12`** | **none** (uses `Agent`/Explore + scoped `gh api` Bash diffs) |

For comparison, non-`Read` context ingest on the same runs: triage Bash ~1,677 tok; write-code Bash
~4,457 tok; review-code Bash ~8,645 tok + 2 `Agent`(Explore) sub-agents ~911 tok. Review-code pulls
its diff context through scoped `gh api` Bash and Explore sub-agents — **not** whole-file source
`Read`s.

### The finding — the lever has no purchase on the frozen set, and the agents already practice it

1. **The only *large* whole-file `Read`s are the skills themselves** (triage `9,084` tok, write-code's
   skill). A skill is the agent's own decision procedure; it cannot be excerpted by a read-guidance
   line without the agent losing the very rules it must follow — and it is the **Rank-1/3 skill-bloat
   surface the §4 thin-core lever (#1374) already targets**, explicitly out of scope for read-economics.
2. **The only genuine source/context `Read` is write-code's `biome.jsonc` (~505 tok)** — already tiny;
   an excerpt saves a rounding error, and the agent's **second** read of it already used `limit=20`.
3. **review-code is already the read-economics exemplar** — it excerpts the skill (`offset=744 limit=12`,
   133 tok), reaches for `Explore` `Agent` sub-agents, and scopes diff context via `gh api` Bash rather
   than whole-file source `Read`s. There is nothing to convert.

This is **stronger than the audit predicted**: not only are the frozen inputs' source files tiny, but
where excerpting *does* apply the agents on these runs **already** use `offset`/`limit` and `Explore`
sub-agents. A read-guidance tightening in the skills would change **zero** bytes of these three runs'
context and therefore measure **≈0 tok/run** against every §2 baseline row.

### AC3 — surfaces explicitly left whole-file, with reason

Per the lever's AC3 ("surfaces where excerpting risks grounding are explicitly left whole-file with a
stated reason"):

- **The skill `Read` (triage, write-code)** — left whole-file: the agent needs its *complete* decision
  procedure; excerpting it would drop guards and flip the §3 oracle. (Its size is the Rank-1/3
  skill-bloat surface, addressed by the §4 thin-core split, not by read-economics.)
- **`biome.jsonc` (write-code)** — left whole-file: at ~505 tok the whole file *is* the excerpt; a
  read-guidance line is dominated by noise.
- **review-code diff context** — already excerpted (scoped `gh api` Bash + `Explore` sub-agents); no
  whole-file source `Read` exists to tighten.

### Net recorded delta (against the §2 baseline)

| Lever | Measured before/after | Quality gate (§3) | Outcome |
|---|---|---|---|
| read-economics (excerpt/Explore over whole-file `Read`) | **≈0 tok/run** on every §2 row — the only large `Read`s are the skills (Rank-1/3, sibling lever); the only source `Read` is `biome.jsonc` ~505 tok; review-code already excerpts (`offset/limit` + `Explore` + scoped Bash) | trivially PRESERVED — **no change applied**, so no oracle input moved | **NOT SHIPPED — measured-negative recorded** |

**Net: read-economics yields ≈0 on the frozen set and is not worth a skill change here.** A
read-guidance edit would be a forced change with no measured win — the brief's explicit anti-pattern —
so none is made. The Rank-5 verdict is confirmed empirically: the lever is **situational** (real only
on source-heavy tasks the frozen set doesn't exercise), not a frozen-set win. This mirrors §4's
sub-levers 2 & 3: a quality-neutral lever with no measurable reduction on the measured inputs is
recorded as not-shipped, grounded in the numbers, never shipped as speculation.

## Tooling gap (follow-up)

Per-stage token spend **is** individually attributable offline — each stage sub-agent has its own
`<parent-session-id>/subagents/agent-<agent-id>.jsonl` transcript (§2) — but Claude Code does **not**
persist its `cost.total_tokens` aggregate *into* that transcript; only the per-message `usage`
components are stored, so a number requires the §2 four-component reconstruction (a hand-run `jq`).
A small `pipeline-cli` reporter that, given a stage agent's transcript, emits the `formatSessionCost`
line (reusing `spawn-guard`'s pure core read-only) would make matched before/after measurement a
one-command step. Filed as report residue ([#1382](https://github.com/kamp-us/phoenix/issues/1382));
not built here to keep this child a non-control-plane doc artifact.
