# `/plan-epic` — derived CLI contract

**Skill:** [`plan-epic`](SKILL.md) · **Authoring brief:** [#4712](https://github.com/kamp-us/phoenix/issues/4712) · **Date:** 2026-08-09

The verbs land in `packages/fabrika-cli/` under the **`ledger`** subcommand group, registered in
`packages/fabrika-cli/src/registry.ts` like the shipped groups, every leaf declared via
`leafCommand` (`src/excess-operand.ts` — a bare `Command.make` silently opts out of the
excess-operand guard, and `excess-operand.unit.test.ts` reds on it). The
[CLI interface convention](../../docs/cli-interface-convention.md) governs every verb; where this
spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill** (ADR 0238). The v1 machinery
named below — `claude-plugins/kampus-pipeline/skills/plan-epic/scripts/`, and under
`packages/pipeline-cli/src/tools/`: `epic-lock/`, `epic-splice/`, `epic-ledger/`,
`intake-compose/`, `intake-dedup/`, `scratchpad/`, `homing-guard/`, `reachability-guard/` — is
prior art **read** for semantics and scars; none is invoked, wrapped, or deferred to. Every v1
module name cited in this spec is **non-normative**: the behavior it informs is restated here in
full, and an implementer needs none of those files to build these verbs.

**The group name.** `ledger` is this skill's, following the one-group-per-skill precedent
(`build-ui` took `ui`, `build-epic` took `epic`, `check-epic-plan` took `plan`, each reusing
`build`'s verbs rather than sharing its group). `plan` and `epic` are both occupied at `main` and
neither answers this skill's question: `plan`'s four verbs read, gate and flip a plan that already
exists, and `epic`'s eight conduct a run over one already gated. **Authoring is unoccupied** —
nothing shipped creates an issue with a full classification, links a sub-issue, or composes a
`## Dependencies` or `### User stories` block.

**One disambiguation, because the word is overloaded in this package.**
`packages/fabrika-cli/src/epic/ledger.ts` calls its append-only JSONL run log a "ledger". That is
the *run* ledger. This group's `ledger` is the **plan** — the noun the brief and
[`check-epic-plan`](../check-epic-plan/SKILL.md) both use for an epic's decomposed task list. The
two never meet: no verb here reads or writes an `epic` run ledger.

**What fabrika already ships, reused — never respecified.** The claim is the **`build` group's,
reused as landed verbs** ([`build`'s contract](../build/contract.md)) — the cross-contract shape
`build-ui` sanctioned: this skill claims the epic with `fabrika build claim --purpose plan`, proves
its worktree with `fabrika build tree`, releases with `fabrika build release`, and posts a successor
note with `fabrika build note`. The purpose is part of the reuse, not a detail of it: `build claim`'s
audience axis asks whether an agent should pick the issue up to *build*, and an epic earns
`ready-for:agent` only after this skill has planned it and the gate has passed it, so a `plan` claim
is admitted without it (founder ruling,
[#5175](https://github.com/kamp-us/phoenix/issues/5175)). The scope axis is unchanged by the purpose,
so `20` stays reachable and `21` does not, and `--override` stays the exception it was.
**No second lock is derived**, and v1's `epic-lock` is why: all five of its
distinct outcomes collapse onto exit `1`
(`packages/pipeline-cli/src/tools/epic-lock/command.ts:26,43-47`), it `POST`s the
`status:planning` label *before* the claim comment so a failed claim leaves a held label with no
owner (`github.ts:64-66` — "a human clears it"), and `release` re-finds "our own" claim **by
session id**, so a sibling lane's release retracts the holder's claim. Modules reused by import:

- `packages/fabrika-cli/src/io/issues.ts` — `resolveRepo`, `getIssue` (three-way
  `Present` / `Absent` (404 only) / `Unknown`), `httpStatusOf` (the status-not-stderr-text split
  that makes `7`-versus-`11` decidable), `listComments`, `splitJsonArrays`, `listLabels`,
  `listOpenMilestones`, `addLabels`, `setMilestone`, `patchIssueBody`.
- `packages/fabrika-cli/src/build/dependencies.ts` — `readTopology`
  (`Parsed` / `Absent` / `Unparseable{line,text}`), `predecessorsOf`, `sameRef`, `renderRef`.
  **This spec adds no second `## Dependencies` grammar**; it composes a block the shipped parser
  reads back, and `ledger topology` proves that round trip.
- `packages/fabrika-cli/src/plan/ledger.ts` — `unfencedLines`, `sectionCount`,
  `readEpicStories`, `readChildStories`, `readContainment`, `USER_STORIES_HEADING`,
  `STORIES_FIELD`, `CONTAINMENT_FIELD`. The gate's reader is this skill's **validator**: composing
  against anything else is how a planner writes a ledger its own gate rejects.
- `packages/fabrika-cli/src/wire/acceptance-criteria.ts` — the total three-armed read
  (`Found` / `Absent` / `Malformed`), fence-aware. `ledger child` validates each composed child
  body through it. The wire registry already pins this format as the contract between a planner's
  output and the gate's input.
- `packages/fabrika-cli/src/report/leaks.ts` (`scanBody`, `isBareAtReference`, `renderLeaks`) and
  `src/report/compose.ts` (`normalizeForReadback` — **three steps; read the body, the docblock
  understates it**). Every verb that authors public text imports both.
- `packages/fabrika-cli/src/report/dedup.ts` — `rank`, `tokenize`, `renderCandidate`, and the
  three-valued `Outcome` (`candidates` / `none` / `indeterminate`). `ledger open` imports it.
- `packages/fabrika-cli/src/plan/github.ts` — `listSubIssues` (the epic's native sub-issue list,
  paginated, typed-JSON decoded) and `probeCycleDoc`. `ledger open` imports both rather than
  growing a second reader of the same endpoint; the *write* half of the sub-issue relation does
  not exist anywhere and is derived new by `ledger child` and `ledger supersede`.
- `packages/fabrika-cli/src/build/claim.ts` — `requireSession` and `requireClaim` (this session holds
  it, proven now); the claim nonce comes from `src/build/lane.ts`'s `nonceOf`. Every verb runs `requireClaim`; the nonce is the run key.
- `packages/fabrika-cli/src/build/worktree.ts` — `assertGround`; and
  `src/build/target.ts` — `resolveTargetRepo`, `openIssue` (pre-seats the `7` / `11` refusals),
  `badNumber`, `scannedLine`.

A restatement of any of these would be a transcription, and a transcription drifts. The spec says
*import this*, with the path.

**Considered and deliberately not derived** — each already enforced or owned elsewhere (interface
convention rule 6; conventions §7 homes these in `.out-of-scope/`, unbootstrapped — tracked inline
as the sibling contracts do):

- **A milestone-homing check.** `homing-guard` is the one v1 tool of the eight in field 4 that
  fires at a CI seam — `.github/workflows/homing-guard.yml`, job `check`, on `issues`
  label/milestone events plus a weekly cron. The skill **states the expectation** (a child is
  homed or standing-lane exempt) and computes no second answer, because a planner that told an
  author "homed" while the guard reds is worse than one that stays quiet.
- **The structural floor.** `fabrika plan check` is the whole pass/fail decision over the
  thirteen hard defects, and it is [`check-epic-plan`](../check-epic-plan/contract.md)'s. This
  group derives no second verdict; `ledger draft`, `ledger child` and `ledger topology` each
  validate *the document they are composing* so a defect is caught at authoring time, which is a
  different question from grading a finished ledger.
- **A `status:triaged` flip.** The gate's, unconditionally (#4693 AC4). No verb here writes it.
- **A pickability predicate.** `build`'s picker question, open on
  [#4920](https://github.com/kamp-us/phoenix/issues/4920).
- **A reachability check.** `reachability-guard` answers a flag-graduation question at the
  `/release` seam; nothing in planning needs it, and its v1 shape is pinned to one app's paths.
- **A convergence / re-plan loop.** v1 exported `runConvergenceLoop` and registered it as no
  command at all. A defective plan is re-planned by re-running this skill, not by a verb that
  loops.
- **A planning lock, a repo resolver, a scratch opener, a link confirmer.** All four exist in v1
  as scripts whose entire body relays an upstream answer (`resolve-repo.sh`, `scratch-open.sh`,
  `epic-lock-release.sh`, `confirm-links.sh`). A relay-only verb is not a verb (ADR 0238).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `ledger open` | prove the ground fresh, allocate the run, read what already exists, rank duplicate candidates | fetch + freshness proof + a registered ranker — no judgment; *whether a candidate really is this work* stays in the skill |
| `ledger draft` | validate and stage the model-authored plan block | a total grammar check over a closed section set; *whether the plan is any good* is irreducibly the skill's |
| `ledger child` | mint one child with every birth attribute in one create, link it, re-read it, record it | a guarded write with a read-back; *what the child should contain* is the skill's, taken as input |
| `ledger topology` | validate the declared edges against the recorded children and render the block | a total function from edges to a verdict — cycles, dangling refs and orphans are decidable; *which slices may run in parallel* is the skill's |
| `ledger write` | splice the staged plan and topology into the epic body, byte-verified | anchor resolution + a guarded PATCH with a round-trip diff — no judgment |
| `ledger supersede` | retire a child the re-plan no longer contains | an ordered three-leg write with a read-back; *which child to retire* is the skill's |

**Considered and not derived: a `ledger validate` verb** that pre-runs the gate's floor. It would
compute a second answer to a question `fabrika plan check` decides, which is the `adr classify`
test the pilot dropped a verb on.

## The ledger grammar this skill WRITES

`check-epic-plan` specifies the grammar it **reads**; this section specifies what this skill
**emits** into that grammar, byte for byte, because a planner and its gate disagreeing on a
separator is a defect neither can see alone. Where the two documents describe the same field, the
gate's reader is authoritative and this composer is held to it by the imported modules above.

**The epic body, after a successful `ledger write`:**

```
## Pitch

<pitch>

## Epic — awaiting plan

`plan-epic` appends its plan and dependency topology below.

<!-- fabrika:enriched issue=4300 mode=wrap -->
<details>
<summary>Original brief (verbatim)</summary>

<original>

</details>

## Plan (plan-epic)

<the staged plan block>

## Dependencies

- phase 1: #4301, #4302
- phase 2: #4303
- #4303 requires: #4301
```

**The plan region is located by the enrichment marker, never by position.** Detection is the
verb-written `<!-- fabrika:enriched issue=<N> mode=<rewrite|wrap> --> ` line, matched whole-line
(`packages/fabrika-cli/src/triage/enrich.ts:41`), which is one mode-independent rule closing both
the position axis ([#4850](https://github.com/kamp-us/phoenix/issues/4850)) and the mode axis
([#4866](https://github.com/kamp-us/phoenix/issues/4866)). **This is the route taken on
[#4896](https://github.com/kamp-us/phoenix/issues/4896)'s open fork, and the reason is that a
sibling already shipped it**: with the marker doing the detecting, appending the plan below the
brief envelope breaks no detector, so the wrap-last layout inversion, its three coupled changes
and its legacy migration are all unnecessary. #4892's remedy (c) — making the `--epic` envelope
independent of a splicer's anchor set — is thereby **moot**; that issue owns its own ADR write-up
and this contract does not pre-empt it.

**Plan block — the closed section set.** `## Plan (plan-epic)` followed by exactly these `###`
headings, each present exactly once, in this order:

`Summary` · `Problem & who has it` · `What changes` · `User stories` · `Goal / non-goals` ·
`Resolved questions` · `Approach` · `Testing strategy` · `Task-split rationale` ·
`Vocabulary impact`

**`### User stories` is an ordered list and the leading integer is the story id** — the gate's
`readEpicStories` collects ids only from ordered-list rows, so an unordered bullet or an `S3`
label yields *zero stories* and the whole plan reads as declaring none. Ids must run contiguously
from 1 with no repeats.

**Child body — composed, then validated through the imported readers:**

```
**Stories:** 1, 2
**TDD:** yes
**Containment:** flag (default-off)

### What to build
<prose>

### Acceptance criteria
- [ ] <observable, externally checkable criterion>
```

Byte rules, each one a v1 scar designed out: the three field lines are consecutive with no blank
between them; exactly one blank line before `### What to build` and before
`### Acceptance criteria`; **no blank line between `### Acceptance criteria` and its first
bullet**; criteria are `- [ ] ` checkbox rows; a single trailing newline.
**`**Stories:**` carries bare integers only**, and the composer refuses a value that is not `none`
or a comma-separated integer list. The refusal is worth having because **v1** harvested every digit
run in the value, so `1, 3 (see #4021)` silently claimed a story 4021 no epic declared. The
downstream gate does not repeat that: it reads a non-conforming value as *absent* and reports it in
`detail`. Refusing at authoring time is what keeps the two from disagreeing. `**Containment:**`'s **leading keyword** is one of `flag` / `exempt` / `none`, a trailing
parenthetical is preserved verbatim (`flag (default-off)` is the ordinary form), and the field is
emitted **only** when the cycle-doc probe reads `present` — v1's documented spec template omitted
the field entirely while its skill body required it, so an author following the template dropped
it on every child and the tolerant read made "forgot" indistinguishable from "no cycle doc".

**`## Dependencies` — the rendered block.** Exactly the two line forms `readTopology` parses, and
nothing else: one `- phase <n>: #<ref>[, #<ref>…]` row per phase, phases ascending and members
ascending within a row, then one `- #<ref> requires: #<ref>[, #<ref>…]` row per child that declares
a prerequisite, ascending by subject. There is no `###` heading inside the section, no label column
and no parenthesized clause — `readTopology` breaks at the first heading of any level
(`ANY_HEADING_RE`, `packages/fabrika-cli/src/build/dependencies.ts:47,84`), so a `### Phase <n>`
line would end the scan on the line after `## Dependencies` and the block would read back as zero
edges: a well-formed, plausible, always-wrong answer the gate then reads as an epic every one of
whose children is orphaned. The block ends with a trailing blank line so a later heading stays
separated. The illustrated block above is the round trip this grammar buys — pasted into
`readTopology` it parses to the three edges it depicts (`phase 1: #4301, #4302`, `phase 2: #4303`,
`#4303 requires: #4301`), never the empty set, which is what lets `ledger topology` stage instead of
refusing on `24`.

## The body digest

`ledger open` prints a **body digest**: the first **12 lowercase hex** of the SHA-256 of the epic's
body text, taken after `normalizeForReadback`. `ledger draft` and `ledger write` **require** it as
`--body-digest`; each re-reads the live body, recomputes, and refuses on `21` if it differs.

**The digest covers the body text and nothing else, and that scope is the invariant the group
rests on.** Walked against every write this contract makes:

| Write | Touches the epic body text? |
|---|---|
| `ledger child` — create issue, add labels/milestone/assignee | no — a different issue |
| `ledger child` — link as sub-issue | no — `sub_issues` is a separate relation; the body is untouched |
| `ledger topology` — render into the run directory | no — nothing reaches GitHub |
| `ledger supersede` — comment, unlink, close the child | no — a different issue |
| `ledger write` — PATCH the epic body | **yes, and it is the last write of the run** |

So the digest taken at `open` still binds through minting, topology and supersede, and is consumed
by the single body write. **It is void afterwards**: a second `ledger write` in one run is not a
supported operation, and a caller that re-uses a spent digest gets `21` rather than a silent
double-splice. Unlike the sibling gate's scope digest this one is deliberately *not* neutral to
its own guarded write — the write is terminal, so neutrality would buy nothing and would require
excluding the very bytes being verified.

**Normalizing before hashing is a scar fix, not tidiness.** v1's splice round-trip compared raw
bytes while its only caller captured stdout through command substitution, which strips every
trailing newline before the PATCH — so what GitHub stored was never what was emitted and the
comparison was structurally unwinnable (#4599). Hashing the normalized form makes a trailing-
newline round trip a match instead of a false `21` on every clean run.

## Shared conventions

Every `ledger` verb obeys these; stated once.

- **Answer channel: machine.** Stdout carries the answer only — one JSON object with named keys.
  Scope lines, refusal reasons and notices go to stderr. **A non-zero exit prints nothing on
  stdout** (`src/verb.ts`: `refuse()` hardcodes an empty stdout, `answer()` hardcodes code `0`).
  **The positive answer is always a positive token** — a dedup read that found nothing prints
  `"outcome":"none"`, never empty stdout, because v1's dedup made "no duplicates" and "refused to
  run" byte-identical on stdout while exiting `0` for both.
- **A proven verdict is a state word at exit `0`.** Where a verb's answer has arms, both exit `0`
  and the discriminator is on stdout, per interface convention rule 3's pipe clause. Guards sit at
  the **write**, never at a caller's reading of a prior exit code.
- **A 404 is a verdict; anything else is UNKNOWN.** Absence is decided by the HTTP status the API
  returned via `httpStatusOf`, never by matching text against `gh`'s stderr. No message in this
  contract is worded "does not exist, or is not readable".
- **A flag whose absence must be a *semantic* refusal is optional at the parser and refused in the
  verb body.** A parser-required flag's absence is exit `1`, indistinguishable from a typo
  (`triage/command.ts:78-85` is the shipped precedent). `--ready-for` on `ledger child` is the one
  case here: its absence is a decision nobody made (#4780), which must be provable as `10`, not
  guessable as a typo. **This does not apply to `--body-digest`, `--child` or `--title`**, whose
  absence is an ordinary usage error with no semantic content — those stay parser-required, and
  their fail-open risk is a *wrong* value, which is `21` and `10` respectively, not a missing one.
- **Stdin is read through the imported `io/stdin.ts` three-way `Text` / `NoStdin` / `Failed`.**
  `Failed` is `1` ("the input is UNKNOWN, never empty"); `NoStdin` and an all-whitespace `Text`
  are `3`. The two must never collapse: a non-blocking pipe throws `EAGAIN` before its producer
  writes, and swallowing that to `""` makes an unread pipe byte-identical to an empty one.
- **The run directory is keyed on the claim nonce, never the session.** `runKey(epic, nonce)` →
  `<worktreeRoot>/.fabrika-plan/<epic>-<nonce>/`. Every sibling subagent of one session shares
  `CLAUDE_CODE_SESSION_ID` (measured, #4500), so a session-keyed namespace collapses exactly the
  isolation two parallel planning lanes need (#4516, #4544). Every file inside it is named for what
  it holds — no fixed leaf shared across runs. The shipped precedents are
  `build/scratch-verb.ts:33` and `epic/ledger.ts:182-199`.
  **It is kept out of git the way `epic` already does it** — `ledger open` appends the literal line
  `.fabrika-plan/` to `.git/info/exclude` if absent (`epic/ledger.ts:199`'s `EXCLUDE_ENTRY` shape).
  That file is per-worktree and untracked, so the exclusion never enters a diff and never fights a
  `--require-clean` check.

- **The run directory holds four files, and they are the reason nothing is remembered:**

  | File | Written by | Read by |
  |---|---|---|
  | `run.json` — `{"epic","run","mode","cycleDoc","bodyDigest"}` | `ledger open` | `draft`, `child`, `topology`, `write`, `supersede` |

  **`bodyDigest` on `run.json` is a record, never an input.** `draft` and `write` compare the live
  body against the `--digest` **flag** and nothing else; a verb that fell back to the recorded value
  when the flag was absent would compare the plan against itself and make the moved-epic check
  vacuous. The field is there so a successor reading the directory can see what scope the run was
  opened over.
  | `plan.md` | `ledger draft` | `write` |
  | `topology.md` | `ledger topology` | `write` |
  | `children.jsonl` — one line per child | **seeded by `ledger open`** with the epic's existing children, appended to by `ledger child` | `topology`, `supersede` |

  `mode` and `cycleDoc` are decided **once**, by `ledger open`, and every later verb reads them from
  `run.json` rather than being told. A verb that re-derived `mode` from a live body could disagree
  with the `open` that named the run, and a `cycleDoc` carried in the model's head is the deferral
  the completeness test forbids. A `run.json` that is absent or unparseable is `11` — the run is
  UNKNOWN, never assumed `fresh`.
- **Common inputs.** `--repo <owner/name>` (default: `resolveRepo`'s precedence — `--repo`,
  `$CLAUDE_PIPELINE_REPO`, `$GITHUB_REPOSITORY`, then the `origin` remote) on every verb. That
  variable name is **inherited from the shipped `io/issues.ts`**, not minted here. GitHub access
  per [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql),
  paginated in full — v1's idempotency read used `per_page=100` with no `--paginate`, so in any
  repo past a hundred open issues its duplicate check was mostly blind and failed by re-minting.
- **Bounded fan-out, where there is any.** Only `ledger open` fans out — it reads every existing
  child of the epic — and it does so at concurrency **8**, never `"unbounded"`; a rate-limit
  response must not abort the whole read, which is how v1's sixty-child epic failed. **No other verb fans out over a
  set**, so no other verb needs the rule: `child` mints one child, `supersede` retires one child
  (touching the epic only to unlink it), and `topology` writes nothing at all — it reads the epic
  once for the shared preconditions and derives everything else from the manifest. There is deliberately no
  partial-batch reporting anywhere in this group — a non-zero exit prints nothing on stdout, so a
  verb that half-succeeded across N children could not tell its caller which N, and the design
  answer is not to write such a verb.
- **Preconditions.** Every verb runs `resolveTargetRepo`, refuses a non-`type:epic` target on
  `10`, resolves the run directory (`12` when this process is not in a linked worktree), and runs
  the imported `requireClaim` on the **epic** number (`15`). Every verb's `7` means **zero scope**;
  for five of the six that is the epic proven absent (404) or closed, and `ledger topology` adds one
  documented arm — an empty run manifest — stated in its own table with its reason.
  **`13` is not this group's.** `--require-clean` belongs to `fabrika build tree`, called once at
  the skill's step 1; no `ledger` verb declares that flag, so none can seat the code. It is carried
  in the matrix below only as a reserved seat with `build`'s meaning.
- **Every mutation is proven by a re-read**, never from the write response. v1 printed a link's
  `sub_issues_summary` out of the POST response and verified nothing.
- **Error-message prefix** is the invoked verb's name, contract-wide.
- **A non-zero exit is UNKNOWN** to the caller until the code is read.

### The shared exit matrix

This matrix owns `code → meaning`; the per-verb tables enumerate only that verb's own reachable
proven outcomes with triggers. `0`, `1`, `126`, `127` are the interface convention's reserved codes
(`src/verb.ts`, the exit-2 bootstrap in `src/bin.ts`), stated **only here**; every verb can return
them.

**Alignment.** `3`–`11` are `report`'s seats, re-exported from `src/build/codes.ts`, which is where
they are imported from `src/report/codes.ts` (under a `REPORT_`-prefixed alias there, and
re-exported unprefixed — `epic/codes.ts:22-40` and `plan/codes.ts:36-47` are the shape to copy).
The group registers **`BUILD_SEATS`** in `ALIGNED_GROUPS` (`src/exit-code-alignment.ts`) — *not*
`SHARED_SEATS`, which omits `BAD_SECTIONS`; three verbs here seat `4`, so under `SHARED_SEATS` the
checker would report `4` as a private code colliding with the base. `build`, `epic` and `plan`
claim all nine that way; `review`, `ship` and `triage` take `SHARED_SEATS` and leave `4` a
deliberate gap. **`12` and `15` are re-exported from `build` verbatim**, because this group asserts
the identical facts (this process is in a linked worktree; this session holds this issue's claim)
and a caller driving both in one sweep must read one meaning for each.

**The re-export is selective and stops at `19`.** `13`, `14`, `16`, `17`, `18` and `19` come across
carrying `build`'s meanings and are **never reached here** — this skill declares no
`--require-clean` flag, holds no lane branch, pushes nothing, runs no validation, and derives no
readiness verdict — but carrying them keeps those seats occupied so a later verb here cannot
re-seat one. **`build`'s `20` and `21` are deliberately NOT re-exported**: this group allocates its
own `20`–`25`, and re-exporting `OUT_OF_FOCUS`/`AUDIENCE_NOT_AGENT` alongside them would put two
names on one code in one module, which `allocatedCodes` (`exit-code-alignment.ts:96-105`) reports
as drift.

The rule this group follows, taken from `plan/codes.ts:30-31` rather than re-derived: **import a
code when two groups prove the same fact; allocate freely when they do not.** `20`–`25` below
overlap `build`'s, `epic`'s and `plan`'s private bands and that is correct — none of those groups
can prove a fact about a *plan being authored*, an exit code is read off the command that produced
it, and the alignment checker is base-only by design (`occupied = allocatedCodes(base)`).

| Code | Meaning | `open` | `draft` | `child` | `topology` | `write` | `supersede` |
|---|---|---|---|---|---|---|---|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, or the verb failed to run | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `126` | no implementation could be resolved (`src/bin.ts`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `3` | stdin was read and held nothing | — | ✓ | ✓ | ✓ | — | — |
| `4` | an authored document's required section or field is missing, duplicated, or mis-numbered | — | ✓ | ✓ | ✓ | — | — |
| `5` | the **authored** text carries a machine-local path | — | ✓ | ✓ | — | — | ✓ |
| `6` | the authored text is a bare `@` path reference — not redactable | — | ✓ | ✓ | — | — | ✓ |
| `7` | zero scope: the epic is proven absent (404) or closed — and, for `topology` alone, an empty run manifest | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN | — | — | ✓ | — | ✓ | ✓ |
| `9` | the write landed but the read-back does not match | — | — | ✓ | — | ✓ | ✓ |
| `10` | a value off its closed vocabulary — a semantic refusal, never a malformed-flag usage error | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `11` | a required read failed — nothing was written, no outcome is proven | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `12` | proven: this process is not in a linked worktree (imported from `build`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `13` | proven: the tree was dirty at a `--require-clean` open (`build`'s meaning, reserved — no `ledger` verb declares that flag) | — | — | — | — | — | — |
| `15` | proven: this session does not hold the epic's claim (imported from `build`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `20` | proven: the worktree's base is behind `origin/main` | ✓ | — | — | — | — | — |
| `21` | proven: the epic body moved — the recomputed digest differs from `--body-digest` | — | ✓ | — | — | ✓ | — |
| `22` | proven: the plan region is unresolvable — a duplicated anchor, or a mode the body contradicts | ✓ | — | — | — | ✓ | — |
| `23` | proven: the child was created and its sub-issue link could not be proven | — | — | ✓ | — | — | — |
| `24` | proven: the declared topology is invalid — a cycle, a dangling ref, or an unplaced child | — | — | — | ✓ | — | — |
| `25` | proven: a document this verb must splice was never staged in this run | — | — | — | — | ✓ | — |
| `26` | proven: a child was created and the run manifest could not record it | — | — | ✓ | — | — | — |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

`13` is seated by **no** `ledger` verb. `--require-clean` is `fabrika build tree`'s flag, asserted
once at the skill's step 1, and the whole group inherits that ground rather than re-testing a tree
it never writes to. `14`, `16`, `17`, `18` and
`19` stay reserved with `build`'s meanings and are unreachable here, each for the same reason —
this skill cuts no branch, pushes nothing, and has no validation surface.

**`7` versus `11` versus `20`:** a 404 or a closed epic is a fact about the repository (`7`); an
unreachable GitHub or an unreadable probe is a fact about nothing (`11`); a base that is provably
behind `origin/main` is a fact about the checkout (`20`). A freshness probe that *fails* is `11`,
never `20` — "I could not tell" is not "it is stale", and it is certainly not "it is fresh".

**`8` versus `9` versus `23`:** `8` is a write whose outcome is unknown; `9` is a write that landed
and read back wrong; `23` is narrower and more useful than either — the create is **proven** and
the *link* is unknown, so a named child exists unlinked. Fusing `23` into `8` would leave a
successor unable to tell "something may exist" from "#4302 exists and needs linking", which are
opposite repairs.

---

## `ledger open`

**Invocation**

```
fabrika ledger open 4300 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic being planned |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository read |

**Output** — machine. One JSON object:

```
{"answer": "opened", "epic": 4300, "run": "4300-7f31a2", "mode": "fresh",
 "bodyDigest": "8f2c1a90b4d7", "dir": "/w/.fabrika-plan/4300-7f31a2",
 "children": [], "cycleDoc": "present",
 "candidates": {"outcome": "candidates", "items": [{"number": 4180, "title": "queue view for reports", "score": 3}]}}
```

`mode` is closed: `fresh` (the body carries no `## Plan (plan-epic)` heading) or `re-plan`
(exactly one). Two or more is `22` — the mode cannot be decided, and guessing is what corrupted
epics in v1. `children` lists the epic's existing sub-issues with their numbers, titles and
labels; on a `fresh` run it is normally empty and a non-empty one is a fact the skill must read,
not an error. `cycleDoc` is `present` / `absent` / `unknown` and decides whether
`**Containment:**` is required. `candidates` is the imported dedup ranker over the open backlog,
and its `outcome` is three-valued — `candidates`, `none`, `indeterminate` — so "nothing overlaps"
never reads the same as "the search index could not be reached".

The run directory is created here and nowhere else; every later verb resolves it from
`runKey(epic, nonce)` and refuses on `11` if it is gone.

**`ledger open` seeds `children.jsonl` with the epic's existing children**, one line each, carrying
`"linked":true` and `"mintedThisRun":false`; `ledger child` appends newly minted ones with
`"mintedThisRun":true`. The manifest is therefore **the epic's whole child set**, not this run's
additions — which is what makes `ledger topology` correct on a `re-plan`. Without the seed, a
re-plan's retained children are invisible to the topology check: naming one is a dangling ref
(`24`) and omitting it stages cleanly and is then `ORPHAN_CHILD` at the gate, with no third option
and no verb to record it. That is a planner writing a ledger its own gate rejects.

**A re-open of an existing run directory is a resume, not a reset.** `runKey` is derived from the
claim nonce, which a re-open does not change, so `ledger open` finds the previous attempt's files.
It **re-seeds `children.jsonl` from the live sub-issue list** (so a child minted before the
interruption is present exactly once, with its observed `linked` state) and **leaves `plan.md` and
`topology.md` untouched** — re-staging either is `ledger draft`'s and `ledger topology`'s job, and
silently discarding a staged document a caller has not replaced would lose authored work with no
refusal to notice.

**Freshness.** The verb resolves `origin/main` and compares the worktree's merge base. Provably
behind is `20`. A fetch or rev-parse that fails is `11`. There is no third arm: this verb never
answers "fresh" without having proven it, because the whole point is that v1 planned against
stale checkouts and minted phantom children (#3330), and the repo has no post-merge sync with any
call site (#4167) — so the tree is stale by default until shown otherwise.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the epic is proven absent (404) or closed |
| `10` | the issue is not a `type:epic` |
| `11` | the epic, its sub-issue list, the backlog read, the cycle-doc probe, or the freshness probe could not be read |
| `12` | this process is not in a linked worktree |
| `15` | this session does not hold the epic's claim |
| `20` | the worktree's base is proven behind `origin/main` |
| `22` | the body carries two or more `## Plan (plan-epic)` headings — the run's mode cannot be decided |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ledger open: issue #<n> is proven absent or closed.` | 7 | refusal |
| `ledger open: #<n> is not a type:epic — refusing to plan it.` | 10 | refusal |
| `ledger open: cannot read <what>: <reason> — the ground is UNKNOWN.` | 11 | refusal |
| `ledger open: not in a linked worktree — refusing to plan from the primary checkout (#4934).` | 12 | refusal |
| `ledger open: this session does not hold #<n>'s claim.` | 15 | refusal |
| `ledger open: base is <k> commit(s) behind origin/main — a plan derived here is derived on stale ground (#3330).` | 20 | refusal |
| `ledger open: #<n>'s body carries <k> "## Plan (plan-epic)" headings — the plan mode has no single meaning.` | 22 | refusal |

**Scope** — one epic, its sub-issue children, the open backlog for the dedup rank, one repo-file
probe, one git freshness probe. The stderr `scannedLine` names the child set and the backlog size
the rank was taken over. **Zero backlog results is a fact, not a failure** — this verb only
*supplies* the candidate list; a repository with no other open issues genuinely has no duplicates,
which is why `outcome: "none"` is an answer and only an unreachable index is `indeterminate`.

**Examples**

```
$ fabrika ledger open 4300
{"answer":"opened","epic":4300,"run":"4300-7f31a2","mode":"fresh","bodyDigest":"8f2c1a90b4d7","dir":"/w/.fabrika-plan/4300-7f31a2","children":[],"cycleDoc":"present","candidates":{"outcome":"none","items":[]}}
```

```
$ fabrika ledger open 4300
ledger open: base is 47 commit(s) behind origin/main — a plan derived here is derived on stale ground (#3330).
$ echo $?
20
```

**Grounding**

- #3330 / #4167 — a stale checkout inflated a baseline and spawned phantom children; `main-sync
  --post-merge` has no call site, so freshness is proven here rather than assumed.
- #4934 — one worktree per epic; the primary checkout is refused rather than silently used.
- #4516 / #4544 / #4500 — the run key is the claim nonce; sibling subagents share the session id,
  so a session-keyed namespace is not a namespace.
- v1 scar (`idempotency-sets.sh:27,33`) — `per_page=100` with no `--paginate` made the duplicate
  read blind past a hundred issues; this verb paginates in full and states its scope.
- v1 scar (`intake-dedup/command.ts:55`) — the no-keywords refusal printed to stderr and exited
  `0` with empty stdout, so "no duplicates" and "never ran" were the same bytes. The three-valued
  `outcome` is that hole closed.

---

## `ledger draft`

**Invocation**

```
fabrika ledger draft 4300 --body-digest 8f2c1a90b4d7 <<'EOF'
## Plan (plan-epic)

### Summary
...
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose plan is staged |
| `--body-digest` | string, 12 lowercase hex | yes | — | the digest `ledger open` printed; the draft refuses if the epic body has moved since |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository read |
| stdin | markdown | yes | — | the plan block, opening with `## Plan (plan-epic)` |

**Output** — machine.
`{"answer": "staged", "epic": 4300, "document": "plan", "sections": 10, "stories": [1,2,3], "bytes": 4187}`

The verb checks the closed section set (each of the ten `###` headings present exactly once, in
order), that the block opens with `## Plan (plan-epic)`, and that `### User stories` parses through
the imported `readEpicStories` to a contiguous id run from 1. It leak-scans the text, because the
block reaches a public issue body. It **does not judge content** — a `### Approach` reading "TBD"
stages cleanly, and catching that is the skill's job, not a verb's.

**A plan declaring zero stories is a `4`, refused here rather than discovered at the gate.** The
downstream floor treats an absent or empty story list as the defect `MISSING_STORIES_SECTION`, so
staging one would mean authoring a ledger this skill's own gate is guaranteed to reject — the
"planner writing a plan its gate rejects" failure this group exists to prevent. The trap it closes
is specific: `readEpicStories` collects ids only from ordered-list rows, so a `### User stories`
section full of `-` bullets or `S1`-style labels parses as **zero stories** while looking complete
to its author. That is the case the refusal is really for; a genuinely empty section is the easy
half.

Staged at `<dir>/plan.md`. Re-running replaces it; the last staged document is what `ledger write`
splices.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing |
| `4` | a required `###` section is missing, duplicated or out of order; the block does not open with `## Plan (plan-epic)`; the plan declares zero user stories; or the story ids are not contiguous from 1 |
| `5` | the plan text carries a machine-local path |
| `6` | the plan text is a bare `@` path reference |
| `7` | the epic is proven absent or closed |
| `10` | the issue is not a `type:epic`, or `--body-digest` is not 12 lowercase hex |
| `11` | the epic body or the run directory could not be read |
| `12` | this process is not in a linked worktree |
| `15` | this session does not hold the epic's claim |
| `21` | the recomputed body digest differs from `--body-digest` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ledger draft: stdin held nothing — there is no plan to stage.` | 3 | refusal |
| `ledger draft: the plan block is missing section(s): <list>.` | 4 | refusal |
| `ledger draft: the plan block carries <k> "<heading>" sections — a plan with two of one section has no single meaning.` | 4 | refusal |
| `ledger draft: the plan block's sections are out of order: "<current>" appears after "<previous>".` | 4 | refusal |
| `ledger draft: the plan block does not open with "## Plan (plan-epic)".` | 4 | refusal |
| `ledger draft: user stories are numbered <list> — a story list must run from 1 with no gaps or repeats.` | 4 | refusal |
| `ledger draft: the plan declares zero user stories — an ordered list is what carries them, and a bullet or an "S<n>" label parses as none.` | 4 | refusal |
| `ledger draft: the plan text carries a machine-local path (<masked>).` | 5 | refusal |
| `ledger draft: the plan text carries a bare @ path reference — it cannot be redacted.` | 6 | refusal |
| `ledger draft: issue #<n> is proven absent or closed.` | 7 | refusal |
| `ledger draft: --body-digest must be 12 lowercase hex — got "<v>".` | 10 | refusal |
| `ledger draft: #<n> is not a type:epic — refusing to stage a plan for it.` | 10 | refusal |
| `ledger draft: cannot read <what>: <reason> — nothing was staged.` | 11 | refusal |
| `ledger draft: not in a linked worktree — the run directory is unreachable.` | 12 | refusal |
| `ledger draft: this session does not hold #<n>'s claim.` | 15 | refusal |
| `ledger draft: the epic body moved since open (digest <a> → <b>) — re-open before staging.` | 21 | refusal |

**Scope** — one document on stdin and one epic body read. Zero scope is unreachable: stdin is
required, and an empty one is `3`.

**Examples**

```
$ fabrika ledger draft 4300 --body-digest 8f2c1a90b4d7 < plan.md
{"answer":"staged","epic":4300,"document":"plan","sections":10,"stories":[1,2,3],"bytes":4187}
```

```
$ fabrika ledger draft 4300 --body-digest 8f2c1a90b4d7 < plan.md
ledger draft: user stories are numbered 1, 2, 4 — a story list must run from 1 with no gaps or repeats.
$ echo $?
4
```

**Grounding**

- v1 scar (`epic-ledger/markdown.ts:47`) — story ids are ordered-list *positions*; an unordered
  or `S<n>` bullet parses as zero stories and the epic reads as declaring none. Refused here at
  authoring time rather than discovered at the gate.
- v1 scar — the plan's section set lived only in prose, so drift produced a `Corrupt` splice
  refusal much later with no statement of which section was wrong.
- `report/leaks.ts` — the plan is model-authored prose reaching a public surface, which is the
  seat `5` / `6` exist for.

---

## `ledger child`

**Invocation**

```
fabrika ledger child 4300 --title "queue view: fate loader" --type type:feature --priority p1 --ready-for agent [--assignee <login>] [--milestone <title>] [--label <name>]… <<'EOF'
**Stories:** 1, 2
**TDD:** yes
**Containment:** flag (default-off)

### What to build
...

### Acceptance criteria
- [ ] the queue view renders the ten most recent reports
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the parent epic |
| `--title` | string | yes | — | the child's title; carries no type or priority prefix |
| `--type` | string, one of `type:bug`/`type:feature`/`type:chore`/`type:decision`/`type:investigation` | yes | — | the child's type label |
| `--priority` | string, one of `p0`/`p1`/`p2` | yes | — | the child's priority label; `p3` is retired, not admitted |
| `--ready-for` | string, one of `human`/`agent` | **optional at the parser, refused in the body** | none | the child's audience; an absent value is refused on `10`, never defaulted |
| `--assignee` | string (login) | no | none | required when `--ready-for human`; born-assignment is the enforced hold |
| `--milestone` | string (open milestone title) | no | none | the child's home; absent mints an unhomed child the repo's homing guard will red |
| `--label` | string, repeatable | no | none | any further label, applied in the same create call |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository written |
| stdin | markdown | yes | — | the child body's fields and sections |

**Output** — machine, the **observed** result:

```
{"answer": "minted", "epic": 4300, "child": 4301, "linked": true,
 "observed": {"labels": ["p1","ready-for:agent","status:planned","type:feature"], "assignees": [], "milestone": "fabrika campaign"},
 "stories": [1,2], "containment": "flag"}
```

**Every birth attribute lands in the one `POST /issues` call** — `title`, `body`, every label
(`--type`, `--priority`, `status:planned`, `ready-for:<v>`, each `--label`), `milestone` and
`assignees`. This is the whole reason the verb exists: v1's create hardcoded exactly three
`labels[]` with no pass-through and set no milestone, so a fourth required label could only be
applied by a follow-up PATCH — and a follow-up PATCH opens a window in which the child exists with
**no** `ready-for:` value, which is the fail-open shape the ruling forbids, where an absent label
reads as a permissive default rather than an unknown. v1's own sibling script knows the hazard by
name and warns that patching a fresh child "reopens the label-less-orphan window".

**`--ready-for` is required and has no default** (#4780): a child must never inherit its audience
by omission. **`--ready-for human` requires `--assignee`** (#4693): the label is the routing
signal, born-assignment is the enforced hold, and neither substitutes for the other — a label
without assignment has no teeth, an assignment without the label hides the intent from queries.
This is not merely a convention: the gate's floor reds `HELD_CHILD_UNASSIGNED` over the **whole
epic**, so one held-and-unassigned child blocks every sibling.

Order of operations, each guard against a named v1 failure. **The manifest append sits before the
link, deliberately** — see step 5.

1. **Read `run.json`** for `cycleDoc` and the epic's identity. Absent or unparseable is `11`.
2. **Compose and validate the body.** Fields through the imported `readChildStories` /
   `readContainment`, criteria through the imported acceptance-criteria reader — the same readers
   the gate uses, so a body that composes here cannot fail the gate on grammar. A `Malformed` or
   zero-criteria read is `4`. `**Containment:**` is emitted **only** when `run.json`'s `cycleDoc` is
   `present`; a `type:feature` child whose containment is missing, unset **or `none`** while `cycleDoc` is
   `present` is `4` — the gate's `MISSING_CONTAINMENT` treats `none` exactly as unset, so admitting
   it here would author a defect the floor then reds.
3. **Vocabulary precondition.** Confirm every label and the milestone exist in the repository.
   `POST .../labels` **creates** an unknown label rather than rejecting it (#4285), and a closed
   milestone is off-vocabulary; refuse on `10` rather than minting taxonomy.
4. **Leak-scan** the composed body (`5` / `6`).
5. **Create,** with every attribute, in one `POST /repos/{repo}/issues` — `title`, `body`,
   `labels[]` (every one), `milestone` (the number resolved from the title in step 3), `assignees[]`.
   **The moment the create returns a number, append it to `<dir>/children.jsonl`** —
   `{"number","id","title","type","priority","readyFor","stories","containment","linked":false}` —
   **`id` is the database id the create response carries, and it is recorded because the sub-issue
   link and unlink both take it rather than the number**; without it on the manifest, `supersede`
   and any later link retry would have to re-read GitHub to find a value the run already held — and
   only then attempt the link. The ordering is load-bearing and it is what makes `23` survivable:
   a child recorded before its link is a child a successor can **find and name**, which is the whole
   of what the record buys — and it is enough, because the alternative is an issue that exists on
   GitHub and appears in no artifact this run produced. It is deliberately **not** placeable or
   retirable while unlinked: `topology` would render it as a ref that is not a linked child
   (`DANGLING_DEP` at the gate) and `supersede` refuses a non-sub-issue on `10`. The orphan needs a
   human to link it, and the manifest is how that human learns its number. Under the reverse order a `23` leaves an issue that exists on GitHub, is absent from
   the manifest, and can therefore be neither placed (`24`, dangling) nor retired (`10`, not a
   sub-issue) — created, unusable, and unreachable by every other verb in the group.
6. **Link** as a native sub-issue: `POST /repos/{repo}/issues/{epic}/sub_issues` with body
   `{"sub_issue_id": <the child's `id`, not its `number`>}`. The `id` is the database id the create
   response carries; the sub-issue API takes that and not the number, which is the one shape v1 got
   right and is worth not rediscovering. A create that landed and a link that cannot be proven is
   `23`. **No shipped module writes a sub-issue link** — `plan/github.ts:43`'s `listSubIssues` is
   the read half and is the sibling to model this on; the write is genuinely new.
7. **Re-read the child**, confirm the link by re-listing the epic's sub-issues, then rewrite that
   child's manifest line with `"linked":true` and report the observed labels, assignees and
   milestone — never the create response. v1 printed a link's summary straight out of the POST
   response and verified nothing.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing |
| `4` | the composed body's fields or sections do not parse: a field line present more than once, a malformed `**Stories:**` value, an absent or malformed `### Acceptance criteria`, zero criteria, or a `type:feature` child whose `**Containment:**` is missing, unset or `none` while `cycleDoc` is `present` |
| `5` | the composed body carries a machine-local path |
| `6` | the composed body is a bare `@` path reference |
| `7` | the epic is proven absent or closed |
| `8` | the create was attempted and no re-read could prove its outcome — UNKNOWN |
| `9` | the child was created and the re-read does not match what was sent |
| `10` | a label, `--type`, `--priority`, `--milestone` or `--ready-for` value off its closed vocabulary; `--ready-for` absent; `--ready-for human` without `--assignee`; or the issue is not a `type:epic` |
| `11` | a precondition read failed — **nothing was created** |
| `12` | this process is not in a linked worktree |
| `15` | this session does not hold the epic's claim |
| `23` | the child was created and its sub-issue link could not be proven |
| `26` | the child was created and the run manifest could not be written — the child exists and this run has no record of it |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ledger child: stdin held nothing — there is no child body to compose.` | 3 | refusal |
| `ledger child: **<field>:** appears <k> times — a child field line has one value, and the gate refuses a duplicate.` | 4 | refusal |
| `ledger child: **Stories:** value does not conform: "<v>" — bare integers or "none".` | 4 | refusal |
| `ledger child: acceptance criteria read as <absent\|malformed> — a child with no checkable criteria is not buildable.` | 4 | refusal |
| `ledger child: type:feature child needs **Containment:** flag or exempt — got "<v>", and the cycle doc is present.` | 4 | refusal |
| `ledger child: the child body carries a machine-local path (<masked>).` | 5 | refusal |
| `ledger child: the child body carries a bare @ path reference — it cannot be redacted.` | 6 | refusal |
| `ledger child: issue #<n> is proven absent or closed.` | 7 | refusal |
| `ledger child: created #<c> and could not re-read it — the outcome is UNKNOWN.` | 8 | refusal |
| `ledger child: created #<c> and it does not read back as sent — it needs a human eye.` | 9 | refusal |
| `ledger child: --ready-for is required — a child must never inherit its audience by omission (#4780).` | 10 | refusal |
| `ledger child: --ready-for human requires --assignee — a held child is born assigned (#4693).` | 10 | refusal |
| `ledger child: label "<name>" is absent from <repo>'s taxonomy — refusing to create it (#4285).` | 10 | refusal |
| `ledger child: milestone "<title>" is not an open milestone of <repo>.` | 10 | refusal |
| `ledger child: --priority <v> is off the closed set (p0, p1, p2).` | 10 | refusal |
| `ledger child: cannot read <what>: <reason> — nothing was created.` | 11 | refusal |
| `ledger child: not in a linked worktree — the run manifest is unreachable.` | 12 | refusal |
| `ledger child: this session does not hold #<n>'s claim.` | 15 | refusal |
| `ledger child: created #<c> and could not prove the sub-issue link — the child exists, is recorded in the run manifest as linked:false, and is unlinked on GitHub.` | 23 | refusal |
| `ledger child: created #<c> and could not write the run manifest: <reason> — the child exists and this run holds no record of it.` | 26 | refusal |

**Scope** — one child created, one link written, one child re-read; the repository's label list and
open milestones read as preconditions. The stderr `scannedLine` names the label set checked. Zero
scope is unreachable: the verb writes exactly one child or refuses.

**Examples**

```
$ fabrika ledger child 4300 --title "queue view: fate loader" --type type:feature --priority p1 --ready-for agent --milestone "fabrika campaign" < child.md
{"answer":"minted","epic":4300,"child":4301,"linked":true,"observed":{"labels":["p1","ready-for:agent","status:planned","type:feature"],"assignees":[],"milestone":"fabrika campaign"},"stories":[1,2],"containment":"flag"}
```

```
$ fabrika ledger child 4300 --title "moderation queue triage rules" --type type:feature --priority p1 --ready-for human < child.md
ledger child: --ready-for human requires --assignee — a held child is born assigned (#4693).
$ echo $?
10
```

**Grounding**

- #4780 — every child carries exactly one `ready-for:` value, set explicitly at creation and never
  inherited by omission.
- #4693 (founder ruling, 2026-08-09) — COMPOSE: the label is the routing signal, born-assignment is
  the enforced hold; neither substitutes for the other. The gate's `HELD_CHILD_UNASSIGNED` is the
  enforcement, and it fails the whole epic.
- v1 scar (`create-child.sh:48-55`) — three hardcoded `labels[]`, no pass-through, no milestone, so
  the create was not atomic over the child's birth attributes despite its own docblock's claim.
- v1 scar (`amend-child-labels.sh:2-4,18-19`) — the amend endpoint is additive, so "adjust" could
  only add, and it force-re-added `status:planned` to a child the gate may already have flipped.
- v1 scar (`link-child.sh:22-24`) — the link was reported from the POST response and verified
  nowhere; `confirm-links.sh` was a separate manual step whose only assertion was a comment.
- #4285 — `POST .../labels` creates unknown labels; the vocabulary check is a precondition.
- #4101 / #2413 — the priority set is `{p0,p1,p2}`; `p3` is retired, not admitted.

---

## `ledger topology`

**Invocation**

```
fabrika ledger topology 4300 <<'EOF'
#4301 phase 1
#4302 phase 1
#4303 phase 2 requires #4301
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose topology is declared |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository read |
| stdin | line grammar | yes | — | one line per child: `#<ref> phase <n> [requires #<a>[, #<b>]…]` |

**Output** — machine.

```
{"answer": "staged", "epic": 4300, "document": "topology", "phases": 2, "children": 3,
 "edges": [["#4303","#4301"]], "bytes": 214}
```

Lines are order-indifferent. **Every child in the run manifest appears exactly once — and the
manifest is the epic's whole child set, retained children included**, which is what makes a
`re-plan` placeable; a manifest
child with no line is an unplaced child and a line naming a number that is not in the manifest is
a dangling reference — both `24`. Edges are ordered `[dependent, prerequisite]`:
`["#4303","#4301"]` reads *#4303 requires #4301*.

The verb renders the `## Dependencies` block into `<dir>/topology.md` and then **parses its own
output back through the imported `readTopology`**, refusing on `24` if the round trip does not
reproduce the declared edge set. That check is the reason this verb composes rather than the skill:
a block that the gate's parser reads differently from how its author meant it is exactly the class
of defect nobody notices until a build runs in the wrong order.

**A cycle is `24`**, walked transitively and reported as the member set. **This verb cannot see a
shared-file conflict** — whether two children in one phase write the same module is a judgment the
skill carries (#3709), and the verb does not pretend otherwise.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing |
| `4` | a stdin line does not match the declared grammar |
| `7` | zero scope: the epic is proven absent or closed, **or the run manifest holds zero children** |
| `10` | the issue is not a `type:epic`, or a phase number is not a positive integer |
| `11` | the run manifest or the epic could not be read |
| `12` | this process is not in a linked worktree |
| `15` | this session does not hold the epic's claim |
| `24` | the topology is proven invalid: a cycle, a reference to a non-child, a manifest child placed nowhere, or a rendered block that does not parse back to the declared edges |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ledger topology: stdin held nothing — there is no topology to declare.` | 3 | refusal |
| `ledger topology: line <l> does not parse: "<text>" — want "#<ref> phase <n> [requires #<a>]".` | 4 | refusal |
| `ledger topology: cycle: #<a> → #<b> → #<a>` | 24 | refusal |
| `ledger topology: #<n> is referenced but is not a child of #<e>.` | 24 | refusal |
| `ledger topology: child #<n> is placed in no phase.` | 24 | refusal |
| `ledger topology: #<n> is declared <k> times — a child sits in exactly one phase.` | 24 | refusal |
| `ledger topology: the rendered block does not parse back to the declared edges — refusing to stage it.` | 24 | refusal |
| `ledger topology: issue #<n> is proven absent or closed.` | 7 | refusal |
| `ledger topology: the run manifest holds zero children — refusing to render a topology over zero scope (ADR 0092).` | 7 | refusal |
| `ledger topology: #<n> is not a type:epic — refusing to declare a topology for it.` | 10 | refusal |
| `ledger topology: phase "<v>" is not a positive integer.` | 10 | refusal |
| `ledger topology: cannot read <what>: <reason> — nothing was staged.` | 11 | refusal |
| `ledger topology: not in a linked worktree — the run manifest is unreachable.` | 12 | refusal |
| `ledger topology: this session does not hold #<n>'s claim.` | 15 | refusal |

**Scope** — the run manifest's whole child set and every declared line, plus one read of the epic for the shared preconditions. It writes nothing. **Zero scope reds on `7`**:
an empty manifest means the epic has no children at all — none retained by the seed and none minted since — and rendering a topology over no children
would produce a `## Dependencies` block the gate reads as an epic every one of whose children is
orphaned. It is `7` rather than `24` because nothing was validated — a refused scope is not an
invalid topology, the same split `plan check` makes when it seats a childless epic on `7` instead
of calling it defect number one (ADR 0092).

**Examples**

```
$ fabrika ledger topology 4300 < topo.txt
{"answer":"staged","epic":4300,"document":"topology","phases":2,"children":3,"edges":[["#4303","#4301"]],"bytes":214}
```

```
$ fabrika ledger topology 4300 < topo.txt
ledger topology: child #4302 is placed in no phase.
$ echo $?
24
```

**Grounding**

- ADR 0092 — an empty manifest is a refused scope, never a rendered empty topology.
- #3709 — two slices sharing a central file are not parallel; the verb cannot decide that and says
  so rather than implying its verdict is complete.
- v1 had no round-trip check on the composed block at all; the first time anyone learned the
  topology parsed differently than intended was when the gate derived the wrong defects.
- `build/dependencies.ts` — the block is composed against the shipped reader, so this spec adds no
  second `## Dependencies` grammar.

---

## `ledger write`

**Invocation**

```
fabrika ledger write 4300 --body-digest 8f2c1a90b4d7
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose body is written |
| `--body-digest` | string, 12 lowercase hex | yes | — | the digest `ledger open` printed; the write refuses if the body has moved since |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository written |

**Output** — machine.

```
{"answer": "written", "epic": 4300, "mode": "fresh", "bodyDigest": "8f2c1a90b4d7",
 "newDigest": "c41b7e0a91f6", "planBytes": 4187, "topologyBytes": 214, "verified": true}
```

Order of operations:

1. **Read `run.json`** for `mode` and the epic's identity, and **require both staged documents** —
   `<dir>/plan.md` and `<dir>/topology.md`. A missing document is `25` naming it: proven, because
   its absence is a fact about this run, not a read that failed. An absent or unparseable
   `run.json` is `11`. **`mode` is never re-derived here.** It was decided once by `ledger open`,
   and a `write` that recomputed it from the live body could disagree with the `open` that named
   the run — which is precisely how the mode-mismatch arm below becomes unreachable and a
   first-time append silently overwrites a real plan.
2. **Re-read the live body and recompute the digest.** A difference is `21`; nothing is written.
   The gap between deciding and writing is closed by re-deciding, not by trusting.
3. **Resolve the plan region through the enrichment marker.** On `mode: fresh`, the body must carry
   zero `## Plan (plan-epic)` headings and the plan and topology are **appended**, the live bytes
   above them untouched. On `mode: re-plan`, exactly one of each heading must resolve, and the
   region between the `## Plan (plan-epic)` heading and the end of the `## Dependencies` block is
   replaced. Anything else is `22` and **nothing is written**: two plan headings on a `fresh` run,
   a `re-plan` whose body carries none (the anchor drifted or was deleted), or a `## Dependencies`
   heading that resolves inside the preserved brief envelope. Because `mode` is carried rather than
   inferred, "zero headings" and "`re-plan`" are independently observable and their disagreement is
   a refusal instead of a silent append.
4. **PATCH once**, then **re-read and compare**. The comparison is over the normalized body and it
   checks the *whole* result, not a re-extraction of the region — v1 truncated an epic body to
   end-of-file whenever a `## Dependencies` heading appeared inside the preserved brief, and its
   round-trip check could not see it because both sides ran the same first-occurrence extractor
   (#4879). A PATCH whose status is unreadable is `8`; a body that lands and does not match is `9`.

**The region is never cut to end-of-file.** v1's replace branch sliced from the `## Dependencies`
heading to EOF on the assumption that dependencies are the last section, destroying anything a
human had appended below with no guard at all. This verb resolves a bounded region and preserves
every byte outside it.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the epic is proven absent or closed |
| `8` | the PATCH was issued and its outcome could not be proven — UNKNOWN |
| `9` | the body was written and does not read back as composed |
| `10` | the issue is not a `type:epic`, or `--body-digest` is not 12 lowercase hex |
| `11` | the epic body or the run directory could not be read — **nothing was written** |
| `12` | this process is not in a linked worktree |
| `15` | this session does not hold the epic's claim |
| `21` | the recomputed body digest differs from `--body-digest` |
| `22` | the plan region is unresolvable: a duplicated anchor, or a mode the body contradicts |
| `25` | `plan.md` or `topology.md` was never staged in this run |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ledger write: <what>.md was never staged in this run — stage it before writing.` | 25 | refusal |
| `ledger write: the epic body moved since open (digest <a> → <b>) — re-open before writing.` | 21 | refusal |
| `ledger write: #<n>'s body carries <k> "<heading>" headings — the plan region has no single meaning.` | 22 | refusal |
| `ledger write: mode is re-plan and the body carries no "## Plan (plan-epic)" heading — the anchor drifted or was deleted.` | 22 | refusal |
| `ledger write: the PATCH was issued and could not be confirmed — the body is UNKNOWN.` | 8 | refusal |
| `ledger write: the body was written and does not read back as composed — it needs a human eye.` | 9 | refusal |
| `ledger write: --body-digest must be 12 lowercase hex — got "<v>".` | 10 | refusal |
| `ledger write: #<n> is not a type:epic — refusing to write a plan into it.` | 10 | refusal |
| `ledger write: issue #<n> is proven absent or closed.` | 7 | refusal |
| `ledger write: cannot read <what>: <reason> — nothing was written.` | 11 | refusal |
| `ledger write: not in a linked worktree — the staged documents are unreachable.` | 12 | refusal |
| `ledger write: this session does not hold #<n>'s claim.` | 15 | refusal |

**Scope** — one epic body read, one PATCH, one confirming read. Zero scope is unreachable: the
staged documents are required and their absence is `25`.

**Examples**

```
$ fabrika ledger write 4300 --body-digest 8f2c1a90b4d7
{"answer":"written","epic":4300,"mode":"fresh","bodyDigest":"8f2c1a90b4d7","newDigest":"c41b7e0a91f6","planBytes":4187,"topologyBytes":214,"verified":true}
```

```
$ fabrika ledger write 4300 --body-digest 8f2c1a90b4d7
ledger write: topology.md was never staged in this run — stage it before writing.
$ echo $?
25
```

**Grounding**

- #4866 / #4850 — detection is the whole-line enrichment marker, so position is not load-bearing
  and the plan may sit below the brief envelope. This is #4896's route, taken.
- #4879 — v1 truncated a body to EOF when a `## Dependencies` heading sat inside the preserved
  brief, and the round-trip check reused the buggy extractor so it could not see it. The bounded
  region and the whole-body comparison answer both halves.
- v1 scar (`splice-body.sh:174-175,185`) — the PATCH's exit status was never checked and the
  confirming read's failure was not either, so a rejected write, a failed read and a genuine race
  all printed "a racer clobbered it" and the terminal then fabricated a half-written diagnosis.
  `8`, `9`, `21` and `22` are those four states separated.
- v1 scar (`splice-body.sh:101`) — a `for attempt in 1 2 3` loop whose every branch broke, so the
  second attempt was unreachable while the terminal message claimed "every attempt raced". This
  verb attempts once and says so.
- #4599 — the caller's command substitution stripped trailing newlines before the PATCH, so a raw
  byte comparison could never succeed; the digest and the comparison both normalize.

---

## `ledger supersede`

**Invocation**

```
fabrika ledger supersede 4300 --child 4288 --reason "folded into the loader slice"
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the parent epic |
| `--child` | integer | yes | — | the child being retired |
| `--reason` | string | yes | — | why it is retired; posted as the journal comment |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository written |

**Output** — machine.
`{"answer": "superseded", "epic": 4300, "child": 4288, "comment": 5230661234, "unlinked": true, "state": "closed"}`

Three legs in a fixed order — **comment, unlink, close** — then a re-read proving `state` is
`closed` with `state_reason` `not_planned`. The order is load-bearing: closing before unlinking
leaves a closed issue still counted as a sub-issue, which the gate reads as a child in scope that
can never carry a live assignee (#5026 names this exact residue as undecided for pre-existing
children; this verb simply does not create more of it).

The three calls, so an implementer needs no other document:

1. `POST /repos/{repo}/issues/{child}/comments` with body
   `{"body": "Superseded by re-plan of #<epic>: <reason>."}` — the journal, posted first so the
   reason survives even if a later leg fails.
2. `DELETE /repos/{repo}/issues/{epic}/sub_issue` with body `{"sub_issue_id": <the child's `id`>}` —
   the same `id`-not-`number` shape `ledger child` uses to link. Nothing shipped performs this
   write; it is new alongside the link.
3. `PATCH /repos/{repo}/issues/{child}` with `{"state": "closed", "state_reason": "not_planned"}`.

The verb refuses a `--child` that is not a sub-issue of `<number>` (`10`), and refuses one whose
manifest line carries `"mintedThisRun":true` (`10`) — a child the current plan just minted is not
one the current plan supersedes, and letting that through is how a re-plan deletes its own work.
A **retained** child (`"mintedThisRun":false`, seeded by `ledger open`) is exactly what this verb
exists for, so the refusal narrows to the minted set rather than the whole manifest.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `5` | `--reason` carries a machine-local path |
| `6` | `--reason` is a bare `@` path reference |
| `7` | the epic or the child is proven absent or closed |
| `8` | a leg was attempted and its outcome could not be proven — UNKNOWN |
| `9` | the legs landed and the child does not read back closed and unlinked |
| `10` | the issue is not a `type:epic`; `--child` is not a sub-issue of it; or `--child`'s manifest line carries `"mintedThisRun":true` |
| `11` | a precondition read failed — **nothing was written** |
| `12` | this process is not in a linked worktree |
| `15` | this session does not hold the epic's claim |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ledger supersede: the reason carries a machine-local path (<masked>).` | 5 | refusal |
| `ledger supersede: the reason carries a bare @ path reference — it cannot be redacted.` | 6 | refusal |
| `ledger supersede: issue #<n> is proven absent or closed.` | 7 | refusal |
| `ledger supersede: wrote <k> of 3 legs on #<c> and could not prove the rest — the child is UNKNOWN.` | 8 | refusal |
| `ledger supersede: #<c> does not read back as closed and unlinked — it needs a human eye.` | 9 | refusal |
| `ledger supersede: #<c> is not a sub-issue of #<n>.` | 10 | refusal |
| `ledger supersede: #<c> was minted by this run — refusing to supersede a child of the current plan.` | 10 | refusal |
| `ledger supersede: #<n> is not a type:epic.` | 10 | refusal |
| `ledger supersede: cannot read <what>: <reason> — nothing was written.` | 11 | refusal |
| `ledger supersede: not in a linked worktree — the run manifest is unreachable.` | 12 | refusal |
| `ledger supersede: this session does not hold #<n>'s claim.` | 15 | refusal |

**Scope** — one child: one comment, one unlink, one close, one confirming read. Zero scope is
unreachable: `--child` is required.

**Examples**

```
$ fabrika ledger supersede 4300 --child 4288 --reason "folded into the loader slice"
{"answer":"superseded","epic":4300,"child":4288,"comment":5230661234,"unlinked":true,"state":"closed"}
```

```
$ fabrika ledger supersede 4300 --child 4301 --reason "no longer needed"
ledger supersede: #4301 was minted by this run — refusing to supersede a child of the current plan.
$ echo $?
10
```

**Grounding**

- v1 scar (`supersede-child.sh:28`) — the final PATCH's result was unchecked and unverified, and
  the whole issue JSON was dumped on stdout with no `--jq`, so the success channel and the failure
  channel were two shapes on one stream.
- v1 scar (`teardown-scratch-epic.sh:8-9`) — a destructive verb that "closes exactly the numbers
  you name" with no guard at all. The sub-issue check and the manifest check are that guard.
- #5026 — whether pre-existing closed or unassigned held children stay in floor scope is undecided;
  this verb does not decide it and does not add to the residue.

---

## Required repo files (verb-level)

The skill's own table ([SKILL.md](SKILL.md)) carries the run-level rows; these are the reads and
writes this contract's verbs make, so an implementer sees the dependency set in one place.
Vocabulary: **fail-loud** / **degrade** / **bootstrap** (front-door, #4952).

| Must exist | Why | When missing |
| --- | --- | --- |
| A `type:epic` issue, open | every verb's subject | **fail-loud** — exit `7` / `10` naming the gap. |
| A linked git worktree with a reachable `origin/main` | the run directory lives in it, and `ledger open` proves freshness there | **fail-loud** — `12` at any `ledger` verb, and `13` from `build tree` at step 1; an unprovable freshness read is `11`, never `20`. |
| Labels `status:planned`, `ready-for:human`, `ready-for:agent`, `type:*`, `p0`/`p1`/`p2` | every child is born carrying them | **fail-loud** — `ledger child` exits `10` rather than creating a label (#4285); taxonomy creation is the front door's. |
| At least one open milestone, or a standing-lane exemption | `--milestone` is validated against the open set | **degrade** — a child is minted unhomed; the repo's own homing guard reds it at the labelling seam. This contract computes no second answer. |
| `product-development-cycle.md` at the repo root | decides whether `**Containment:**` is required | **degrade** — *absent* means containment is not required; an *unreadable* probe is `11`. Never silently dropped. |
| The `<!-- fabrika:enriched … -->` marker on the epic body | `ledger write` resolves the plan region by it | **degrade** — a body with no marker is treated as `fresh` and the plan is appended; the marker is what makes a *re-plan* resolvable, and its absence on a re-plan is `22`. |
| Repository permissions readable | `build claim`'s ACL-sourced ownership resolution (ADR 0055) | **fail-loud** — as declared in [`build`'s contract](../build/contract.md); an unreadable permission is `Unknown`, never a demotion. |

---

## Completeness self-test

Per the [interface convention](../../docs/cli-interface-convention.md) Part 2: every flag carries a
type and default; every stdout shape has a literal example; every non-zero code is enumerated with
its trigger (the shared matrix owns each code's single meaning, the per-verb tables own the
triggers, and the universal `0`/`1`/`126`/`127` are stated exactly once); every enumerated code has
an Errors row; every judging verb states its scope and its zero-scope behavior; no clause defers to
a v1 script, another skill's prose, or the authoring session — every cross-reference is to a
**landed sibling fabrika contract or a shipped module by path**.

The three hand-checks the presence tests cannot perform:

1. **Every reachable outcome has a code or a state word.** Walked per verb, including the modes v1
   had no name for: a stale base (`20`), an epic body that moved (`21`), a plan region that cannot
   be resolved (`22`), a created-but-unlinked child (`23`), a topology that does not round-trip
   (`24`), and a write whose inputs were never staged (`25`). The deliberate non-codes are the
   dedup `outcome` and `mode`, which are **answer fields** on an exit-`0` answer because the verb
   did answer.
2. **Every example value is derivable.** The digests from §The body digest's definition (and the
   examples use different literals because they are taken over different bodies); `mode`,
   `outcome`, `answer` and `containment` from their closed sets; the edge orientation and the
   rendered block from §The ledger grammar; the child's `observed` labels from the flags that
   created them. `comment` and the child number are server-assigned and named as such.
3. **Every value a later verb needs arrives as an argument or off an artifact — nothing is
   remembered.** `--body-digest` is threaded explicitly from `open` to `draft` and `write`. The run
   directory is re-derived from `runKey(epic, nonce)` by every verb rather than passed. The child
   set reaches `ledger topology` and `ledger supersede` through `<dir>/children.jsonl`, and the
   staged documents reach `ledger write` through the run directory — so a compaction between
   minting and splicing loses nothing, which is the v1 failure this shape exists to remove.
4. **Sibling verbs guard shared preconditions identically.** All six run `resolveTargetRepo`, the
   `type:epic` check (`10`), `assertGround` (`12`), the imported `requireClaim` (`15`) and the
   same `7` trigger, with `topology`'s one documented widening of `7` (an empty run manifest)
   stated in its own table. `open` states the other divergence — it alone proves freshness (`20`) —
   with its reason: the ground is established once and inherited. `13` is seated by no verb here;
   `--require-clean` is `build tree`'s flag at the skill's step 1.
