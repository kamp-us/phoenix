# Token-economics audit — where pipeline tokens actually go

The **ranked map of token spend** the token-economics epic
([#1356](https://github.com/kamp-us/phoenix/issues/1356)) acts on: an attributed,
*measured* breakdown of where a pipeline stage's tokens go today, so the Phase-3 lever
children ([#1373](https://github.com/kamp-us/phoenix/issues/1373) /
[#1374](https://github.com/kamp-us/phoenix/issues/1374)) know which levers are worth
applying. This is the **audit** layer over the
[measurement apparatus](./token-economics-measurement.md) — it reuses that doc's frozen
task set, its `spawn-guard`-grounded measurement procedure, and its per-stage sub-agent
transcript reconstruction. Read it first; this doc does not restate the meter.

Every share-of-spend figure below is reconstructed from the **actual `claude-opus-4-8`
sub-agent transcripts** on the apparatus's §1 frozen inputs (triage #1227, write-code
#1223→PR #1224, review-code PR #1199), not asserted. The audit script
(`Σ usage` over the transcript + per-`tool_use`/`tool_result` attribution by tool-use id)
reproduces the apparatus's recorded `billed_tokens` exactly (592,499 / 2,076,940 /
1,325,645), so the breakdowns rest on the same numbers a lever reports against.

## The headline: spend is dominated by *re-reading resident context every turn*, not by any one-time ingest

The apparatus already flagged that `cache_read` dominates `billed_tokens`. The audit
quantifies *what* sits in that re-read prefix. `cache_read_input_tokens` is the cached
context prefix re-charged **on every turn**, so a stage's cost is approximately

```
billed ≈ Σ_turns (resident_prefix_size)   +   one-time ingest   +   output
         └──────── cache_read (70–93%) ────────┘
```

A token placed in the resident prefix is paid **once to ingest and again on every
later turn**. So the ranking axis is not "how big is this read" but **resident size ×
how many turns it stays resident**. Measured `cache_read` share of `billed`:

| Stage | turns | billed | cache_read | cache_read % of billed | ex-cache-read |
|---|---:|---:|---:|---:|---:|
| triage (#1227) | 19 | 592,499 | 417,074 | **70%** | 175,425 |
| write-code (#1223) | 42 | 2,076,940 | 1,925,125 | **93%** | 151,815 |
| review-code (#1199) | 31 | 1,325,645 | 1,144,223 | **86%** | 181,422 |

The per-turn `cache_read` series shows the prefix is a **fixed scaffolding floor plus a
slowly-growing task tail**. E.g. triage's resident prefix steps `~13k` (system + tools +
memory + task prompt) → `~29k` (skill loaded) → grows to `40k` (accumulated Bash
results) and is re-read at each step:

```
triage   cache_read/turn: 0 0 0 0  12981×5  29023×3  35538 35538 37400 37400 39556 39556 40112
write-code  …: 0 0 0  13770×2  40518… → 60942 (climbs every turn over 42 turns)
review-code …: 4637×3  14848×3  28256… → 52564
```

Splitting each turn's `cache_read` into the fixed **scaffolding** floor (system + tool
schemas + injected `CLAUDE.md` memory + the loaded skill) vs the **task tail**
(issue/PR-specific reads and reasoning):

| Stage | scaffolding cache_read | = % of billed | task-tail cache_read |
|---|---:|---:|---:|
| triage | 355,135 | **60%** | 61,939 |
| write-code | 1,129,030 | **54%** | 796,095 |
| review-code | 574,380 | **43%** | 569,843 |

**43–60% of every stage's total spend is re-reading fixed scaffolding that never changes
across the run** — and (Rank 4) that scaffolding is re-paid in full by every agent in a
fan-out. This is the spend the levers should target first.

## Ranked map of token-heavy surfaces

Ranked by measured share of spend × tractability. Each carries a candidate
**quality-neutral** lever and a first-cut effort/impact. "Quality risk" is the rubric
risk from the apparatus §3 no-compromise gate.

### Rank 1 — Resident scaffolding re-read every turn (system + tool schemas + `CLAUDE.md` memory + the loaded skill)

- **Measured share:** 43–60% of total billed (the scaffolding `cache_read` table above).
- **Why it dominates:** the scaffolding is resident from an early turn to the last and is
  re-charged at full size every turn. The one-time ingest is small (first-turn `in+cc`:
  triage 12,983 / write-code 13,772 / review-code 21,555 tok — review-code higher because
  its skill is preloaded via `skills:` frontmatter into the cached system prompt rather
  than `Read`); the multiplier is the cost.
- **Surfaces measured (repo-relative):** the per-stage skills under
  `claude-plugins/kampus-pipeline/skills/*/SKILL.md`; the injected root
  [`CLAUDE.md`](../CLAUDE.md); the harness system prompt + tool schemas (platform, not
  repo-controllable text).
- **Candidate lever:** split each skill into a thin **resident procedural core** + lazily
  `Read` reference contracts (the `gh-api-intake-formats` / preflight-detail split already
  exists for some skills — extend it), so only the decision-bearing procedure stays in the
  prefix; trim the injected `CLAUDE.md` footprint for sub-agents. **Quality risk: medium**
  — the decision-bearing guards must stay resident; over-trimming a guard flips the rubric.
- **Effort/impact:** effort med (skill restructure) / low (memory trim); **impact high**
  (largest single share, and multiplied by Rank 4).

### Rank 2 — Turn count as the `cache_read` multiplier

- **Measured share:** the entire `cache_read` column scales with turns. write-code's 42
  turns drove `cache_read` to 1.93M (93% of billed) vs triage's 19 turns / 417k. The
  prefix also *grows* each turn (accumulated tool results + reasoning), so late turns are
  the most expensive (write-code climbs 13.7k → 60.9k resident).
- **Surface measured:** the round-trip count in each stage transcript; the loop driver
  `.claude/workflows/drive-issue.js` and the stage skills' tool-call patterns.
- **Candidate lever:** batch independent tool calls into one assistant block (the skills
  already advise this — enforce it), drop redundant Bash probes / re-`Read`s, and stop at
  the deliverable. **Quality risk: low** (behavioral; same artifacts, fewer round-trips).
- **Effort/impact:** effort med (behavioral, hard to enforce mechanically) / **impact
  high** for write-code and review-code.

### Rank 3 — Skill / prompt bloat (the resident-prefix sub-surface the brief named)

- **Measured share:** the skill is the largest single *controllable* block of Rank 1.
  On-disk pipeline skills today:

  | Skill | lines | ~tokens |
  |---|---:|---:|
  | `write-code/SKILL.md` | 1,618 | ~26,277 |
  | `review-code/SKILL.md` | 1,259 | ~21,170 |
  | `ship-it/SKILL.md` | 1,084 | ~19,040 |
  | `plan-epic/SKILL.md` | 895 | ~14,063 |
  | `review-doc/SKILL.md` | 776 | ~12,337 |
  | `review-skill/SKILL.md` | 718 | ~11,415 |
  | `triage/SKILL.md` | 600 | ~8,583 |

  At run time the skill ingested ~8.8k tok (triage, full) / ~13k tok (write-code).
- **Sharp finding — the skill exceeds a single `Read`'s return cap:** at the write-code
  baseline run `write-code/SKILL.md` was 1,483 lines and the `Read` returned only **837
  lines (the first 56%)** before truncating. An agent therefore either operates on a
  *partial* skill or must paginate with extra `Read`s (more turns → Rank 2). A skill too
  big to read in one call is a structural smell, not just a size one.
- **Candidate lever:** restructure each skill into a thin procedural core + referenced
  contract docs read on demand (same lever as Rank 1, scoped to the skill text).
  **Quality risk: medium** — keep every guard/decision rule in the resident core.
- **Effort/impact:** effort med-high / **impact high** (feeds Rank 1 and, via Rank 4, is
  multiplied across the fan-out).

### Rank 4 — Repeated context across the sub-agent fan-out (cross-spawn duplication)

- **Measured share (by multiplication):** invisible within one transcript, but each
  fanned-out agent re-pays the full scaffolding with **zero sharing**. A single triage
  spawn's `ex-cache-read` is 175k, of which ~22k (overhead + skill) is non-task
  scaffolding ingested fresh, and **~85% of its 417k `cache_read` is scaffolding
  re-read**. The triage loop spawns **1–9 agents per batch** (one per issue). A 9-issue
  batch ≈ 9 × (~22k scaffolding ingest + ~355k scaffolding `cache_read`) ≈ **3.4M tokens
  of duplicated scaffolding** before any issue-specific work, plus each independently
  re-reads the same shared repo files ([`CLAUDE.md`](../CLAUDE.md), the skill, common
  source).
- **Surface measured:** the one-agent-per-issue fan-out in the triage loop / the workflow
  driver; the per-spawn scaffolding figures above.
- **Candidate lever:** the **indirect** win — every token trimmed from scaffolding (Rank
  1/3) is multiplied by N here, so skill/memory trim pays off N× across a batch. A
  *direct* shared-context cache across a batch is hard (separate sessions share no prefix
  cache). **Quality risk: low** (indirect lever changes nothing per-agent).
- **Effort/impact:** effort low for the indirect lever (already Rank 1/3), high for true
  cross-spawn sharing / **impact high at batch scale** (multiplies Rank 1).

### Rank 5 — Full-file `Read` vs excerpt, and Bash-output ingest (one-time tool-result ingest)

- **Measured share — the honest correction:** on the frozen set this is the **smallest**
  controllable surface. These specific inputs touch tiny files: write-code `Read`
  `biome.jsonc` (~505 tok); review-code `Read` **no** large source at all (its ~24k of
  tool-result ingest is Bash output — `gh api` diffs / `git`); triage `Read` only its
  skill. **Full-file-`Read`-of-source did not materialize as a major cost on the frozen
  inputs.** The candidate is real in principle (large source files on source-heavy tasks)
  but under-represented by these small frozen inputs — a caveat the Phase-3 children
  should weigh before betting on it.
- **Surface measured:** the `Read`/`Bash` tool-result sizes per transcript; the gate
  diff-fetch in `review-code/SKILL.md`'s `gh api` calls.
- **Candidate lever:** prefer `offset`/`limit` excerpts over whole-file `Read`; scope
  `gh`/`git` diff output. **Quality risk: low-medium** — reading too little can miss
  context, so scope deliberately, don't blind-truncate.
- **Effort/impact:** effort low / **impact low on the frozen set**, situationally medium
  on source-heavy tasks.

## How the brief's four named candidates landed

| Brief candidate | Where it ranked | Measured verdict |
|---|---|---|
| Skill / prompt bloat | **Rank 3** (sub-surface of Rank 1) | Real and high-impact — but the cost is the *resident re-read* (Rank 1), not the one-time load; one skill even exceeds a single `Read` cap. |
| Repeated context across the fan-out | **Rank 4** | Real and high at batch scale; ~85% of a triage agent's `cache_read` is scaffolding, re-paid by every one of 1–9 agents. |
| Per-subagent source re-reading | folded into **Rank 4 / 5** | The re-read that matters is the *scaffolding* (Rank 1/4), not shared source — source re-reads were small on the frozen set. |
| Full-file `Read` vs excerpt | **Rank 5** | Smaller than the brief assumed *on these inputs*; flagged as situational, not headline. |

The audit's net finding beyond the brief: the dominant, previously-unranked surface is
**resident scaffolding re-read every turn (Rank 1) amplified by turn count (Rank 2) and
by the fan-out (Rank 4)** — that is where the spend actually concentrates, and where the
quality-neutral levers (skill restructure, memory trim, fewer round-trips) compound.

## Reproducibility & caveats

- **Method:** offline four-component `usage` reconstruction per
  [token-economics-measurement.md §2](./token-economics-measurement.md), plus
  per-`tool_use`/`tool_result` attribution by tool-use id over the same three frozen-set
  sub-agent transcripts. The reconstruction reproduces the apparatus's recorded
  `billed_tokens` exactly, anchoring the breakdowns.
- **Token sizing** of on-disk files and tool results uses a `chars ÷ 4` approximation
  (English/code); the `usage`-derived figures (`billed`, `cache_read`, first-turn ingest)
  are exact Claude-Code counts. Where the two are compared (skill on-disk vs ingested),
  expect ±10–15%.
- **Model:** `claude-opus-4-8`, the fleet's pinned model
  (`packages/pipeline-cli/src/tools/spawn-guard`).
- **The skills are a live-edited moving target:** run-time sizes differ from current
  on-disk (write-code was 1,483 lines at the baseline run, 1,618 now). Run-time transcript
  figures are authoritative for "what was spent"; on-disk sizes are the forward-looking
  lever target.
