---
id: 0308
title: A fabrika verb's output field is an answer-array or an evidence-array, and evidence collapses to counts
status: accepted
date: 2026-08-19
tags: [fabrika, pipeline, token-economics, cli]
---

# 0308 — A fabrika verb's output field is an answer-array or an evidence-array, and evidence collapses to counts

**What this decides:** every array a fabrika verb prints on the answer channel is classified once as
an **answer-array** — a skill instructs its reader to iterate the rows — or an **evidence-array** —
cited only so a short or empty answer is auditable, with no skill reading its rows by name.
Answer-arrays stay whole. Evidence-arrays collapse to a reason histogram, or to a cap-and-count where
a histogram does not fit. No flag, no second verb, per field.

## Context

An agent pays for a command's stdout on **every later turn**, not once. Measured on this repo on
2026-08-15 for [#5641](https://github.com/kamp-us/phoenix/issues/5641): one `fabrika build pick` call
printed a 21,478-byte payload of which the `excluded` array was **18,013 bytes — 84%**, roughly 5–6k
tokens. Those 266 rows carried exactly **two** distinct reasons (155 `audience-not-agent`, 111
`out-of-focus`). Across 22 measured workflow runs, cache reads were ~55% of the bill. A full source
sweep for the [#6147](https://github.com/kamp-us/phoenix/issues/6147) plan found **35 verb files**
printing at least one array-valued evidence field, across 20 of the CLI's verb groups.

The volume is not an accident to fix quietly. `claude-plugins/fabrika/skills/build/contract.md`
defends `excluded` outright: each excluded issue is reported with its reason "so a shortened or empty
pool is auditable from the answer itself rather than only from the counts". Any ruling had to answer
that rationale rather than step over it — which is why this was one decision, not 35 bug fixes.

Three shapes were on the table. Founder ruling on 2026-08-18, recorded at
[#5641, comment 5334469355](https://github.com/kamp-us/phoenix/issues/5641#issuecomment-5334469355):
option **(c)**, bounded evidence.

**This record rides a build rather than its own decision issue.** A builder refuses to claim a
`type:decision`, so the ADR a ruling implies is minted by the ruling's first build child — the
[#5909](https://github.com/kamp-us/phoenix/issues/5909) to
[#6143](https://github.com/kamp-us/phoenix/issues/6143) precedent.

## Decision

**Classify per field, collapse only evidence.**

- **Answer-array** — a skill or contract instructs its reader to iterate the rows, or the rows are
  what the caller asked for. Untouched. If it needs bounding it gets an explicit cap the caller
  controls (`build pick`'s `--limit`, `report dedup`'s `--limit`), never a silent collapse.
- **Evidence-array** — printed so the answer is auditable, with no skill reading a row by name. It
  collapses:
  - to a **reason histogram** — `{"audience-not-agent": 155, "out-of-focus": 111}` — when its rows
    carry a small fixed vocabulary. This is the default: the vocabulary is exactly what a reader acts
    on, so the histogram preserves the auditability the contract defends at ~2% of the bytes.
  - to a **cap-and-count** — the first N rows plus a remainder — when there is no such vocabulary.
- **The bounded tail is not collapsed.** An evidence-array that is structurally small (a flag echo, a
  proof-of-write read-back, a fixed-length list) is recorded in the table below as deliberately left
  whole. Collapsing a two-element array is self-generated churn.
- **Both channels move together.** A verb that mirrors an array into a tab-line grammar collapses
  both; a JSON-only collapse desyncs the two, and several skills read the line form.
- **One shared helper, not a per-verb shape.**
  [`packages/fabrika-cli/src/evidence.ts`](../packages/fabrika-cli/src/evidence.ts) exports both
  collapses as pure functions. It sits beside the `answer()` seam in
  [`packages/fabrika-cli/src/verb.ts`](../packages/fabrika-cli/src/verb.ts) rather than inside it,
  because that module owns the answer channel and takes an already-serialized string — payload
  shaping happens before serialization and is a different concern. The five private tallies in the
  package (`spend/rollup.ts`, `ci/changelog.ts`, `map/frontier.ts`, `governance/roots.ts`,
  `review/classes.ts`) are each shape-specific and stay where they are.
- **Histogram key order is count-descending, ties on the reason.** The object is serialized straight
  into the payload, so key order is bytes a reader and a golden fixture both see; deriving it from
  row order would make one tally print two ways depending on which issue the board listed first.

### Why (a) and (b) lost

- **(a) Quiet by default, full payload behind a flag.** It needs the same per-field
  answer-vs-evidence judgement anyway — a quiet mode has to know what to keep — so its 24-file seam
  refactor (`answer()` taking an object plus a projection, plus the copied `emit` adapter in every
  group's `command.ts`) buys nothing the classification does not already deliver. It also adds a
  user-facing surface, and a caller who forgets the flag gets a silently narrower answer.
- **(b) Evidence moves to a separate verb.** ~35 new verbs, and a second round-trip for any caller
  that genuinely wants the evidence — which, on the measurement, is nobody.

### The governance readings

- **ADR [0112](0112-token-measurement-no-quality-compromise-methodology.md)'s measurement gate does
  not apply.** That methodology gates levers that *trade* quality for tokens: a frozen task set, a
  reproducible meter, and quality regression as a veto. Collapsing rows no caller reads trades no
  quality — there is no output whose quality could regress, because no skill's behaviour depends on
  the rows. What replaces the gate is the classification itself: the risk here is mis-classifying an
  answer as evidence, and that is caught by reading the field's skill/contract corpus per field, not
  by a token meter.
- **ADR [0200](0200-reject-context-mode-token-lever.md) is a different lever, and there is no
  contradiction.** 0200 rejected an external context-mode plugin partly because context volume was
  not the dominant spend axis on the evidence then. This is not that plugin and not that mechanism:
  it removes bytes the CLI itself emits, with no new dependency, no hooks and no MCP surface. The
  later measurement (cache reads ~55% of the bill) updates the evidence 0200 read, it does not
  overturn 0200's rejection of that tool.

### Two of the ruling's own examples flipped under the per-field check

The ruling demanded the classification be verified per field before any collapse. Two of the
examples named in the ruling and the report did not survive that check the way they were named:

- **`grill read`'s `questions` is an answer-array and is not touched.**
  `claude-plugins/fabrika/skills/grilling/contract.md:760` states the prose is carried "so a caller
  can name the open questions to the founder without a second read", and
  `claude-plugins/fabrika/skills/grilling/SKILL.md:160` makes one state row per question the
  done-condition. It was cited as the worst evidence offender; it is the clearest answer-array in the
  CLI.
- **`build pick`'s `excluded` survives as evidence**, and is the exemplar collapse.
  `claude-plugins/fabrika/skills/build/SKILL.md:53` hands the reader the reason *vocabulary* — a
  histogram satisfies it exactly — and nothing anywhere reads an excluded issue's number or home.

## Per-field classification

**This table is complete over the CLI as of 2026-08-19**, filled in by the closing sweep of epic
[#6147](https://github.com/kamp-us/phoenix/issues/6147) so no field is re-litigated ticket by ticket.
The sweep read all 27 registered verb groups (`packages/fabrika-cli/src/registry.ts:51-77`), checked every field that reaches
the **answer channel** against the live skill/contract corpus, and recorded the verdict below. A
field that reaches only the stderr notes channel is out of scope — that channel is diagnostics, and
this ADR does not govern it. A verb absent from the table prints no array on the answer channel.

A field added after this date is unclassified and **stays whole until a row here says otherwise**.

### `build`

| Verb | Field | Class | Shape | Why |
|---|---|---|---|---|
| `build pick` | `pool` | answer | whole, `--limit`-capped | the reader picks from it (`build/SKILL.md:51-52`) |
| `build pick` | `excluded` | evidence | reason histogram | reason vocabulary is all a reader acts on; no row is read by name (`build/SKILL.md:53`) |
| `build pick` | `campaigns.milestones` | evidence | whole — bounded | one entry per active campaign; the skill reads the state beside it, not the rows |
| `build check` | `unvalidated` | answer | whole | the skill routes on it: a file class here sends the reader to another surface (`build/SKILL.md:181-185`, `:190`) |
| `build check` | `ran` | evidence | whole — bounded | an echo of the declared validators (config-bound; ≤2 on the prose/plan surface) |
| `build issue` | `criteria.items` | answer | whole | every criterion must map to something the builder can point at (`build/SKILL.md:153`) |
| `build issue` | `labels` | evidence | whole — bounded | an issue's labels; shape-documented only, never iterated by a skill |
| `build verdicts` | `rows` | answer | whole | "Act only on rows it prints" (`build/SKILL.md:340`) |
| `build verdicts` | `frozenCriteria` | answer | whole | the skill is told to note each row (`build/SKILL.md:359-360`) |
| `build verdicts` | `clearances` | evidence | whole — bounded | the decision is `capReached`, never a count derived from these rows (`build/SKILL.md:342`); one row per grant, and always empty on the `--issue` arm |

The `build` group's other verbs (`branch`, `commit`, `clear`, `pr`, `pr-body`, `claim`, `confirm`,
`release`, `adopt`, `note`, `eligible`, `scratch`, `tree`, `push`) print no array-valued field on the
answer channel — their multi-line context rides the stderr notes channel, which is not this ADR's
surface.

### `adr` · `ci`

| Verb | Field | Class | Shape | Why |
|---|---|---|---|---|
| `adr next` / `adr mint` | `inFlight` | evidence | whole — bounded | one id per *open* ADR pull request, so it is bounded by concurrent PRs, not by the corpus; its stated job is auditability (`adr/contract.md:154`) and no skill reads a row |
| `adr resolve` | the top-level array | answer | whole, caller-capped by argument count | one row per id the caller passed, in argument order; the reader cites only the `live` ones (`adr/SKILL.md:98`, `:100-103`) |
| `adr sweep` | `entries` | answer | whole, `--limit`-capped (default 8) | "open the entries and judge each once" (`adr/SKILL.md:76`) |
| `ci evidence` | `checks` | answer | whole | a downstream reader folds every entry — `present` needs every one passing, `failed` fires when one did not (`ship/contract.md:1047`, `:1068-1069`); schema-required by ADR 0054 |
| `ci evidence` | `tests.failures` | **open** | whole — unchanged | see *Open rows* below |

### `glossary` · `governance` · `graduate` · `grill` · `guard`

| Verb | Field | Class | Shape | Why |
|---|---|---|---|---|
| `glossary check` | `findings` | answer | whole | the reader fixes each named row, and the contract pins "the finding list is the whole verdict rather than a truncation" (`glossary/contract.md:896`) — the one field whose closed `kind` set makes a histogram look attractive and is still an answer |
| `glossary drift` | `candidates` | answer | whole, `--limit`-capped (default 40) | judged one by one (`glossary/SKILL.md:86-89`) |
| `glossary lookup` | the top-level array | answer | whole | "For each term: `declared`, `absent`, or `collision`" (`glossary/SKILL.md:66`) |
| `glossary lookup` | `[].matched` | answer | whole | "Judge each collision" (`glossary/SKILL.md:70-75`) |
| `glossary sections` | the top-level array | answer | whole | the reader picks the section to pass to `add --section`, "read them rather than recalling them" (`glossary/SKILL.md:138-144`) |
| `governance base` | the `file` block sequence | answer | whole | the payload is one `file\t<path>\t<byte-count>` header plus that file's bytes per requested path (`governance/base-verb.ts:220-235`, `:246`), so its length is the caller's own `--path` list and the self fence reads every block it asked for — "No `--json`: the bytes are the object" (`governance/contract.md:791-793`) |
| `governance guards` | `hits` | answer | whole | "Done when **every anchored hit has a disposition**" (`governance/SKILL.md:166`) |
| `governance guards` | `guardFiles` | evidence | cap-and-count (5) | landed by #6484 |
| `governance scope` | `roots` | evidence | reason histogram | landed by #6484 |
| `governance scope` | `records` | answer | whole | the reader takes an id off it and feeds the next verb (`governance/SKILL.md:100-103`) |
| `governance sweep` | `entries` | answer | whole, `--limit`-capped (default 8) | "reading the shortlist … is judgment" (`governance/contract.md:29`) |
| `governance digest` | `records` | answer | whole | the reader ranks each landed record and writes a row for it (`governance/SKILL.md:276-279`) |
| `graduate trail` | `decisions` / `unresolved` / `outOfScope` | answer | whole | all three are read per row (`graduate/SKILL.md:95-96`, `:101-103`), and the whole object is re-parsed off a **file** by `compose --trail` (`graduate/contract.md:629`, `:645`) — a collapse there is a machine-to-machine break |
| `graduate emit` | `labels` | evidence | whole — bounded | always exactly `["status:needs-triage"]` (`graduate/contract.md:796`) |
| `graduate read` | `emissions` / `[].covers` / `disregarded` | answer | whole | "**read the `emissions` array, not just `state`**" (`graduate/SKILL.md:65-67`); `covers` is unioned per row (`graduate/contract.md:911`); a caller must read `disregarded` alongside (`:925`) |
| `grill round` | `questions` / `supersedes` | evidence | whole — bounded | a read-back echo of the caller's own stdin and of `--supersedes` (`grilling/contract.md:498`); the done-condition is the comment landing (`grilling/SKILL.md:206`) |
| `grill read` | `questions` | answer | whole | one state row per question is the done-condition (`grilling/SKILL.md:160`); see also *Open rows* on the row-level trim |
| `grill read` | `disregarded` | answer | whole | "**Surface every disregarded marker** … and why" — the reader relays each `detail` (`grilling/SKILL.md:144-147`) |
| `guard` (all verbs) | — | — | — | the group prints **no array on the answer channel at all**: nearly every guard funnels through `guard/verdict.ts:93`, whose stdout is one summary string, and the report and annotation lines go to stderr. Two verbs bypass that funnel and call `answer(...)` directly — `guard/design-inventory-verb.ts:152` and `guard/design-token-verb.ts:232` (registered at `guard/command.ts:615` and `:569`) — and each prints a single line, so the verdict holds for them by their own shape rather than by the funnel |

### `handoff` · `heal-ci` · `hook` · `lane`

| Verb | Field | Class | Shape | Why |
|---|---|---|---|---|
| `handoff capture` | `board.issue.labels` | **open** | whole — unchanged | see *Open rows* below |
| `handoff read` | `disregarded` | evidence | whole — bounded | the contract pins it bounded by the walk, "never an unbounded history" (`handoff/contract.md:757-763`) |
| `handoff read` | `drift.fields` | answer | whole | structurally ≤16 and the reader routes on named field rows (`handoff/SKILL.md:220-227`) |
| `heal-ci sweep` | `prs` | answer | whole, `--limit`-capped (200) | "**Work the rows top-down through step 1**" (`heal-ci/SKILL.md:187-188`) |
| `heal-ci surface` | `required` / `extra` | answer | whole | the verb "names each required context with no producing run, and each producing run answering no requirement" (`heal-ci/SKILL.md:151-152`) |
| `heal-ci logs` | `contexts` | answer | whole | "emits **every** failing gating context… Work every line" (`heal-ci/SKILL.md:106-108`). By far the biggest payload in the CLI (up to `--max-bytes`, default 64 KiB, of log text per row) — and the lever there is that **caller-controlled cap**, not a collapse |
| `heal-ci classify` | `contexts` | answer | whole | each row's `class` licenses one action (`heal-ci/SKILL.md:106-116`) |
| `hook codes` | `codes` | answer | whole — bounded | a fixed 8-row table that **is** the verb's whole answer |
| `lane status` | `context.errors` | evidence | whole — bounded | one entry per error-final task; the skill routes on `stateValue` leaf names instead (`operate/SKILL.md:164-177`) |
| `lane prove` | `evidence.namespaces` | evidence | whole — bounded | ≤4 rows; the only `evidence.*` a skill reads is `evidence.branch` (`operate/SKILL.md:218`) |
| `lane history` | the top-level array | answer | whole | the bytes **are** the artifact — they are piped verbatim into the lane's terminal transcript comment (`operate/SKILL.md:608`, `:611`) |
| `lane print` | `phases` / `phases[].tasks` / `tasks.<id>.states.<state>` | answer | whole | same transcript pipe (`operate/SKILL.md:608`); a collapse posts a truncated record onto the driven issue |
| `lane stale` | `scanned` | evidence | whole — bounded | ≤2 rows, one per scanned root |
| `lane stale` | `lanes` | answer | whole | "the list is exactly the lanes to re-spawn" (`operate/SKILL.md:633-635`) |

### `ledger` · `map` · `pattern` · `plan` · `recipe`

| Verb | Field | Class | Shape | Why |
|---|---|---|---|---|
| `ledger open` | `children` (and `[].labels`) | answer | whole | "a fact the skill must read" (`plan-epic/contract.md:457`), named in the done-condition (`plan-epic/SKILL.md:97`) |
| `ledger open` | `candidates.items` | answer | whole, capped at 20 | "**read them** before minting a duplicate" (`plan-epic/SKILL.md:104`) |
| `ledger draft` | `stories` | evidence | whole — bounded | a contiguous run from 1, so its content is fixed by its length — collapsing it saves nothing |
| `ledger child` | `observed.labels` / `.assignees` / `stories` | evidence | whole — bounded | a proof-of-write read-back over one issue; the done-condition is `minted` plus `linked` (`plan-epic/SKILL.md:171`) |
| `ledger topology` | `edges` | evidence | **cap-and-count (5)** | collapsed by this sweep: a validated echo of the caller's own stdin, one pair per declared `requires`; the reader acts on the verdict and the rendered block (`plan-epic/SKILL.md:204-206`) |
| `map read` | `tickets` (and `[].blockedBy` / `.blocking`) | answer | whole | one row per frontier ticket, and "the derivation stays in the reader" (`wayfinding/contract.md:546`, `:552`) |
| `map read` | `outOfScope` | answer | whole | the contract exists to **reject a count**: "a count would tell a caller that a rejection exists and leave it unable to say anything about it" (`wayfinding/contract.md:562-565`) |
| `map read` | `disregarded` | evidence | whole — bounded | one row per malformed child comment, ordinarily zero; a closed 3-reason set, but too small for a collapse to pay |
| `map open` | `answeredCandidates` | answer | whole, nested cap 5 | "**Reading it is yours**" (`wayfinding/SKILL.md:74-78`) |
| `map ticket` | `blockedBy` / `blocking` | evidence | whole — bounded | a read-back echo of the caller's own `--blocked-by` / `--blocks` flags (`map/ticket-verb.ts:272-273`); one entry per flag the caller typed, so its length is the caller's own |
| `pattern corpus` | `entries` / `danglingRows` | answer | whole | "**Read the rows before writing**" (`write-pattern/SKILL.md:94`, `:99`) |
| `pattern drift` | `paths` | answer | whole | "**open the moved paths** and check the prose against them" (`write-pattern/SKILL.md:130`) |
| `pattern drift` | `unresolvedPaths` | answer | whole | the contract exists to reject a count: "so a caller can see what was skipped **rather than trusting a count**" (`write-pattern/contract.md:384-385`) |
| `pattern anchor` | `packages` | answer | whole | the per-state action is per package (`write-pattern/SKILL.md:137-138`) |
| `plan read` | `children` (and `[].labels` / `.assignees` / `.stories`) | answer | whole | the done-condition names the child set with each child's labels (`check-epic-plan/SKILL.md:74-75`, `:133`) |
| `plan read` | `epicStories` | evidence | whole — bounded | a contiguous run from 1, same as `ledger draft`'s |
| `plan read` | `topology.phases` / `.edges` | **open** | whole — unchanged | see *Open rows* below |
| `plan check` | `scanned` / `defects` | **open** | whole — unchanged | see *Open rows* below |
| `plan check` | `defects[].refs` | evidence | whole — bounded | one ref, except a `DEP_CYCLE`'s member set |
| `plan check` / `plan verdict` | `skipped` | answer | whole — bounded | "Done when you hold `answer`, `digest`, and **`skipped`**" (`check-epic-plan/SKILL.md:89-91`) |
| `plan flip` | `children` | evidence | count + result histogram | landed by #6483 |
| `plan flip` | `audience.observed` | evidence | whole — bounded | a proof-of-write read-back; the skill reads `audience.result` (`check-epic-plan/SKILL.md:127`) |
| `recipe rerun` | `rerun` | evidence | whole — bounded | one row per failed run at head, each proven by its own re-read; **no skill invokes this verb at all** |

### `report` · `review` · `review-ui` · `ship` · `spend`

| Verb | Field | Class | Shape | Why |
|---|---|---|---|---|
| `report dedup` | `candidates` | answer | whole, `--limit`-capped (default 20) | "open each and judge it yourself" (`report/SKILL.md:60`) |
| `report dedup` | `tokens` | evidence | whole — bounded | hard-capped at 12 in the tokenizer |
| `report file` / `report note` | `redactions` | evidence | **reason histogram** | collapsed by this sweep: no skill reads a row, and each redaction already prints its own `line <n>, <class>` note on the notes channel — the rows were a second copy of a diagnostic |
| `review scope` / `ship scope` / `ship gate` | `classes` / `namespaces` | answer | whole — bounded | the printed set is "**both floor and ceiling**" for the verdicts owed (`review/SKILL.md:34-36`; `ship/SKILL.md:41`, `:92`, `:98-101`) |
| `review criteria` | `criteria` | answer | whole | the reviewer grades each row (`review/SKILL.md:64`) |
| `review ci` | `checks` | evidence | **reason histogram over `status`** | collapsed by this sweep: neither caller iterates a row — `review` acts on `rollup`, and `review-ui` read three gates *by name*, which this sweep re-routes to `heal-ci surface` (below) because that verb tells a required gate that never ran from a gate the repo does not declare at all — two facts `review ci` collapsed into one absent row even before this change. A repo with 34 workflows paid ~20 rows per read; naming the red and still-running checks moves to the notes channel in the same change |
| `review verdicts` | `markers` / `malformed` | answer | whole | a stale or malformed marker is a per-row terminal state the reviewer reports (`review/SKILL.md:19`, `:213`) |
| `review deviations` | `entries` | answer | whole | "Match your findings against each entry's **substance**" (`review/SKILL.md:140`) |
| `review deviations` | `tierM` | **open** | whole — unchanged | see *Open rows* below |
| `review-ui render` / `ui render` | `captures` | answer | whole | every surface's outcome forks the verdict (`review-ui/SKILL.md:76-86`), and the same bytes are the render set's `manifest.json`, which `review-ui post` reads back — a **file** reader, not only a stdout one |
| `review-ui render` | `captures[].pageErrors` | evidence | cap-and-count (3) | landed by #6485 |
| `ship checks` / `ship evidence` | `checks` | evidence | reason histogram | landed by #6482 |
| `ship threads` | `threads` | answer | whole | "For each unresolved thread:" with a per-thread decision (`ship/SKILL.md:162-171`) |
| `ship threads` | `threads[].authors` | **open** | whole — unchanged | see *Open rows* below |
| `spend rollup` | `byDay.rows` / `bySkill.rows` / `byStageArm.rows` | evidence | cap-and-count (10) | landed by #6486 |

### `spike` · `status` · `triage` · `ui` · `wire`

| Verb | Field | Class | Shape | Why |
|---|---|---|---|---|
| `spike run` | `command` | evidence | whole — bounded | the caller's own argv, echoed back |
| `status menu` | `skills` | answer | whole | the reader routes off the roster and may name only listed skills; a dropped row is a defect (`front-door/contract.md:670-671`) |
| `status settings` | `settings` (and `[].value`) | answer | whole | `governance` reads the `governedRoots` value off this verb (`governance/SKILL.md:52`), and front-door reads a row's provenance per key (`front-door/SKILL.md:37-39`) |
| `status settings` | `surfaces` | answer | whole | each row is one repo surface with its when-missing outcome (`front-door/SKILL.md:103-105`) |
| `status board` | `buckets` | answer | whole — bounded | exactly six, fixed; "the other buckets are **not seen** rather than zero" (`front-door/SKILL.md:62-63`) |
| `status readout` | `rows` | answer | whole | "You display rows in the artifact's order" (`front-door/SKILL.md:171-173`) |
| `status open` | `fields` | answer | whole — bounded | five fields, each naming its source (`front-door/SKILL.md:29-31`) |
| `triage queue` | `issues` | answer | whole, `--limit`-capped (default 100) | "report one line per issue: outcome, type, priority, home, audience" (`triage/SKILL.md:284-285`) |
| `triage homes` | `milestones` / `lanes` | answer | whole | the reader picks the home off these rows (`triage/SKILL.md:142`) |
| `triage apply` / `triage park` | `removed`, `readBack.labels` | evidence | whole — bounded | only the four owned facets can be removed (`triage/contract.md:1755-1760`); `readBack` is a proof-of-write read-back |
| `triage codes` | `codes` | answer | whole — bounded | a fixed 20-row exit table that is the verb's whole answer |
| `triage repair-criteria --sweep` | `issues` | **open** | whole — unchanged | see *Open rows* below |
| `ui law` | `rows` | answer | whole | "The typed registry rows are your generation-time law" (`build-ui/SKILL.md:77-78`) |
| `ui golden` | `diff.regions` | evidence | whole — bounded | already hard-capped at 20 in the differ, largest-area first; the skill steers on the *signal*, "never a verdict" (`build-ui/SKILL.md:124`) |
| `wire read` | `fields` | answer | whole | the fields are the entire point of the verb |
| `wire formats` | `formats` | answer | whole | the listing is the answer — a projection of the registry |
| `wire formats` | `formats[].producers` / `.consumers` | evidence | whole — bounded | registry metadata beside each row; no skill reads one |
| `wire codes` | `codes` | answer | whole — bounded | a fixed 11-row exit table that is the verb's whole answer |

### Open rows — classified, not collapsed, awaiting a founder ruling

Each of these is an evidence-shaped field the sweep declined to collapse on its own authority. They
are **byte-unchanged**, and each names the reading that blocks the collapse. Nothing here is a
to-do the next builder may pick up: a row leaves this section when the founder rules on it.

| Verb | Field | What blocks the collapse |
|---|---|---|
| `grill read` | `questions[].text` on `ruled` / `answered` / `superseded` rows | the array is a proven **answer**, so this is a *row-level trim*, a third shape the ruling never named. `grilling/contract.md:758-760` carries `text` "so a caller can name the open questions to the founder without a second read" — which only bites on the unsettled rows — but the same paragraph makes `text` present on **every** row. Largest byte win left in `grill`. |
| `map read` | `outOfScope` | `wayfinding/contract.md:562-565` exists specifically to reject a count. Under the ruling's own rule that makes it an answer, and it is listed here only so nobody re-opens it. |
| `pattern drift` | `unresolvedPaths` | same shape: `write-pattern/contract.md:384-385` rejects a count outright. |
| `ship threads` | `threads[].authors` | nothing names the field, and the skill routes off the derived `class` — but `ship/SKILL.md:164` makes "any doubt in the class facts" a refusal trigger, and `authors` is the only class fact on the wire that lets a reader second-guess the derivation. |
| `review deviations` | `tierM` | the contract reads both ways in one section: `review/contract.md:755` makes each hit "a fact the judgment layer matches against the disclosed entries" (per-row), while `:766-767` makes only non-emptiness actionable ("a `None.` printed beside a non-empty Tier-M list is a falsified disclosure"). |
| `ci evidence` | `tests.failures` | it is a schema field of a **versioned document**, not a verb payload: ADR [0054](0054-run-evidence-bundle.md):72-73 makes it Required and `:93` names a reader that cites it, so a collapse needs an 0054 amendment and a `schemaVersion` bump. Judged against that ADR, not this one. |
| `handoff capture` | `board.issue.labels` | **structurally uncollapsible.** It is digest field 15 (`packages/fabrika-cli/src/handoff/ground.ts:90`) and the pre-image is `<path>=<json>` per field, so any collapse changes every ground digest and makes `handoff read` refuse the pack on `14`. |
| `plan read` | `topology.phases` / `topology.edges` | the contract says only "`topology` is the imported `readTopology` parse" (`check-epic-plan/contract.md:406`) and the step-1 done-condition omits it — but it is a **structural object**, not a row list, and capping `phases` would drop phase membership rather than shorten it. |
| `plan check` | `scanned`, `defects` | `check-epic-plan/SKILL.md:89` deliberately enumerates `answer` / `digest` / `skipped` and stops, and `plan verdict` re-derives the defect list from its own floor run (`contract.md:778`) — yet `:192` says `PLAN-REFUSED` is posted "**naming them**", and `contract.md:806` refuses a caveat naming a ref outside the scanned set. Someone must know the membership; which field is the authority is the open question. |
| `triage repair-criteria --sweep` | `issues` | evidence by the letter — nothing reads a row — but **no skill invokes `--sweep` at all** (every corpus hit routes to the single-issue arm), so a collapse buys zero agent tokens, which is this ADR's whole purpose. Meanwhile the rows are the only place a `refused` or `moved` issue's number appears for the operator running it by hand. Collapsing here would cost information and save nothing. |

## Consequences

- `build pick`'s payload drops from ~21,478 bytes to roughly 3,500 on the measured board, with the
  auditability the contract defends intact: the reasons and their counts are still on the answer
  channel.
- **The sweep's own result is that most array fields are answers.** Of every field classified above,
  the collapses number nine across seven verbs; the rest are answer-arrays a skill iterates, or
  evidence too small to pay for collapsing. The spend was concentrated, not spread — which is why
  the ruling's per-field discipline mattered more than its reach.
- **A field a reader still needs by name keeps it — on the notes channel.** `ship checks` and
  `review ci` both collapse their check rows and both name the failing (and, for `review ci`, the
  still-running) checks on stderr. That is the general move where a collapse would otherwise delete
  something real: the counts answer "how many", the notes answer "which one", and neither is on the
  channel the other belongs to.
- **A field with two callers is classified against both, or the collapse fails open.** `review ci`
  has two: `review`, which acts on `rollup`, and `review-ui`, which named three gates and read their
  live state off the check rows. Collapsing on the first caller alone would have left `review-ui`
  unable to tell a required gate that ran green from one that never ran — a fail-open, and exactly
  what its §5 exists to prevent. The fix was not to keep the rows, which never answered the adjacent
  question either: a gate the repo does not declare and a declared gate that never ran were both
  simply no row. `heal-ci surface` answers both, printing every declared context as `producing` or
  `absent` and every undeclared gating run as `extra`, so `review-ui` now reads its named gates
  there — off **both** lists, keyed on the check-run name (the job's `name:`), not the workflow
  filename; on phoenix today all three land in `extra`. A collapse that deletes a reader's only read is repaired by
  finding the reader a better one, not by putting the rows back.
- **A mis-classification is a silent break.** Collapsing an answer-array leaves the skill that
  iterates it reading a shape that no longer exists, and nothing fails loudly. Every collapse
  re-verifies the field against the live skill/contract corpus first — the ruling's own examples show
  why a remembered classification is not one.
- **Contracts move with their verb, in the same PR.** A contract line pinning the old array shape is
  a reader acting on a shape that is gone.
- Each collapsing change asserts the new shape in that verb's own unit test; the helper is pure and
  tested directly. No new gate.
- This is a CLI-output convention, not product vocabulary: **answer-array** and **evidence-array**
  are defined here and `.glossary/LANGUAGE.md` is untouched.

## Grounding

- [#5641](https://github.com/kamp-us/phoenix/issues/5641) — the question, the measurement, and the
  ruling comment.
- [#6147](https://github.com/kamp-us/phoenix/issues/6147) — the epic executing it, with the full
  source sweep behind the table above.
- [`packages/fabrika-cli/src/evidence.ts`](../packages/fabrika-cli/src/evidence.ts) — the two
  collapses.
- [`claude-plugins/fabrika/skills/build/contract.md`](../claude-plugins/fabrika/skills/build/contract.md)
  — the exemplar's pinned output shape.
