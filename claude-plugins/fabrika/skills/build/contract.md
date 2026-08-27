# `/build` — derived CLI contract

**Skill:** [`build`](SKILL.md) · **Authoring brief:** [#4707](https://github.com/kamp-us/phoenix/issues/4707) · **Date:** 2026-08-08

**Amended 2026-08-09** — the campaign-scope admission term ([ADR 0245](../../../../.decisions/0245-campaign-scope-fence-binds-both-seams.md), [#5013](https://github.com/kamp-us/phoenix/issues/5013)): a new [admission test](#admission-test--scope-admission-and-the-audience-axis) section under shared conventions — scope admission composed with the pre-existing `ready-for:` audience axis, two named axes rather than one widened term — two codes (`20`, `21`) in the shared exit matrix, and the consuming clauses in `build pick` and `build claim`.

**Amended 2026-08-10** — the third file class in `build check` ([#5229](https://github.com/kamp-us/phoenix/issues/5229)): a changed file matching neither the code nor the markdown pattern is now named rather than dropped out of both filters, so a diff nothing validates refuses on a new code (`22`) instead of greening, and a green over a partly-unvalidatable diff carries the files it did not cover.

**Amended 2026-08-13** — `build commit` ([#5484](https://github.com/kamp-us/phoenix/issues/5484)): the group had no commit verb, so the message-carrying path at every call site was improvised and nothing asserted the message on the resulting commit. A lane's improvised `git commit -F <leaf>` read back a two-day-old message from another lane and committed it, silently, with every command exiting 0. The verb prescribes the carrying path, tests the numbers the message names against this lane's claim, and reads the message back off the created commit — plus one code (`24`) in the shared exit matrix.

**Amended 2026-08-20** — `build claimants` ([#6837](https://github.com/kamp-us/phoenix/pull/6837), [#6771](https://github.com/kamp-us/phoenix/issues/6771)): every ownership verb in the claim family asks about the *asking* lane, so a driver arriving after a session limit killed its builders could read which lanes stopped but not which numbers those dead lanes left claimed — `confirm` refuses a token of any other session and `claim` would only answer by writing a marker of its own. The verb reads one issue's claim state holding no token, writing nothing and clearing nothing, and `lane stale --claims` runs the same read across a sweep. Its block sits under the existing claim-family heading rather than standing alone, and it adds no code to the shared exit matrix.

**Amended 2026-08-21** — `build deviations` ([#6691](https://github.com/kamp-us/phoenix/issues/6691)): the epic child's disclosure had no verb, so the skill hand-rolled `wire emit` into `gh issue comment`, which appends. A repair round left the child carrying two markers, and `wire read --format build-deviations` refuses two conforming headings as undecidable — so a repaired child stranded its epic's whole tail review. The verb owns the write seam and holds one marker per issue: the standing marker is edited in place, every superseded one is retracted, and the landed comment is read back. No new code — it allocates from the shared matrix.

The verbs land in `packages/fabrika-cli/` under the `build` subcommand group, registered in
`packages/fabrika-cli/src/registry.ts` like the shipped `adr`, `report`, `triage` and `wire`
groups. The [CLI interface convention](../../docs/cli-interface-convention.md) governs every verb;
where this spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill** (ADR 0238). Every v1 tool
named below is prior art that was **read** for its semantics and scars — `claim`, `verified-push`,
`scratchpad`, `worktree-guard`, `checks` — and none is invoked, wrapped, or deferred to. Where a
scar is named, the verb here designs it out; that is the only thing a rebuild inherits.

**What fabrika already ships, reused by import — never respecified:**

- `packages/fabrika-cli/src/wire/acceptance-criteria.ts` — the total `read` over an issue body's
  `### Acceptance criteria` block (`Found` / `Absent` / `Malformed`). `build issue` imports it.
- `packages/fabrika-cli/src/wire/verdict-marker.ts` — the verdict-marker `read` and its
  head-binding (`bindToHead`). `build verdicts` imports both.
- `packages/fabrika-cli/src/report/leaks.ts` — `scanBody` and `isBareAtReference`, the
  machine-local-path predicates for a **body this skill posts**. `build pr` and `build note` import
  them.
- `packages/fabrika-cli/src/build/doc-leaks.ts` — `docLeaks`, the same question over a **committed
  file**, which is a different answer. `build check --surface prose` imports it and nothing else
  declares a path shape.
- `packages/fabrika-cli/src/build/prose-baseline.ts` — `introducedLeaks`, the multiset difference
  that leaves a changed file's *pre-existing* leaks with the author who wrote them. `build check
  --surface prose` imports it; the docblock carries why the shape is a baseline and where its
  prediction runs looser than the gate.
- `packages/fabrika-cli/src/report/compose.ts` — `normalizeForReadback` (three steps: CRLF→LF,
  strip trailing spaces/tabs per line, strip trailing newlines — read the body, the docblock
  understates it). Both writing verbs' read-backs compare through it, never byte-for-byte:
  GitHub's round-tripping is not byte-stable and asserting it fires a false mismatch on clean runs.

A restatement of any of these would be a transcription, and a transcription drifts. The spec says
*import this*, with the path.

**Considered and deliberately not derived** — each is a question already enforced at a gate, and a
second answer to a gated question can contradict the gate (interface convention rule 6):

- **A control-plane classifier.** CODEOWNERS decides §CP membership at the merge gate. `build pr`
  *refuses a body that asserts the classification* (#4153) — it never computes one.
- **A changed-files leak scanner.** `leak-guard.yml` reds it in CI. The writing verbs guard only
  the text this skill itself posts.
- **A CI-rollup reader.** The repo's CI gate owns redness; the review/ship stages read it. `build check` is
  an in-tree *prediction*, not a second verdict over the gate's question.
- **A trivial-diff classifier.** v1's ships dormant by design (ADR 0120); nothing here consumes it.
- **Any opinion about where a lane runs.** No provisioner, no locker, no reaper — and no refusal
  either. The 2026-08-13 ruling on #5386 dropped the whole isolation posture: fabrika runs wherever
  it is spawned, and isolation is the operator's call, said in prose at spawn time. What survives
  is location-neutral: don't leave a mess (`13`), don't work another lane's branch (`14`).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `build tree` | prove the ground: optionally clean, optionally this lane's | two git-derivable assertions — no judgment; *what to do on a refusal* (stop, report) stays in the skill |
| `build pick` | the ranked candidate pool: `status:triaged` + `ready-for:agent` + unassigned, paginated | a label/assignee filter over a paged listing — no judgment; the *choice* among candidates stays in the skill |
| `build eligible` | one issue's dependency gate: `eligible` / blocked-by-named-edge / UNKNOWN | derivable entirely from the issue's native `blocked_by` edges, those blockers' states, and the commits `epic/<parent>` adds over the trunk in this tree |
| `build claim` | race the earliest-authorized claim on an issue; win, or name the winner | a deterministic race protocol; *what to do on a loss* stays in the skill |
| `build confirm` | re-prove this LANE still holds the claim before a mutation | a lookup with a defined answer |
| `build release` | retract this LANE's own claim | a guarded single write |
| `build adopt` | record that a dead session's claim passes to the lane this marker names, which may then release it or carry on | a marker write with a read-back; *whether the session is really gone* is the driver's judgment |
| `build claimants` | who holds the claim on one issue, asked by a caller holding no token | the same ownership fold `confirm` runs, reported instead of tested against a caller; *what to do about a stranded claim* stays with the driver |
| `build issue` | the claimed issue's body + parsed acceptance criteria, through the content gate | fetch + parse via the wire module; *judging* the criteria stays in the skill |
| `build branch` | cut (or resume) the lane's nonce branch off a freshly fetched base | fetch, derive, create — the nonce is a function of the claim token |
| `build scratch` | the per-lane scratch path, allocated fail-closed | deterministic path derivation keyed session + issue + claim nonce |
| `build commit` | create this lane's commit from an authored message, and prove the commit carries it | a prescribed carrying path, a claim test over the numbers named, and a read-back — no judgment; *authoring* the message stays in the skill |
| `build check` | run this surface's validators in this tree, cache-bypassed; green/red/unknown | command execution + tree-binding assertions; *fixing red* stays in the skill |
| `build push` | publish the branch and independently confirm the remote ref moved | push + `ls-remote` read-back, three proven outcomes |
| `build pr` | open the PR from a stdin body, refusing the known defect shapes, with read-back | mechanical guards over an authored body; *authoring* stays in the skill |
| `build pr-body` | replace an open PR's body from a stdin body, under `build pr`'s guards, with read-back | the same mechanical guards as `build pr`, over a `PATCH` that moves no ref; *authoring* stays in the skill |
| `build note` | post a progress/handoff comment, head-stamped, leak-guarded, with read-back | as `report note`, plus the head stamp |
| `build deviations` | post an epic child's `## Deviations` disclosure as the ONE `build-deviations` marker on its issue, edited in place on every later round | a claim-gated upsert with a read-back, over a section validated by the wire format; *authoring* the disclosure stays in the skill |
| `build verdicts` | the paginated, per-gate verdict fold: current-head on a PR, range-bound on an epic child | fetch-all + fold via the wire module; *acting on rows* stays in the skill |
| `build clear` | record the founder's clearance of one extra repair round on a PR | a conjunctive ACL/authorization protocol with read-back; *whether to grant* is the founder's, never the verb's |

**Considered and not derived: a surface classifier.** Naming the surface (code / prose / plan) is
a judgment the skill makes reading the issue; a verb that guessed it from file extensions would be
wrong exactly on the mixed PRs where the answer matters. `build check` takes the skill's answer as
`--surface` and validates it against the diff (a `--surface prose` run over a diff with no markdown
refuses) — an anchor, not a second classifier.

## Shared conventions

Every verb obeys these; stated once.

- **Answer channel: machine.** Stdout carries the answer and nothing else — JSON objects with
  named keys, or a line grammar, per verb. Scope lines, refusal reasons and progress go to stderr.
  A non-zero exit prints **nothing** on stdout (the `refuse` shape in `packages/fabrika-cli/src/verb.ts`): a partial answer
  beside a failure invites reading the bytes without the status.
- **Common inputs.** `--repo <owner/name>` (default: resolved from the `origin` remote). `--json`
  is the default and only output mode where a shape is JSON; line-grammar verbs say so. GitHub
  access per [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql)
  — the paginate half is what this group most depends on: a truncated page is the un-paginated scar
  it exists to close (#4926; v1's `per_page=100` comment reads in `stepR1-verdicts.sh`).
- **The content gate.** Every externally-authorable byte a verb returns — issue bodies, comments,
  PR bodies, review text — passes through one shared module,
  `packages/fabrika-cli/src/build/content-gate.ts`, before it reaches stdout. Today the gate is
  provenance-stamping pass-through, because the trust posture is an **open founder decision**
  (#4859). It exists so that ruling lands as **one module change**, fail-closed, covering
  forward/back-referenced content — not as an edit to five verbs. TOCTOU is handled by
  construction: no verb caches content across invocations; every invocation re-fetches and
  re-gates, so a gate change is in force on the next read.
- **Isolation preconditions are guarded identically wherever they apply.** `branch`, `commit`,
  `check`, `push`, `pr` and `pr-body` run the same tree assertions `tree` runs, with the same codes (`note` and
  `deviations` run only the posting guards — a stop-report must remain postable from a refused tree, and so
  must the disclosure a repair round owes) — a sibling that
  took the same ground unguarded would be the split this table exists to prevent.
  Their refusal messages are `tree`'s rows with the verb-name prefix substituted; **every error
  message contract-wide is prefixed with the invoked verb's name**, stated once here.
- **A non-zero exit is UNKNOWN** to the caller until the code is read. No verb prints a partial or
  permissive answer on a non-zero exit.
- **One deviant on the channel rule, carved out here so the shared section stays true:**
  `build push` puts its entire report on stdout, single-stream, so that the last stdout line is
  always the verdict line — the ordering guarantee is the contract (see its block; v1 documented
  this idiom and then shipped it on the wrong stream).

<a id="admission-test--scope-admission-and-the-audience-axis"></a>
### The admission test — scope admission composed with the audience axis, one module, two seams

**Four axes, composed — not one widened term.** What both seams run is an **admission test** built
from four separate questions, computed together and answered together:

- **Scope admission** — is the issue's home pinned by an `active` campaign? This is the term
  [ADR 0245](../../../../.decisions/0245-campaign-scope-fence-binds-both-seams.md) coins, and it
  names campaign membership and nothing else. Refusal is `20`.
- **The audience axis** — is the issue's `ready-for:` label `ready-for:agent`? This axis is older
  than the fence (#4780); `build pick` already carried it, and ADR 0245 asks for the scope axis to
  be added **beside** it, not folded into it. Refusal is `21`, and it binds a **build-purpose** claim
  only (see `build claim`'s `--purpose`, #5175) — and not even that one when the claim repairs an
  open PR whose served issue is `type:decision` (#5914).
- **The type axis** — is the deliverable a pull request an agent build lane produces? The four types
  that are (`type:feature` / `type:chore` / `type:bug` / `type:investigation`) are declared once in
  the same module, and `type:decision` and `type:epic` are not. Refusal is `30`. It binds a **fresh
  build** and nothing else: a `plan` or `gate` claim takes an epic by design (#5175), and a repair
  claim names a PR whose existence already answers the question. The rule is older than the axis —
  it lived in `build pick`'s private type set, where a number handed straight to `build claim` met
  no type check at all and an in-lane `type:decision` carrying `ready-for:agent` was admitted with
  no refusal (#5490).
- **The criteria axis** — does the body carry a readable `### Acceptance criteria` block, through the
  `wire/acceptance-criteria` read every seam shares? Refusal is `32`, on either of that read's two
  negative answers: `absent` (no heading reaches for the block) and `malformed` (one drifted). The two
  are kept apart on the outcome and route to different repairs — `triage enrich` authors a block that
  is absent, `triage repair-criteria` straightens one that drifted — but both refuse, because a
  heading off by one character is no more gradeable than no heading at all. It binds a **fresh build**
  and nothing else, for the type axis's two reasons plus one of its own: an epic's criteria arrive per
  child from the plan ledger (#6025), and a repair claim's branch cannot write an issue body. This
  rule is older than the axis too, and it leaked the same way the type rule did — it lived as
  `build pick`'s private read, so `build issue <n>` built a no-AC issue the pool would have refused
  and `review criteria` was the first thing to catch it, a whole lane later (#6554).

**Keep the names apart.** *Scope admission* is a different question from the audience axis (who
the work is for), from dependency eligibility (`build eligible` asks whether an issue's `blocked_by`
blockers are done), from priority (a home confers no band, ADR 0219), and from the milestone pick-order
tiebreaker (ADR 0072) — the same not-this list ADR 0245 draws. Among admitted issues the ranking is
unchanged, and a scope refusal never reads as blocked: `16` belongs to blockedness at every seam
that answers it — `build eligible`, and the gate `build claim` and `build pick` run *after* this
test (ADR 0301) — and no scope outcome borrows it. This section is the term ADR 0245 asks this
contract to carry, at exactly the width the ADR gives it; the composition with the audience axis is
stated here so no reader has to infer that the coined term swallowed a second question.

**One module, two call sites.** All four axes are evaluated in exactly one place —
`packages/fabrika-cli/src/build/scope-admission.ts` — and that module is **imported** by `build pick`
and `build claim`. Neither seam re-derives either axis, and no verb exists whose only behaviour is
relaying them (the wrapper shape ADR 0238 bans). A second implementation is banned outright: a board
where the picker and the claim step disagree about what is admissible is worse than no fence at all.
The file is named for the axis this contract adds; it **hosts** the audience and criteria axes rather
than redefining them, and the four axes stay separately named, separately seated and separately
reported everywhere the module is consumed.

**Both seams, because the pool filter alone has a hole.** Filtering the offered pool is the browse
path. An operator can hand a verb an issue number directly, and a directly-handed number passes
through no pool — so the claim seam runs the same predicate before it writes any marker. Dropping
either one is a hole: without the claim refusal the direct handoff is unfenced, without the pool
filter every off-campaign issue is still offered and the refusal only arrives after an agent has
chosen.

**That argument covers the type rule too, and #5490 is what it cost to leave it uncovered.** The
type set was the pool's own constant, so the claim seam could not see it and the audience axis was
doing the type rule's job by coincidence — a `type:decision` was refused because triage happens to
route decisions to `ready-for:human`, not because it is a decision. Where that coincidence did not
hold the claim was simply admitted, and where it did the refusal named the wrong objection: an
operator sent to fix `audience-not-agent` would re-label the issue `ready-for:agent`, satisfy the
fence, and build the wrong artifact. So the type axis sits in the module with the other two, and
refusals are reported **scope, then type, then audience, then criteria** — the order an operator's
remedies run in. #6554 is the second instalment of the same bill and cost the same thing: the
criteria read was the pool's own, so a number handed straight to `build claim` met no criteria check,
built end to end, and failed a review gate no branch could repair.

**The type axis has one arm, and a citation is the only thing that opens it.** A `type:decision`
whose choice a founder has already recorded on the issue is buildable, because the deliverable is
then transcription rather than judgement (founder ruling on
[#5879, comment 5335398768](https://github.com/kamp-us/phoenix/issues/5879#issuecomment-5335398768)).
`build claim --cites <url>` names that ruling comment, in the grammar
`https://github.com/<owner>/<repo>/issues/<n>#issuecomment-<comment-id>`, and the verb refuses a URL
that names another repository or another issue — a ruling recorded elsewhere opens nothing here. It
is **not an override**: an override admits a proven refusal, while a citation says the refusal does
not apply, so a type refusal is not on the overridable set at all. What the verb can check is the
pointer's shape and its target; whether that comment rules anything is the reader's judgement and is
stated as such. `type:epic` has no arm — its deliverable is a ledger no citation turns into a pull
request, and the remedy is `--purpose plan` or `--purpose gate`. The arm opens the type axis and
nothing else: the issue still has to carry `ready-for:agent`, which triage stamps at intake and
`fabrika decision rule <n> --cites <url>` stamps afterwards, so a `ready-for:human` decision with a
perfect citation is still `21` until one of them has run.

**The inputs, and where each is read.**

- **The active campaigns** — the `## Campaigns` section of the file this repo declares as
  `roadmapFile` in `.fabrika.jsonc`, which defaults to `ROADMAP.md` at the repo root. Its
  grammar is canonical here, so an implementer needs no other document:

  ```
  | Campaign             | Milestone | State  |
  |----------------------|-----------|--------|
  | fabrika fast follows | #46       | active |
  | Taste-Skill Library  | #42       | paused |
  | switching to fabrika | #45       | done   |
  ```

  The fence reads the **set** of milestones the `active` rows pin — campaigns run concurrently, so
  several may be active at once. `Campaign` is a non-empty name, `Milestone` is `#<int>`, and `State`
  is one of `active` / `paused` / `done`: a campaign's state cell **is** the dispatch permission
  (ADR [0304](../../../../.decisions/0304-campaign-active-is-the-dispatch-permission.md), which
  retired the separate `## Focus` surface ADR 0298 governed). A **missing section, an empty table,
  and a table whose every row is `paused` or `done` are the same well-formed default** — nothing is
  active, the fence is off. A milestone cell that is not `#<int>`, a state outside the three, an
  empty name, or a row without exactly three cells is **malformed** (`4`) **for the whole table** —
  never a partial read of the rows that parsed — and malformed is never read as "nothing is active".
- **The subject** — *which* record the two axes read. An issue is its own subject. A **pull request
  is not**: it carries no milestone and no `ready-for:` label, so a test reading the PR's own record
  refused every repair claim while any campaign was active ([#5562](https://github.com/kamp-us/phoenix/issues/5562)).
  A PR resolves to the issue its lane serves — the first closing keyword in its body, else `Part of
  #<n>`, the same reference `review scope` reads — and **both** axes then read that issue. A PR whose
  body names no readable issue is `refused: no-served-issue` while any campaign is active (`20`, and
  overridable like any scope refusal): the fence cannot judge a ticket nobody named, and admitting it
  would let a lane past the fence by omitting one line from a body. **The resolution runs whether or
  not a campaign is active** — the audience axis reads the served issue either way — and only the
  scope refusal is gated on one: while the fence is inert a PR naming no readable issue
  falls back to its own record instead of refusing. A served issue that **cannot be read** is
  `unknown` at either setting (`11`, and not overridable), which is the `unknown` row below.
- **The issue's home** — the number of the open milestone the issue is homed in, as a string; or, for
  an issue carrying a standing-lane label, that label.
- **The issue's audience** — its `ready-for:` label.

**The outcomes — state words, never a boolean.** The admission test returns exactly one across all
four axes, and every refusal carries its reason and names which axis refused:

| Outcome | Trigger | Seat |
|---|---|---|
| `admitted` | an `active` campaign pins the issue's home; or the issue carries a standing-lane label; or no campaign is active | kept in the pool · the claim proceeds |
| `refused: out-of-scope` | some campaign is active, the issue's home is a milestone none of them pins or no milestone, and no standing-lane label exempts it | `20` |
| `refused: no-served-issue` | some campaign is active and the target is a pull request whose body names no readable issue — neither a closing keyword nor `Part of #<n>`, or one naming an issue proven absent | `20` |
| `refused: audience-not-agent` | the issue carries a `ready-for:` label other than `ready-for:agent`, or carries none at all — absence is an unknown audience, never an agent audience (#4780) | `21` |
| `refused: no-acceptance-criteria` | the body carries no readable `### Acceptance criteria` block — the wire read answers `absent` (no heading reaches for it) or `malformed` (one drifted), and the outcome carries which — on a claim the criteria axis binds, a fresh build and nothing else (#6554) | `32` |
| `unknown` | the campaigns table or the issue's home could not be read (`11`), or any of its rows is malformed (`4`) | `11` / `4` |

**Each refusal is separately named and separately seated**, never one collapsed "refused": they come
from different axes, they have different remedies (flip the campaign's state cell, re-label the
audience, or author the missing criteria block), and the per-issue exclusion reason `build pick`
reports is derivable only if the outcome set keeps them apart.

**The standing-lane exemption, named.** Exactly two labels — `wayfinder:backlog` and
`axis:pipeline-hardening` (ADR 0208) — are **admitted on the scope axis whatever the table says**, and carrying no milestone is not an exclusion for them. A standing lane is milestone-less by
design, so a fence keyed on milestone-presence alone would starve it. The exemption is the label
match and nothing else: bare milestone-absence never confers it, and no third label inherits it
without a founder ruling. The audience axis still applies to a standing-lane issue.

**Nothing active ⇒ inert and visible, never a refusal.** With no campaign `active`, every issue is
admitted on the scope axis and **both seams say so on their scope line**: `campaigns: none active —
scope fence inert`. Running no campaign is the off switch, and pausing every one of them is not a
board freeze; a fence that refused on absence would wedge the pipeline the moment nobody was running
a campaign, and an operator must be able to see from the run that the fence is off rather than infer
it from an unshortened pool.

**Unreadable ⇒ UNKNOWN, never admitted.** A table that cannot be read, and an issue whose home
cannot be resolved, are `11`; a declaration that reads but does not parse is `4`. Neither ever
resolves `admitted`, and neither borrows `20`/`21` — a fence that could not read its input has proven
nothing, while `20` and `21` are proven refusals. Nor does a scope refusal borrow `11`. No new code
is minted for "the read failed": the matrix already owns that meaning at `11`, and one meaning on two
codes is the drift the matrix exists to prevent.

**The override — explicit at the call, recorded on the issue.** `build claim --override "<reason>"
--override-lane "<lane>"` admits an issue the predicate refused, and writes **both** fields — the
lane and the reason — into the claim marker it posts, so the escape hatch costs one deliberate act
and names who took it; a silent or unattributed override is not one. The two flags are required
together (the `claim` block below): either one alone is a usage error, not a claim. **`build
pick` takes no override**: the pool is the browse path, and an operator who means to work an
out-of-scope issue names its number and overrides where the lane actually opens. **`build confirm`
and `build release` never run the fence** — it decides what may *start*, so a campaign paused
mid-lane must never strand a lane already running, and a release must never be gated on it.

### The shared exit matrix

The one table every `build` verb allocates from — this matrix owns `code → meaning`; each verb's
block below enumerates only **that verb's own reachable proven outcomes** with their triggers, and
its `--help` restates them. `0`, `1`, `126` and `127` are the interface convention's reserved codes
(`packages/fabrika-cli/src/verb.ts`, the exit-2 bootstrap in `packages/fabrika-cli/src/bin.ts`): every verb can also return those four, and
they are stated only here.

**Alignment with the shipped `report`/`triage` tables is deliberate and code-for-code over
`3`–`11`** (`packages/fabrika-cli/src/report/codes.ts`, `packages/fabrika-cli/src/triage/codes.ts`):
a caller driving `report`, `triage` and `build` in one sweep reads one meaning per code.
**`12`+ diverges from `triage` by design** — `triage`'s `12`/`13` are `HUMAN_FILED`/`UNCONFIRMED`,
outcomes no `build` verb can produce; the alignment doctrine spans the overlap, not the whole
range, exactly as `triage/codes.ts` itself states for `adr`.

| Code | Meaning |
|---|---|
| `0` | the answer is on stdout |
| `1` | usage error, or the verb failed to run |
| `126` | no implementation could be resolved (`packages/fabrika-cli/src/bin.ts`) |
| `3` | stdin was read and held nothing |
| `4` | a required section is missing, malformed, empty, or out of place — in an authored body, or in a document a verb derives from |
| `5` | the authored text carries a machine-local path, unredacted |
| `6` | the authored text is a bare `@` path reference — not redactable |
| `7` | zero scope: the target is **proven** absent (404) or closed, the vocabulary judged against is empty, or there is nothing to judge |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN, deliberately not `1` (it may or may not have landed) |
| `9` | the write landed but the read-back does not match; the artifact exists and needs a human |
| `10` | a value off its closed vocabulary, or a classification claim where none is permitted (a non-kebab slug, an off-enum surface, a §CP claim in a body) — a semantic refusal, never a malformed-flag usage error, which is `1` |
| `11` | a required read or validator execution failed — nothing was written, no outcome is proven |
| `12` | **retired, left empty** — it meant "not in a linked worktree" until the 2026-08-13 ruling on #5386 dropped fabrika's isolation opinion; nothing is renumbered into it |
| `13` | proven: the tree was dirty at a `--require-clean` open |
| `14` | proven: the checked-out branch does not belong to this lane's claim |
| `15` | proven: this session does not hold the claim — lost, foreign, or none exists at all; the detail is on stderr |
| `16` | proven: the issue is blocked — every open `blocked_by` edge is named on stderr |
| `17` | proven: the push completed but the remote ref did not move |
| `18` | proven: this tree's validation is red |
| `19` | refused: the requested push is unsafe (detached HEAD, or a non-fast-forward without `--force-with-lease`) |
| `20` | proven: not admitted on the scope axis, out of scope — the issue's home is pinned by no `active` campaign and no standing-lane label exempts it |
| `21` | proven: not admitted on the audience axis, audience not agent — the issue's `ready-for:` label is not `ready-for:agent`, or is absent |
| `22` | proven: every changed file falls outside every surface's validators — there is nothing to run, so the verdict is a refusal, never a green |
| `23` | proven: the local head does not contain the published remote head — the push would drop its commits |
| `24` | proven: `git commit` ran and HEAD did not move — no commit was created |
| `30` | proven: not admitted on the type axis — the issue is `type:decision` or `type:epic`, whose deliverable is not a pull request a build lane produces |
| `31` | proven: the claim's mode and the child's standing range verdict disagree — a fresh build over a child holding a `FAIL`, or a `--resume` over a child holding none |
| `32` | proven: not admitted on the criteria axis — the issue body carries no readable `### Acceptance criteria` block, absent or malformed, so there is no contract to build against |
| `127` | the verb never ran at all (unresolved binary — the shell's code, not this process's) |

**`7` versus `11` is the split the whole group rests on** (the `wire` group's `ABSENT` vs
`ARTIFACT_UNKNOWN` distinction, `packages/fabrika-cli/src/wire/codes.ts`): a 404 is a verdict about the repository; a
5xx or timeout is a verdict about nothing. No verb fuses them, and no error message is worded
"does not exist, or is not readable".

---

## `build tree`

**Invocation**

```
fabrika build tree [--require-clean] [--issue <n> [--repair <pr>]]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--require-clean` | boolean | no | `false` | additionally refuse a tree with any uncommitted change — the lane-open posture |
| `--issue` | integer | no | — | additionally prove the checked-out branch serves this issue — the pre-mutation posture |
| `--repair` | integer | no | — | with `--issue`, prove this repair PR's claim, resumed branch and unique served-issue linkage as one relationship |

**Output** — machine. With neither `--issue` nor `--repair`, one line containing the tree root's
absolute path. With `--issue`, one JSON object:
`{"answer":"proven","root":"<absolute>","branch":"<name>","claim":{"number":<issue-or-pr>,"nonce":"<nonce>"},"servedIssue":{"number":<issue>,"kind":"issue|fixes|part-of"}}`.
A fresh proof puts the issue number in both `claim.number` and `servedIssue.number`, with kind
`issue`. A repair proof puts the PR in `claim.number`, the issue in `servedIssue.number`, and the
live PR body's unique winning reference kind in `servedIssue.kind`. This is the whole successful
repair answer; the skill consumes this object, never a scope line or incidental diagnostic.

This verb **reads and never repairs**: it creates nothing, cleans nothing, removes nothing. It also
asserts nothing about *where* the tree is — that is the operator's call, not fabrika's (#5386).

The assertions:

1. **Clean at open** (`--require-clean`) — any uncommitted change is `13`. A fresh tree carrying
   an unauthored hunk is not yours to keep *or* to clean (#2666).
2. **Fresh lane** (`--issue`, without `--repair`) — the checked-out create branch names that issue
   and carries that issue's winning claim nonce. A non-lane, wrong-number, or nonce mismatch is `14`.
3. **Repair lane** (`--issue <n> --repair <pr>`) — one fail-closed flow proves all subjects: the
   checked-out resume branch names `<pr>`; its nonce owns `<pr>`'s winning claim; the live, open PR
   names exactly one issue through the same closing-keyword/`Part of` grammar review reads; that issue
   is `<n>`, is live and readable, and is an issue rather than another pull request. The PR is never passed as the issue operand, the issue is never
   queried for the repair claim, and no branch number is guessed into a served issue.

**The branch's own nonce is the identity the claim is read under** — the question is whether the
winning marker belongs to THIS lane, not to this session (#6037). A sibling lane of the same session
is `14`; only another session's claim is `15`. No stamp file exists to check.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the PR body names zero or several served issues — no unique repair subject |
| `7` | the repair PR or its uniquely linked served issue is proven absent or closed |
| `10` | `--repair` was given without its required `--issue` operand |
| `11` | the tree root, claim state, repair PR, or linked served issue could not be read — UNKNOWN |
| `13` | proven: uncommitted changes present at a `--require-clean` open |
| `14` | proven: non-lane/wrong-number branch, nonce mismatch, wrong repair PR branch, or PR linked to an issue other than `--issue` |
| `15` | proven: the issue claim in fresh mode or PR claim in repair mode is held by another session |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build tree: cannot read the tree root: <reason> — the ground is UNKNOWN.` | 11 | refusal |
| `build tree: <n> uncommitted change(s) at open — refusing; an unauthored hunk is not yours to keep or clean.` | 13 | refusal |
| `build tree: --repair <pr> requires --issue <n>.` | 10 | refusal |
| `build tree: the checked-out branch "<name>" is not a lane branch — wrong lane.` | 14 | refusal |
| `build tree: the checked-out branch "<name>" names claim #<actual>, not issue #<n>|repair PR #<pr> — wrong lane.` | 14 | refusal |
| `build tree: the checked-out branch "<name>" does not carry claim <token>'s nonce — wrong lane.` | 14 | refusal |
| `build tree: cannot read the claim markers on #<n>: <reason> — the lane is UNKNOWN.` | 11 | refusal |
| `build tree: #<n> is held by <winning token>, not by the lane on nonce <nonce>.` | 15 | refusal |
| `build tree: cannot read repair PR #<pr>: <reason> — its served issue is UNKNOWN; nothing is proven.` | 11 | refusal |
| `build tree: PR #<pr> is proven absent or closed.` | 7 | refusal |
| `build tree: repair PR #<pr> names <count> served issues through <kind>; exactly one is required, so the repair subject is not uniquely readable.` | 4 | refusal |
| `build tree: repair PR #<pr> serves issue #<actual>, not requested issue #<n> — wrong lane.` | 14 | refusal |
| `build tree: cannot read issue #<n>, which repair PR #<pr> serves: <reason> — the repair subject is UNKNOWN; nothing is proven.` | 11 | refusal |
| `build tree: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build tree: repair PR #<pr> links #<n>, but that record is itself a pull request, not the served issue — wrong lane.` | 14 | refusal |

**Scope** — not a judging verb: it reads this process's git state, one claim, and in repair the live
PR plus its one served issue.

**Examples**

```
$ fabrika build tree --require-clean
/private/var/<redacted>/lanes/build-4312
```

```
$ fabrika build tree --issue 4312
{"answer":"proven","root":"/private/var/<redacted>/lanes/build-4312","branch":"build/4312-editor-focus-loss-c1a4d6f8","claim":{"number":4312,"nonce":"c1a4d6f8"},"servedIssue":{"number":4312,"kind":"issue"}}
```

```
$ fabrika build tree --issue 7181 --repair 7182
{"answer":"proven","root":"/private/var/<redacted>/lanes/repair-7182","branch":"build/pr-7182-c1a4d6f8","claim":{"number":7182,"nonce":"c1a4d6f8"},"servedIssue":{"number":7181,"kind":"fixes"}}
```

```
$ fabrika build tree --require-clean
build tree: 2 uncommitted change(s) at open — refusing; an unauthored hunk is not yours to keep or clean.
$ echo $?
13
```

**Grounding**

- #2666 — the dirty fresh tree; refused, never cleaned.
- #4500 — eight trees under one stamp; the nonce comparison has no stamp to duplicate.
- #4162 — the cwd resets between shell calls, so the skill re-runs this verb before every git
  mutation: a pass is a fact about this invocation and nothing later.
- #7183 — a repair branch carries a PR claim nonce while its contract belongs to a distinct issue;
  the repair proof binds both subjects instead of weakening either one.
- 2026-08-13 ruling on #5386 — fabrika holds no worktree opinion; `12` is retired and this verb
  asserts nothing about where the tree sits.

---

## `build pick`

**Invocation**

```
fabrika build pick [--repo <owner/name>] [--limit <n>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository whose issue board is read |
| `--limit` | integer | no | `20` | maximum candidates to emit, after ranking |

**Output** — machine. One JSON object:
`{"pool": [...], "excluded": {...}, "scanned": {"p0": n, "p1": n, "p2": n}, "campaigns": {...}}`.
Each pool entry: `{"number", "title", "priority", "type", "home"}` — `home` is the open
milestone's number as a string, or the standing-lane label (`wayfinder:backlog` /
`axis:pipeline-hardening`) for a lane-exempt issue. Ranked `p0` → `p1` → `p2`, milestone order
within a bucket. **An empty pool is a fact and prints `{"pool": [], ...}` on exit
0** with the scanned counts proving what was searched — never an empty stdout (interface
convention rule 2).

**Every exclusion is reported with its reason**, so a shortened or empty pool is auditable
from the answer itself rather than only from the counts. `excluded` is a **reason histogram** —
`{"audience-not-agent": 155, "out-of-scope": 111}`, one key per reason that refused at least one
issue, its value the count — keys ordered count-descending, ties on the reason, so the same board
always prints the same bytes. (Those two counts are the #5641 measurement, taken before #6325
renamed the reason `out-of-focus` to `out-of-scope`; the key is the current one, the numbers are
the older board.) A reason is one of `out-of-scope` / `audience-not-agent` /
`no-acceptance-criteria` / `unreadable` — the outcome set of the [admission test](#admission-test--scope-admission-and-the-audience-axis),
one reason per outcome — or `blocked`, this verb's own axis (below).
The scanned counts alone cannot tell a working fence from a broken one; the reasons can, and the
reason vocabulary is the whole of what a reader acts on — no skill reads a per-issue row, so the
rows collapse to counts under ADR 0308 (`excluded` is an evidence-array, `pool` the answer-array
`--limit` caps). `campaigns` is
`{"state": "declared", "milestones": ["44", "46"]}` or `{"state": "none"}`, the same fact the stderr
scope line carries.

The filter, fail-closed on every axis:

- `status:triaged` present, `status:` nothing-else;
- **admitted by the shared admission test** imported from
  `packages/fabrika-cli/src/build/scope-admission.ts` — this verb re-derives nothing. The test
  composes two axes: **scope admission** (an issue whose home no `active` campaign pins is
  excluded, with the two standing-lane labels — `wayfinder:backlog` and `axis:pipeline-hardening` —
  admitted whatever the declaration says, because a standing lane is milestone-less by design and a
  milestone-presence fence would starve it) and the pre-existing **audience axis** (`ready-for:agent`
  present; an issue with no `ready-for:` label is excluded, since absence is an unknown audience,
  never an agent audience — #4780, the negative test the brief's acceptance criterion names). With
  **no campaign active** the scope axis admits everything and the fence is reported inert on the scope line and
  in `campaigns`; a **failed read of the table** makes the whole pool `11`, never an unfiltered
  pool — an unfiltered pool on a failed read is the fail-open shape the fence exists to remove. An
  individual issue whose home the listing named but the repository does not resolve is excluded with
  reason `unreadable`, never admitted. This verb takes **no override**: overriding happens at
  `build claim`, where the lane actually opens.
- **unassigned.** Any assignee excludes — assignment is the one attribute that keeps a human's
  document out of this pool (#4764, #4693).
- `type:` is one of `feature` / `chore` / `bug` / `investigation`. `type:decision` and `type:epic`
  never enter *this pool*, which is narrower than never being built: a decision issue carrying a
  founder ruling comment is buildable as transcription and is entered by number at `build claim`
  (ADR [0300](../../../../.decisions/0300-a-cited-ruling-makes-a-decision-buildable.md)), never
  picked — a blind pick has no ruling to cite, which is why the exclusion here stands. A
  rendered-visual deliverable is excluded by the *skill* at reading time, not by this verb, because
  modality is not a label.
- **a body carrying an acceptance-criteria block the wire reader answers `Found` on** — the
  admission test's **criteria axis**, not this verb's own. A candidate with no contract can only fail
  at `review criteria`, once a branch, a build, a push, a PR and a CI run are already spent, and
  neither the builder nor the reviewer can repair it — so the pool excludes it with reason
  `no-acceptance-criteria`, and the body travels on the listing read the filter already performs,
  costing no second call. The axis used to be this verb's own, which is what made it no fence: a
  number handed straight to `build claim` passes through no pool, so the same no-AC issue reached
  construction by number and the review gate was the first thing to catch it
  ([#6554](https://github.com/kamp-us/phoenix/issues/6554)). It binds a **fresh build** only — a
  `plan` or `gate` claim targets an epic, whose criteria arrive per child from the plan ledger
  ([#6025](https://github.com/kamp-us/phoenix/issues/6025)), and a repair claim names a PR whose
  branch cannot repair an issue body. The matching refusal at the stamp is `triage apply`'s `16`.
- **no open `blocked_by` edge**, read off GitHub's native graph and nothing else (ADR 0301) through
  the same `packages/fabrika-cli/src/build/blockedness.ts` reader `build eligible` uses. A candidate
  with any blocker still open is excluded with reason `blocked`, and one whose edge list could not
  be read is excluded with reason `unreadable` and the failure named on stderr — a candidate whose
  blockedness is UNKNOWN is never offered. This axis runs **last**, because it is the only one that
  costs a network call: the admission test and the criteria block are both answered off facts the
  listing already returned, so a candidate they exclude is never paid for here. It replaces the
  retired `status:blocked` label, which this filter only ever dropped as a side effect of the
  one-`status:`-label rule above, printing no reason at all.
- open, and not a pull request.

**Every bucket read paginates, and a failed bucket read fails the verb.** v1's candidate pool
printed nothing for a failed bucket and kept going — a gh 5xx on the p0 bucket silently read as
"no p0s" (`step1-candidate-pool.sh:12-13`, its own header admits it; #4926 is the pagination
half). Here either every bucket was read in full or the answer is `11`.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the `## Campaigns` table reads but does not parse — a non-`#<int>` milestone, a state outside `active`/`paused`/`done`, an empty name, or a row without three cells; the pool is UNKNOWN, never unfiltered |
| `11` | any bucket read failed or came back truncated, or the campaigns table could not be read — the pool is UNKNOWN, never partial and never unfiltered |

A malformed `--limit` is a plain usage error: `1`, per the reserved table. `20` and `21` are **not**
reachable here: a scope refusal on the browse path is an exclusion with a reason, not the verb's
verdict — the pool still answers on `0`. Those two codes are the claim seam's.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build pick: cannot read the <bucket> bucket: <reason> — the pool is UNKNOWN, never partial.` | 11 | refusal |
| `build pick: cannot read the "## Campaigns" table: <reason> — the pool is UNKNOWN, never unfiltered.` | 11 | refusal |
| `build pick: the "## Campaigns" table does not parse: <detail> — the pool is UNKNOWN, and a malformed table is never read as "nothing is active".` | 4 | refusal |
| `build pick: --limit "<value>" is not a positive integer.` | 1 | usage error |

**Scope** — every open issue in `--repo` carrying `status:triaged`, read via paginated REST, judged
against the active campaigns. The scope line on stderr names the per-bucket counts scanned **and the
table's state** — `campaigns: 1 active — fabrika fast follows (#46)`, `campaigns: 2 active — fabrika fast follows (#46), fabrika everywhere (#47)`, or `campaigns: none active — scope fence inert` —
so an empty pool is auditable and a fence that is off is visible as off rather than inferred.

**Examples**

```
$ fabrika build pick
{"pool":[{"number":4312,"title":"Editor loses focus after save","priority":"p1","type":"bug","home":"44"},{"number":4488,"title":"Prune the dead lane stamps","priority":"p2","type":"chore","home":"axis:pipeline-hardening"}],"excluded":{"audience-not-agent":1,"out-of-scope":1},"scanned":{"p0":0,"p1":3,"p2":41},"campaigns":{"state":"active","milestones":["44"]}}
```

The standing-lane row is the exemption at work: #4488 carries no milestone and is admitted anyway,
while the issue homed in milestone 39 is the histogram's one `out-of-scope`. With no declaration the
fence is inert, and both the answer and the scope line say so — the same #4290 is in the pool:

```
$ fabrika build pick
build pick: scanned p0=0 p1=3 p2=41 · campaigns: none active — scope fence inert
{"pool":[{"number":4290,"title":"Retire the legacy importer","priority":"p2","type":"chore","home":"39"}],"excluded":{},"scanned":{"p0":0,"p1":3,"p2":41},"campaigns":{"state":"none"}}
```

```
$ fabrika build pick --limit 0
build pick: --limit "0" is not a positive integer.
$ echo $?
1
```

**Grounding**

- #4780 — `ready-for:agent` fail-closed; absence is an unknown audience. Negative test required.
- #4764 / #4693 — assigned means not pickable; 17 authoring briefs were protected only by an
  advisory before this rule.
- #4926 — v1's pool truncated at 100 per bucket, unpaginated.
- `step1-candidate-pool.sh` scar — a failed bucket read fail-opened to an empty bucket; here `11`.
- ADR 0092 — the scanned counts on stderr are the zero-scope audit trail.
- ADR 0245 / #5011 — the scope axis, and the rule that a pool filter alone is advice, not a fence.
- ADR 0208 — the standing-lane exemption is exactly two labels; milestone-absence never confers it.
- #5013 — the per-issue exclusion reason: scanned counts cannot separate a working fence from a
  broken one.

---

## `build eligible`

**Invocation**

```
fabrika build eligible 4312 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue whose dependency gate is derived |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository read |

**Output** — machine. On `eligible`: one JSON object
`{"answer": "eligible", "number": 4312, "parent": 4300}` (`parent` is `null` for a standalone
issue). Blocked and unknown produce no stdout — they are exits `16` and `11`.

**The source of blockedness is GitHub's native `blocked_by` graph, and there is no second one**
(#5387, ADR 0301, delivered by #5913). The verb reads the issue's own `blocked_by` list and the
state of every blocker it names: a blocker still open is a block, and **every** blocking edge is
named on stderr (#4244, #4920) — a lane learns everything it waits on from one call, not one edge
per call. A `blocked_by` entry is not a block on its own, because the endpoint lists every blocker
whatever its state; the "any blocker still open" derivation lives in the reader
(`packages/fabrika-cli/src/build/blockedness.ts`), which is the one module every seam answering this
question reads through.

**The epic ledger's prose `## Dependencies` block is not an input.** It is a human-readable
rendering of the ledger's shape and nothing parses it to decide whether work may start — a label is
a claim, a prose block is a rendering, the graph is the fact. `build check --surface plan`,
`ledger topology` and the epic machine emitter still read that block for planning and sequencing;
none of them answers eligibility.

**The edges are the issue's own, so a standalone issue is gated exactly like an epic child.** The
parent epic is still resolved (three-way — parent found / proven standalone / unreadable), because
the assembly-branch discharge below is named from it and the answer carries it.

**A blocker is discharged from two sources, and the second one is git** (#6063). It is
discharged when its issue is closed **or** when the parent epic's assembly branch, `epic/<parent>`,
carries a commit whose message names it. Under ADR 0285 an epic run is one branch and one PR, so no
child issue closes until the tail PR merges — reading only the closed state would make every
later-phase child of a run in flight permanently blocked, on a gate that cannot be satisfied
before the epic it blocks has shipped. The branch name is derived from the parent's number, never
taken from a caller, and the message is read with the same `#<n>` rule `build commit` and
`lane prove` use.

**"Carries" is the run's own commits, and the range is stated in every line the verb prints**:
`<merge base with the trunk>..epic/<parent>`, the two-dot shape `lane prove` locates a child's range
with, where the trunk is `origin/<the repo's default branch>`. Not everything reachable from the
branch tip — that set is the whole trunk history the branch was cut from, and since the `#<n>` rule
matches a bare mention anywhere in a message, an old commit writing "blocked on #<n>" would
discharge an edge whose work was never built.

The second source only ever discharges, and only on evidence it read: a branch this tree does not
carry, a trunk this repo would not name, no merge base, or a git read that failed, leaves every edge
exactly as the board gave it — `16` for an open one, `11` for an unread one — and names the unread
branch on stderr. The branch is read only when at least one edge is still undischarged **and** the
issue has a parent, so a standalone issue and a child whose blockers are all closed make no git call
at all.

**Every read fails closed, on every axis** (ADR 0092). An edge list that could not be read is `11`,
never "no edges, so not blocked" — including a `404` on the list of an issue this verb has already
proven open, which is an unexplained answer rather than an empty one. A blocker the token cannot see
counts open, never discharged.

**Every blocker is read before the answer is seated**, so the answer never depends on the order the
graph lists them in. A blocker whose state could not be read is its **own reported row** on stderr,
never counted closed: beside a *proven* open edge it leaves the verdict `16` (one proven open edge
is proof of blockedness whatever else was unreadable) and is named there so the edge list is not
read as complete; with nothing proven open it is `11`, because the blocking set is only complete
when every blocker's state is known.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the issue is proven absent (404) or closed |
| `11` | the issue, its parent, its `blocked_by` list, or any blocker could not be read — eligibility is UNKNOWN |
| `16` | proven blocked — an open blocker no commit in `<base>..epic/<parent>` discharges, named on stderr |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build eligible: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build eligible: cannot read <what>: <reason> — eligibility is UNKNOWN, never "eligible".` | 11 | refusal |
| `build eligible: <n> blockers could not be read — eligibility is UNKNOWN, never "eligible".` | 11 | refusal |
| `build eligible: cannot read blocker #<m>: <reason> — its state is UNKNOWN, never counted closed.` | 11 or 16 | detail line, one per unread blocker |
| `build eligible: blocked by <n> open blocked_by edges: #<m>, #<k>.` | 16 | refusal |
| `build eligible: origin/<trunk>..epic/<p> adds a commit naming #<m> — that work landed on the epic run's assembly branch, so the edge is discharged whatever the board says about the issue (ADR 0285).` | 0, 11 or 16 | detail line, once |
| `build eligible: origin/<trunk>..epic/<p> adds <n> commit(s), none naming an undischarged blocker.` | 11 or 16 | detail line, once |
| `build eligible: cannot read epic/<p> in this tree: <reason> — no edge is counted discharged off it, and every edge keeps the state the board gave it.` (`<reason>` also covers an unnameable trunk and an absent merge base — the range's other two endpoints) | 11 or 16 | detail line, once |

**Scope** — one issue, its parent (if any), every blocker its `blocked_by` list names, and —
only when an edge is still undischarged — `epic/<parent>` in this tree.
The scope line on stderr counts the edges checked, so `eligible` is readable as "N edges, all
closed", never as "no edges found". An edge whose state could not be read is subtracted from that
claim by its own stderr row, so "all closed" is never asserted over an edge nobody could see.

**Examples**

```
$ fabrika build eligible 4312
build eligible: scanned 0 blocked_by edges; standalone.
{"answer":"eligible","number":4312,"parent":null}
```

```
$ fabrika build eligible 4319
build eligible: scanned 2 blocked_by edges; parent #4300.
build eligible: blocked by 2 open blocked_by edges: #4310, #4311.
$ echo $?
16
```

```
$ fabrika build eligible 4321
build eligible: scanned 2 blocked_by edges; parent #4300.
build eligible: cannot read blocker #4310: gh: Bad gateway (HTTP 502) — its state is UNKNOWN, never counted closed.
build eligible: blocked by 1 open blocked_by edge: #4311.
$ echo $?
16
```

```
$ fabrika build eligible 6007
build eligible: scanned 1 blocked_by edge; parent #5817.
build eligible: origin/main..epic/5817 adds a commit naming #6004 — that work landed on the epic run's assembly branch, so the edge is discharged whatever the board says about the issue (ADR 0285).
{"answer":"eligible","number":6007,"parent":5817}
$ echo $?
0
```

**Grounding**

- #5387 / ADR 0301 — one carrier for blockedness. The founder ruled that every dependency in
  fabrika sits behind GitHub's native `blocked_by` edges and that a prose dependency block is at
  most a rendering of them, never a parsed input. #5913 is the `build eligible` half of that
  migration; the claim-seam gate and the `build pick` exclusion reason follow in #6249, over the
  same reader this verb introduced.
- #4244 — lane entry must refuse while a blocker is open.
- #6063 — inside a one-PR epic run every blocker issue is open by design (ADR 0285), so the
  closed-state proxy made the gate structurally unsatisfiable: no child could become eligible before
  the epic shipped, and no epic could ship before its children built. The fix is the second
  discharge source, reading the assembly branch the way `lane prove` already reads a child's range —
  never a skip of the gate, and never a discharge off the lane's own fold (ADR 0283). Its review
  round then bounded that read to the run's own commits: an unbounded walk let a `#<n>` written
  anywhere in the trunk's history discharge an edge, which is the same fail-open by another route.
- #4920 — the eligibility question needed a verb; prose-derived blockedness was re-derived
  differently per session. Its acceptance also fixes two properties of the answer: a `blocked`
  refusal names **every** open edge, and every unreadable input on the path is `11` with a test
  pinning it, so no read failure anywhere can resolve to "eligible".
- #4104 — `status:planned` children invisible to a label-driven picker; graph-derived here.
- ADR 0092 — an unreadable blocker is `11`, never a pass.

---

## `build claim`, `build confirm`, `build release`, `build adopt`

One protocol, three verbs. The claim is a comment-marker race on the issue (the ADR 0115 shape,
re-implemented): post a claim marker carrying the session's token, re-read the issue's markers,
and the earliest authorized marker wins. **Authorization is ACL-checked** — the marker's *author*
is resolved against repository permissions (the ADR 0055 idiom); the marker's *text* confers
nothing. The token is `build:<session-id>:<uuid>` — one shape, pinned, because v1 left the token
shape ambiguous between comment ids and session ids and callers guessed (#4428).

**Ownership turns on the whole token, never the session id.** One driver session runs several
builder lanes at once and each mints its own token, so a session id names every lane of that session
at once: under the session-only rule the second lane read the first lane's marker as its own, was
answered `won` with a nonce that held nothing, and both lanes ran and pushed one repair (#6037).
`claim` therefore resolves the race against the token it just minted, and `confirm` / `release` —
and `branch`, `scratch`, `note` — against a `--token` the caller threads through from `claim`'s
answer. A same-session marker under a different nonce is `Foreign`: a proven loss on `15`, never
UNKNOWN. The branch-asserting verbs (`tree --issue`, `check`, `push`, `pr`, `commit`) take no flag —
the checked-out lane branch already carries the nonce, so **that** is the identity they ask under,
and a same-session loss is re-mapped to `14` (wrong lane) because inside one session it names a tree
you should not be standing in.

**One LANE leaves at most one marker on a thread**, and the scope of that rule is the lane, not the
session. Handed the token it already holds, `claim` reads ownership *before* it writes and answers
`won` with that same marker, posting nothing — so a re-claim is idempotent instead of stacking a
second marker that `claim` prints while `confirm` reads the earliest, and that `release` then peels
off one at a time (#5782). `release` retracts every marker carrying **this lane's** token, not only
the winning one, so a write that reported UNKNOWN and landed anyway leaves no residue. Both are
keyed on the token: a same-session marker under another nonce belongs to a sibling lane, so `claim`
does not short-circuit on it — it races it, and loses on `15` — and `release` leaves it standing,
because retracting another lane's claim is the one write this protocol must never make (#6037).

**Invocation**

```
fabrika build claim 4312 [--repo <owner/name>] [--purpose plan|gate|build] [--token <token>]
                         [--override <reason> --override-lane <lane>]
fabrika build confirm 4312 --token <token> [--repo <owner/name>]
fabrika build release 4312 --token <token> [--repo <owner/name>]
fabrika build adopt 4312 --session <dead-session> --reason <text> [--repo <owner/name>]
```

**Inputs** — the first two rows are identical for all three verbs; the last three are `claim`'s alone:

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue (or, in repair, the PR) the claim concerns |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository whose markers are read and written |
| `--token` | string | required on `confirm` / `release`, optional on `claim` | — | the token `claim` handed this lane — which lane is asking. On `claim` it is the token this lane ALREADY holds, and makes the re-claim idempotent (below); omitted, the run is a fresh lane. Not a claim token, or one carrying another session id, is `1` |
| `--purpose` | `plan` \| `gate` \| `build` | no | `build` | why this lane claims; the audience axis binds `build` only (#5175). An off-enum value is `10`, never a fallback |
| `--override` | string | no | — | claim an issue the admission test refused on either axis, naming why; requires `--override-lane` |
| `--override-lane` | string | no | — | the lane the override is taken for; refused without `--override`. Lane and reason are both written into the claim marker |

**`claim` runs the fence before it writes anything.** After the target-open check and **before
any marker is posted**, `claim` puts `<number>` through the
[admission test](#admission-test--scope-admission-and-the-audience-axis) — the same imported
module `build pick` filters on, every axis, never a second derivation. In repair, `<number>` is a PR,
and the test judges the issue that PR serves rather than the PR's own empty home — a PR naming no
readable issue is `refused: no-served-issue` at `20`. A `refused: out-of-scope` is
`20` and a
`refused: audience-not-agent` is `21`, a `refused: no-acceptance-criteria` is `32`, each named on
stderr; an unreadable declaration or home is `11` and a malformed declaration is `4`, and neither
ever proceeds. Nothing is written on any refusal: the issue carries no marker, so a refused claim
leaves no trace to retract.

**Then the blockedness gate, and only then the marker.** ADR
[0301](../../../../.decisions/0301-blocked-by-graph-is-the-carrier.md) makes GitHub's native
`blocked_by` graph the one carrier of "do not start this yet" — there is no `status:blocked` label,
and a claim is where the refusal has teeth, because a number handed straight to a lane passes
through no pool. After the admission test and before any marker, `claim` reads the graph through the
same `packages/fabrika-cli/src/build/blockedness.ts` reader `build eligible` uses: any blocker still
open is `16` naming **every** one of them, and an edge list — or a blocker's own state — that could
not be read is `11`, never "not blocked". The order is the point: the two axes answer without IO, so
a number the fence already refuses never costs the read. It is **not overridable**, because the
remedy is neither an edit nor a re-label but waiting, and there is no unblock act — the edge stays,
the blocker closes, and the next read answers unblocked. In repair `<number>` is a PR, which carries
no edges of its own and names a lane that has already started, so the gate does not run.

**The purpose decides which axes bind — it never enters an axis.** `--purpose`
says why this lane claims: `build` (the default) is bound by all four, while `plan` and `gate` are
bound by the scope axis alone. The audience axis asks whether an agent should pick the issue up to
*build*, and an epic earns `ready-for:agent` only after it has been planned and gated, so fencing
the planner and the gate on it is circular (founder ruling,
[#5175](https://github.com/kamp-us/phoenix/issues/5175); 19 of 20 open epics carried no such label).
The purpose rides **beside** the axes rather than widening any — each axis still reads the
issue exactly as it did, and only the composition consults the purpose, which is the shape ADR 0245's
repair round settled. A `21`, a `30` and a `32` are therefore reachable under `--purpose build` only,
and `20` is reachable under every purpose. `claim`'s purpose line names which reading applied, and the audience
it saw either way, so a claim admitted over a non-agent audience is readable as one afterwards.

**Repair of a decision PR is admitted on its own, with no flag and no override.** When `<number>` is
an open PR and the issue it serves carries `type:decision`, the audience axis does not bind that
claim (founder ruling on [#5866](https://github.com/kamp-us/phoenix/issues/5866), built as #5914).
Triage routes a decision to `ready-for:human` by default, so an ADR PR's repair lane was failing a
fence it could normally never pass — the only way through was `--override`, which spent a
founder-authorized escape hatch on routine repair. That default is not an exclusion: a decision
issue carrying a founder ruling comment is buildable as transcription (ADR
[0300](../../../../.decisions/0300-a-cited-ruling-makes-a-decision-buildable.md)), which is why the
exemption is read off the target rather than off the impossibility of the pairing. This axis reads
the `ready-for:` label the issue carries and never infers one from the type, in either direction;
which decision issues end up carrying `ready-for:agent` is decided by triage's `--ready-for` routing
([`triage/SKILL.md`](../triage/SKILL.md)), not by anything this verb assumes.
The exemption is read off the **target**, not typed: there is no `--purpose repair`, because a flag
could be passed against a bare issue and would then have to be refused, while naming a PR is already
proof that a build is in flight. Its width is exactly one pairing — the same decision issue claimed
directly still reads its own audience label and is `21` on a `ready-for:human`, an open PR serving
any other type still reads the audience label, and the scope axis is untouched. `claim`'s purpose
line names the exemption when it fires.

This is the seam where the refusal has teeth. A pool filter is bypassed by an operator naming a
number, and a number handed straight to `claim` passes through no pool — claiming is the moment work
starts and the one moment every path goes through (ADR 0245). `--override "<reason>"
--override-lane "<lane>"` admits the issue anyway and appends both fields to the claim marker it
posts, so the escape hatch costs one deliberate act and leaves a record on the issue naming who took
it and why. **Both fields are required together**: an empty reason, a missing or blank lane, and a
lane with no override are each a usage error (`1`), because an override that names neither is
indistinguishable from routine use — which is how a fail-closed fence rots fail-open by convention
(#5175). The override is for a *proven* refusal an operator means to take; it is not the way a
plan- or gate-purpose lane gets past the audience axis, which `--purpose` now answers directly.
`confirm` and `release` do not
run the fence at all: it governs what may *start*, so a campaign paused mid-lane can neither strand
a running lane nor block its release.

**A dead session's claim passes to a successor by an adopt marker, and by nothing else** (ADR
[0295](../../../../.decisions/0295-board-attested-claim-succession.md)). When a driver session dies —
an outage, a crash — its builders' claim markers stay on the board, and `release` from the successor
is proven-foreign on `15`. `build adopt <n> --session <dead-session> --reason "<text>"` posts one
comment:

```
build-adopt: <dead-session> by build:<my-session>:<uuid> · <ISO> · reason: <text>
```

The `by build:<my-session>:<uuid>` token is minted by `adopt` itself and printed on the answer: it is
the lane identity the succession creates, and `release <n> --token <that token>` is what retracts
**both** comments. The guards are the ones that keep this from being a steal: the adopt confers the
claim on exactly the **lane** its `by <token>` names — the same whole-token test an ordinary win
passes (#6060), so another lane of the successor's own session reads `Foreign` just as a third
session does; its author is ACL-checked at release time, so an
adopt from an account below `write` is counted, reported and never a succession; the reason is
required; and an adopt naming the caller's own session is `1`, because plain `release` already covers
a claim this session holds. There is still no TTL, no lease, and no eviction inferred from absence —
the successor states the fact on the board and the ordinary ownership read does the rest. What the
protocol cannot check is that the adopted session is really dead: any `write` account may adopt a
live claim, and the guard against that is the disclosed reason plus the ACL, not a proof.

**An adopt confers the whole claim on the number — under a new lane, not the dead one.** The
ownership read is one function, so an adopted claim answers `mine` to `confirm` and admits `branch`,
`note`, `scratch` and `tree --issue` — each under the token `adopt` printed, which is this lane's
identity on that number. That token carries a **fresh** nonce, and those verbs key on the caller's
nonce, so the successor gets its own branch (`build/<n>-<slug>-<its own nonce>`) and its own scratch
dir: standing in the dead lane's branch fails `tree --issue` on `14`, and the dead lane's unpushed
commits are recovered by hand or not at all. Inherit the number, not the working state.

`claim` is the one verb an adopted claim does not admit. Handed `--token` it refuses on `15` before
writing anything, because the winner it would otherwise answer with is the dead session's token,
which no later verb of this session accepts. Without one it resolves `Foreign` — the post-write read
runs under the nonce that run just minted, which no adopt names — so it retracts the marker it just
posted and refuses on `15` too. Adopt, release, then claim.

The session id arrives from the environment — `FABRIKA_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`,
else `PI_SUBAGENT_PARENT_SESSION`
([#6960](https://github.com/kamp-us/phoenix/issues/6960)); named in `--help` with its unset
behavior: unset is a usage error, exit `1` — a claim without an identity is not a claim.

**Output** — machine, one JSON object:

- `claim` on a win: `{"answer": "won", "number": 4312, "token": "build:<sid>:<uuid>", "purpose":
  "build"}` — plus `"override": {"lane": "<lane>", "reason": "<reason>"}` when the win came through
  `--override`, so the answer records the exception as well as the marker does.
- `confirm` when held: `{"answer": "mine", "number": 4312, "token": "..."}` — the winning marker's
  token on the ordinary path, and on a succession the **adopt's** token, never the dead session's,
  which every verb of this session refuses on `1`.
- `release` when released: `{"answer": "released", "number": 4312}` — plus `"adopted":
  "<dead-session>"` when the release came through a succession.
- `adopt` when recorded: `{"answer": "adopted", "number": 4312, "session": "<dead-session>", "token":
  "build:<sid>:<uuid>"}`.

A loss, a foreign confirm, and a not-mine release produce no stdout — they are exit `15`, the
winner named on stderr. **A lost race is a proven outcome on its own code, never exit 0** — v1's
direct-claim script exited 0 on both won and lost and left routing to prose
(`step3-direct-claim.sh:31,40`, its header admits it), and v1's `claim is-mine` fused "proven
lost" with "no session id" on exit 1 (`claim/command.ts:57`). Both are designed out: `15` is
proven-foreign only; a missing session id is `1`; an unreadable marker set is `11`.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | `claim` only: the `## Campaigns` table reads but does not parse — nothing was written |
| `7` | the issue is proven absent (404) or closed |
| `8` | the marker write failed — it may or may not have landed; run `confirm` with the token named on stderr before anything else, and never re-run `claim` |
| `9` | the marker landed but the read-back does not match |
| `10` | `claim` only: `--purpose` is off the `plan` \| `gate` \| `build` enum — a refusal, never a fallback to `build` |
| `11` | the marker set could not be read — ownership is UNKNOWN, never "unclaimed"; or, `claim` only, the campaigns table or the issue's home could not be read — scope admission is UNKNOWN, never admitted; or, `claim` against an issue only, its `blocked_by` list or a blocker's own state could not be read — blockedness is UNKNOWN, never "not blocked" |
| `15` | proven: another lane's earlier authorized marker wins (`claim`), holds (`confirm`), or `release` was asked for a token this lane does not hold. `claim` also refuses here over a claim this lane has *adopted* — release it first |
| `16` | `claim` against an **issue** only, proven: a `blocked_by` blocker is still open — every one is named on stderr, and no marker was written. Not overridable: the remedy is waiting, and the edge clears when the blocker closes |
| `20` | `claim` only, proven: the issue's home is pinned by no `active` campaign row — no marker was written |
| `21` | `claim --purpose build` only (the default), proven: the issue's audience is not an agent — no marker was written. Unreachable when the target is an open PR serving a `type:decision` issue (#5914) |
| `30` | `claim --purpose build` against an **issue** only, proven: the issue is `type:decision` or `type:epic` — no marker was written. Not overridable: a decision opens it with `--cites <ruling-comment-url>`, an epic with `--purpose plan` or `--purpose gate` |
| `31` | `claim --purpose build` against an **issue** only, proven: the claim's mode disagrees with the child's standing range verdicts — a fresh claim over a child holding any standing verdict (`PASS` as well as `FAIL`), or `--resume` over a child holding no `FAIL`. No marker was written, and neither direction is overridable: `--override` admits a *scope* refusal, and this is not one |
| `32` | `claim --purpose build` against an **issue** only, proven: the body carries no readable `### Acceptance criteria` block — absent, or a heading that drifted. No marker was written. Not overridable: the repair belongs on the issue (`triage enrich` for an absent block, `triage repair-criteria` for a drifted one), not on a branch |

**The prior-build gate — "no lane holds this" is not "this has no reviewed build"**

An epic child opens no pull request (ADR 0285), so its review lands as range-bound comments on the
child issue (ADR 0276) — a surface neither `build eligible` (which reads the `blocked_by` graph) nor
the claim protocol (which reads claim markers) ever looked at. A child released after a `FAIL` was
therefore handed to the next lane as ordinary work and rebuilt from scratch, twice on epic #5631; on
#6298 the two lanes chose different config-key shapes for one criterion, and only `lane prove`'s
refusal kept the wrong branch out of the assembly (#6386).

So a fresh build-purpose claim against an issue folds those comments — newest write per namespace,
the same rule `lane prove` folds on — and refuses on `31` when any namespace holds a standing
verdict, whatever its polarity. A `PASS` says the child was built and graded as loudly as a `FAIL`
does, and it is the more finished of the two, so admitting it was the same hazard with the opposite
sign (#6715); what the polarity changes is the route out, which each refusal line names — `--resume`
for a `FAIL`, the epic driver's fold for a `PASS`, which has no repair to take. Staleness is
deliberately not asked: a stale verdict still proves the child was built and
graded, which is the fact this gate exists for. The read runs **after** the pure axes and the
blockedness gate, so an issue those already refused pays for no comment page, and an unreadable page
is `11` — never "no prior build".

**The gate has three answers, not two, and the third is `11`.** A comment whose first line opens with
a gate namespace and then fails to parse as a range marker is a verdict that *cannot be read*, and it
is refused on the same code an unreachable comment page is, in both directions — with `--resume` and
without. Counting the break on stderr and admitting the claim anyway would resolve unreadable to "no
prior build", which is the failure this whole gate exists to stop, wearing a log line: a `FAIL`
posted in a broken format is still a reviewer saying no. Only a gate-namespace first line can reach
this arm (`packages/fabrika-cli/src/wire/marker-line.ts`), so ordinary discussion on a child never
trips it, and the remedy is to repost or delete the comment.

`--resume` is the other side, and it is **checked, not trusted**: it admits a claim over a standing
`FAIL` and refuses on `31` over a child holding none — including a child holding only `PASS`
verdicts, whose fresh claim the gate has already refused, so both doors are shut on it. Repair is otherwise derived from the target
being an open PR and never typed (founder ruling on #5866, #5914); the objection there was that a
typed mode is passable in a state where it means nothing, and a child has no PR to derive from — so
the word is admitted here exactly because the seam checks the fact it asserts. The route it opens is
`build branch --resume-lane`.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build claim: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build claim: out of scope — the active campaigns pin <milestones> and this issue's home is <home>; flip that campaign's ## Campaigns state cell to active, or claim it with an explicit override.` | 20 | refusal |
| `build claim: #<n> carries <audience>, not "ready-for:agent" — refusing before any marker; pass --override "<reason>" --override-lane "<lane>" to claim it anyway.` (`<audience>` is the issue's `ready-for:` label, or the literal `no "ready-for:" label` when it carries none) | 21 | refusal |
| `build claim: type not buildable — this issue carries <label>, whose deliverable is not a pull request an agent build lane produces; <remedy>.` (`<remedy>` names `--cites` for a decision and `--purpose plan`/`--purpose gate` for an epic) | 30 | refusal |
| `build claim: --cites <detail>; nothing was written.` — the URL is not an issue-comment URL, or names another repository or another issue | 1 | refusal |
| `build claim: cannot read the "## Campaigns" table: <reason> — scope is UNKNOWN, never admitted; nothing was written.` | 11 | refusal |
| `build claim: blocked by <n> open blocked_by edges: #<a>, #<b> — there is no unblock act, so the edge clears when the blocker closes; nothing was written.` — preceded by `build claim: scanned <n> blocked_by edges.` | 16 | refusal |
| `build claim: cannot read the blocked_by edges of #<n>: <reason> — blockedness is UNKNOWN, never "not blocked"; nothing was written.` | 11 | refusal |
| `build claim: the "## Campaigns" table does not parse: <detail> — a malformed table is never read as "nothing is active"; nothing was written.` | 4 | refusal |
| `build claim: #<n> is already held by this lane (comment <id>) — answered with the marker that owns it; nothing was written.` — beside `{"answer":"won", …}` on exit 0, when `--token` names a lane that already holds `<n>` | 0 | answer |
| `build claim: --token "<value>" is not a claim token (build:<session-id>:<uuid>) — which lane is asking is not stated.` | 1 | usage error |
| `build claim: --token "<value>" carries session <a>, but this run is session <b> — a lane names itself, never another.` | 1 | usage error |
| `build claim: --override was given with an empty reason — an override is recorded or it is not one.` | 1 | usage error |
| `build claim: --override was given without a lane — pass --override-lane "<lane>" so the escape hatch names who took it.` | 1 | usage error |
| `build claim: --override-lane was given without --override — a lane names no override on its own.` | 1 | usage error |
| `build claim: --purpose "<value>" is not one of plan \| gate \| build — an unrecognised purpose refuses, and never falls back to build.` | 10 | usage error |
| `build claim: the marker write failed: <reason> — the claim state is UNKNOWN; run "fabrika build confirm <n> --token <minted token>" before any further action.` — preceded by `build claim: the token this run minted is <minted token> — it addresses the marker the failed write may still have landed. Do not re-run "fabrika build claim <n>": it mints a second token, and if the first marker landed the race resolves to that earlier one, leaving a claim no lane holds a token for.` | 8 | refusal |
| `build claim: cannot read the claim markers on #<n>: <reason> — ownership is UNKNOWN, never "unclaimed".` | 11 | refusal |
| `build claim: #<n> already carries a build a reviewer failed — <gate> <polarity> over <base>..<tip> (comment <id>); …. A fresh build would re-implement it; run "fabrika build claim <n> --resume" to take the repair lane instead, then "fabrika build branch <n> --resume-lane --token <token>" to stand on the branch that build left. Nothing was written.` — every standing verdict is named, `PASS` ones included, whenever at least one is a `FAIL` | 31 | refusal |
| `build claim: #<n> is already built and graded — <gate> PASS over <base>..<tip> (comment <id>); …. A fresh build would re-implement work a reviewer passed, and there is nothing to repair, so --resume does not apply either. The next step is the epic driver's: fold the branch that build left, then close the child. Nothing was written.` — when every standing verdict is a `PASS` | 31 | refusal |
| `build claim: --resume says #<n> holds a build to repair, and no gate holds a standing FAIL over it — drop --resume and claim it as the fresh build it is. Nothing was written.` | 31 | refusal |
| `build claim: cannot read the comments on #<n>: <reason> — whether it already carries a graded build is UNKNOWN, never "no"; nothing was written.` | 11 | refusal |
| `build claim: <n> comment(s) on #<n> reach for a verdict marker and are not readable range ones — <#id: why>; …. A verdict that cannot be read is UNKNOWN, never "no prior build"; repost or delete the comment(s), then claim again. Nothing was written.` | 11 | refusal |
| `build claim: lost to <token> (posted <timestamp>, authorized).` | 15 | refusal |
| `build claim: the marker landed but the read-back does not match — the claim needs a human eye.` | 9 | refusal |
| `build confirm: #<n> is held by <winning token>, not by <caller token>.` — with ` — another lane of this same session` appended when the two tokens share a session id | 15 | refusal |
| `build confirm: --token "<value>" is not a claim token (build:<session-id>:<uuid>) — which lane is asking is not stated.` | 1 | usage error |
| `build confirm: --token "<value>" carries session <a>, but this run is session <b> — a lane names itself, never another.` | 1 | usage error |
| `build confirm: no claim exists on #<n> — nothing to confirm; run "fabrika build claim <n>" first.` | 15 | refusal |
| `build release: this lane holds no claim on #<n> — refusing to release another lane's.` | 15 | refusal |
| `build release: the retraction failed: <reason> — whether the claim is still held is UNKNOWN; run "fabrika build confirm <n> --token <caller token>".` | 8 | refusal |
| `build adopt: --session names this very session — "fabrika build release <n>" already covers a claim this session holds; nothing was written.` | 1 | usage error |
| `build adopt: --reason is empty — a succession is recorded or it is not one.` | 1 | usage error |
| `build adopt: --session is empty — an adoption that names no session adopts nothing.` | 1 | usage error |
| `build adopt: --session "<value>" carries whitespace or "·" — a session id is one unbroken word, and this one would compose a marker no reader can read back; nothing was written.` | 1 | usage error |
| `build adopt: --reason spans more than one line — the marker records one line, so the rest would be dropped silently; restate it as one line. Nothing was written.` | 1 | usage error |
| `build claim: #<n> still carries the adopted claim <winning token> — run "fabrika build release <n> --token <the adopt's token>" to retract it and the adopt together, then claim.` | 15 | refusal |

**Proven-unclaimed sits on `15` too**: zero markers means this lane does not hold the claim,
which is the one fact every `15` consumer acts on (stop mutating; claim first). The stderr detail
separates unclaimed from foreign for a reader; the code deliberately does not, because the caller
action is identical. The same reading applies wherever a sibling verb's precondition says
"claim confirmed (`15`/`11`)": an unclaimed target refuses on `15` with the no-claim message.

**Scope** — one issue's comment markers, paginated in full, plus — for `claim` — that issue's home
and audience against the active campaigns, and its `blocked_by` edges with each blocker's state. An unauthorized author's marker is counted and reported on
stderr but never wins: content is not authority. `claim`'s scope line names the declaration it judged
against (`campaigns: 1 active — fabrika fast follows (#46)`, `campaigns: 2 active — fabrika fast
follows (#46), fabrika everywhere (#47)`, or `campaigns: none active — scope fence inert`), so a
run that claimed under an inert fence is readable as such afterwards.

**Examples**

```
$ fabrika build claim 4312
{"answer":"won","number":4312,"token":"build:s-9f2e:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d","purpose":"build"}
```

```
$ fabrika build claim 4300 --purpose gate
{"answer":"won","number":4300,"token":"build:s-9f2e:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d","purpose":"gate"}
```

```
$ fabrika build claim 4290
build claim: out of scope — the active campaigns pin milestone #44 and this issue's home is 39; flip that campaign's ## Campaigns state cell to active, or claim it with an explicit override.
$ echo $?
20
```

```
$ fabrika build claim 4290 --override "hotfix for the release blocker" --override-lane build-ui
{"answer":"won","number":4290,"token":"build:s-9f2e:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d","purpose":"build","override":{"lane":"build-ui","reason":"hotfix for the release blocker"}}
```

```
$ fabrika build confirm 4312 --token build:s-9f2e:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d
build confirm: #4312 is held by build:s-77aa:9d8c7b6a-5f4e-3d2c-1b0a-998877665544, not by build:s-9f2e:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d.
$ echo $?
15
```

The two-lanes-one-session shape, where the tokens differ only after the session id:

```
$ fabrika build confirm 6024 --token build:s-9f2e:763ccb6d-1f0e-4c2b-9a3d-0e1f2a3b4c5d
build confirm: #6024 is held by build:s-9f2e:c997bbca-2d1e-4b3a-8c7f-6a5b4c3d2e1f, not by build:s-9f2e:763ccb6d-1f0e-4c2b-9a3d-0e1f2a3b4c5d — another lane of this same session.
$ echo $?
15
```

**Grounding**

- ADR 0115 — detect-and-tiebreak comment claims; re-implemented, never called (ADR 0238).
- ADR 0295 / #6068 — succession is attested on the board, never by a TTL, a lease or a steal;
  #5752's cross-session carve-out is narrowed by exactly this one marker kind.
- ADR 0055 — authorization from repository permissions, never from marker text.
- #4428 — the token shape is pinned here because callers guessed between two shapes.
- #2997 — `confirm` before every number-addressed mutation is the guard that pins the actor.
- #4145 is an **open decision** on who releases a *delegated* claim (run vs lane). This contract
  encodes the conservative floor — `release` releases only this session's own token at its
  terminus — and does not pre-rule the delegation question; when #4145 rules, the change lands
  here.
- ADR 0245 / #5011 — the claim seam is where the scope refusal acquires teeth: a directly-handed
  number passes through no pool, and the override is a flag that leaves a record rather than prose in
  a charter.
- ADR 0210 — direction binds early, never at the end; the fence fires before a build starts, and
  `confirm` / `release` are deliberately outside it.
- v1 scars designed out: `step3-direct-claim.sh` exit-0-on-lost; `claim/command.ts:57` fused
  refusals; `claim/github.ts:229-231` where a transient permission-read failure silently demoted
  an authorized author (here that read failing is `11`, never a silent demotion).

### `build claimants`

**The one ownership read that does not ask about the caller.** Every verb above resolves ownership
against the lane that is asking: `confirm` takes a `--token` that must carry this session's id, and
`claim` answers only by writing a marker of its own. So a driver arriving after a session limit
killed its builders could list the lanes that stopped and not the numbers those dead lanes left
claimed — it opened each issue by hand
([#6771](https://github.com/kamp-us/phoenix/issues/6771)). `claimants` runs the same fold and
**reports** it: no `--token`, no session needed, nothing written.

**It clears nothing, and that is a designed limit rather than an unfinished one.** ADR 0295 bans a
TTL, a lease, a steal and eviction inferred from absence, so a stranded claim still leaves through
`build adopt` then `build release`. The answer is a list a driver acts on, never an act.

**A closed issue is answered, not refused.** The rest of the group folds through `openIssue`, where
absent and closed share `7` because neither leaves a live issue to act on. Here the question is
answerable on a closed thread, and a marker outliving the issue it was taken on is exactly the
strandedness this reads for — so closed is reported on stderr and answered on exit `0`. Absent is
still `7`: there is no thread. Unreadable is still `11`.

**Invocation**

```
fabrika build claimants 6669 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue this lane serves |
| `--repo` | string | no | `$CLAUDE_PIPELINE_REPO`, else `$GITHUB_REPOSITORY`, else the `origin` remote | the target owner/name |

**Output** — machine, one JSON object:

```
{"answer": "held" | "unclaimed", "number": 6669,
 "holder": {"commentId": 512345, "author": "…", "createdAt": "…", "token": "…", "session": "…",
            "authorized": true} | null,
 "claimants": [<the same shape, one per claim marker on the thread>],
 "adopts": [{"commentId": …, "author": "…", "createdAt": "…", "adopted": "<dead session>",
             "token": "…", "reason": "…", "authorized": …}]}
```

`holder` is the **earliest authorized** marker — the same winner every ownership question in this
group resolves against, never a second derivation — and `null` exactly when `answer` is
`"unclaimed"`. `claimants` lists every marker beside it, authorized or not, so an unauthorized one is
visible as counted-and-not-a-winner rather than dropped (ADR 0055). `adopts` lists the succession
markers on the thread, which is how a reader tells a claim already passed to a successor from one
still stranded. Empty `claimants` and `adopts` arrays are an answer, not an absence: they mean the
thread was read in full and carries no marker of that kind. An unreadable thread never lands here —
it is `11`.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the issue is **proven absent** — there is no thread to read a claim off. Closed is not this: a closed issue is answered on `0` |
| `11` | the issue, its comments, or an author's permission could not be read — who holds it is UNKNOWN, never "unclaimed" |

No other code is reachable. There is nothing to lose (`15` needs a caller identity, and this verb
holds none), nothing to write (`8`, `9`), and no fence to refuse against (`20`, `21`, `30`, `31`,
`32`, `16`) — the admission test governs what may *start*, and this starts nothing.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build claimants: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.` | 1 | usage error |
| `build claimants: issue #<n> is proven absent — there is no thread to read a claim off.` | 7 | refusal |
| `build claimants: cannot read #<n>: <reason> — who holds it is UNKNOWN, never "unclaimed".` | 11 | refusal |
| `build claimants: cannot read the claim markers on #<n>: <reason> — who holds it is UNKNOWN, never "unclaimed".` | 11 | refusal |
| `build claimants: #<n> is closed.` — beside the answer on exit 0, never instead of it | 0 | note |
| `build claimants: comment <id> carries a claim marker from "<author>", who holds no write permission — counted, never a winner.` — one line per unauthorized marker | 0 | note |
| `build claimants: no authorized claim marker stands on #<n>.` — beside `{"answer":"unclaimed", …}` | 0 | note |
| `build claimants: #<n> is held by <token> (session <session>, comment <id>, posted <ISO>).` | 0 | note |
| `build claimants: if that session is gone, the succession is a written one: fabrika build adopt <n> --session <session> --reason "<why>", then release under the token adopt prints. Nothing clears a claim on its own (ADR 0295).` | 0 | note |
| `build claimants: session <session> has already been adopted — the lane that adopt names releases it.` — this line replaces the one above when an authorized adopt marker names the holder's session | 0 | note |

**Scope** — one issue's comment markers, paginated in full, and nothing else. It reads no campaign
declaration, no `blocked_by` edge and no label: the admission test governs starting work and this
verb starts none. Zero markers is a proven answer (`"unclaimed"` on exit `0`), never a refusal —
which is the one place this verb's shape differs from `confirm`, where proven-unclaimed is `15`
because the caller was about to mutate.

**Examples**

A thread carrying exactly one claim marker, comment `512345` by a `write` account:

```
$ fabrika build claimants 6669
{"answer":"held","number":6669,"holder":{"commentId":512345,"author":"usirin","createdAt":"2026-08-19T22:14:03Z","token":"build:s-9f2e:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d","session":"s-9f2e","authorized":true},"claimants":[{"commentId":512345,"author":"usirin","createdAt":"2026-08-19T22:14:03Z","token":"build:s-9f2e:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d","session":"s-9f2e","authorized":true}],"adopts":[]}
```

A thread carrying no claim marker at all:

```
$ fabrika build claimants 6670
{"answer":"unclaimed","number":6670,"holder":null,"claimants":[],"adopts":[]}
$ echo $?
0
```

A number with no issue behind it:

```
$ fabrika build claimants 999999
build claimants: issue #999999 is proven absent — there is no thread to read a claim off.
$ echo $?
7
```

**Grounding**

- #6771 — the driver could list the lanes that stopped and not the issues those lanes left claimed;
  this verb and `lane stale --claims` are the two halves of that read, landed in
  [#6837](https://github.com/kamp-us/phoenix/pull/6837).
- ADR 0295 — succession is written on the board; no TTL, no lease, no steal, no eviction from
  absence. A read verb that cleared anything would be that eviction by another name.
- ADR 0055 — authorization from repository permissions; an unauthorized marker is counted and named,
  never a winner.
- #6060 — the holder is the earliest authorized marker, one fold shared with `confirm`, so this
  cannot answer a different winner than the protocol enforces.

---

## `build issue`

**Invocation**

```
fabrika build issue 4312 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue to read |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository read |

**Output** — machine. One JSON object:

```
{"number": 4312, "title": "...", "state": "open", "labels": ["type:bug", "p1", "status:triaged", "ready-for:agent"],
 "body": "...", "criteria": {"state": "found", "items": [{"text": "...", "checked": false}]}}
```

`criteria` comes from the imported `acceptance-criteria` wire read and carries its three answers
as positive tokens: `found` (with `items`), `absent` (no block reaches for the heading),
`malformed` (something reaches for it and misses — never silently treated as absent). The
distinction is the wire module's whole design; **this verb transports it and refuses nothing**, and
that is deliberate: the fence is the admission test's criteria axis at `build claim`, which refuses
both negative answers on `32` before a lane opens (#6554). A read verb that refused would leave the
operator repairing a body unable to print it. The body passes through the content gate.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the issue is proven absent (404) or closed |
| `11` | the issue could not be read — its content is UNKNOWN |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build issue: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build issue: cannot read #<n>: <reason> — its content is UNKNOWN.` | 11 | refusal |

**Scope** — one issue. Not a judging verb; the empty-vs-failed distinction lives in `criteria.state`
versus exit `11`.

**Example**

```
$ fabrika build issue 4312
{"number":4312,"title":"Editor loses focus after save","state":"open","labels":["type:bug","p1","status:triaged","ready-for:agent"],"body":"…","criteria":{"state":"found","items":[{"text":"focus stays in the editor after save","checked":false}]}}
```

**Grounding**

- Secure-by-default AC 3 — every external-content read routes through a verb; this is the issue
  read's single door, and the #4859 posture lands in its content gate.
- The wire module's `Absent` vs `Malformed` split — a drifted heading must never read as "no
  acceptance criteria" (#4735's class: a gate grading a PR over nothing).

---

## `build branch`

**Invocation**

```
fabrika build branch 4312 --slug editor-focus-loss --token <token> [--base <ref>]
fabrika build branch --resume 4310 --token <token>
fabrika build branch 6296 --resume-lane --token <token>
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes (create mode) | — | the claimed issue the branch serves |
| `--slug` | string | yes (create mode) | — | kebab-case, ≤5 words, must not begin with `-` |
| `--base` | string | no | `origin/main` | the base ref, **fetched before the branch is cut** |
| `--resume` | integer | exclusive with the positional | — | a PR number whose head branch to switch to, for repair |
| `--resume-lane` | boolean | no | `false` | child-repair mode: take over the local branch a prior lane built `<number>` on. Exclusive with `--resume` and with `--slug` |
| `--token` | string | yes | — | the token `build claim` handed this lane — which lane is asking (#6037). Not a claim token, or one carrying another session id, is `1` |


**Output** — machine. One line, the checked-out lane branch's name, newline-terminated.

**Lane identity, defined once here and consumed by every code-`14` check.** A lane branch's name
carries the lane: `build/<number>-<slug>-<nonce>` in create mode, `build/pr-<pr>-<nonce>` in
resume mode, where `<nonce>` is the first 8 hex of the **current** claim token's UUID. A verb
proving "this lane's branch" (`tree --issue`, `check`, `push`, `pr`) parses `<number>` (or
`<pr>`) and `<nonce>` out of the checked-out branch's name, re-reads that number's claim through
the ACL check, and requires this session to hold it with a token whose UUID prefix equals the
nonce. Wrong number, wrong nonce, or an unparseable branch name is `14`; a claim readable and
held by another session is `15`; an unreadable claim is `11` — every code-`14` consumer can
therefore also return `14`, `15` and `11`, and enumerates all three. No verb needs a flag to
find the lane — the branch name is the record, and there is no
stamp file to duplicate or go stale (the stamp machinery is the accretion the 2026-08-03
amendment measured, and it is not rebuilt).

Create mode: fetch `--base`, cut `build/<number>-<slug>-<nonce>` off `FETCH_HEAD` (never a stale
local ref), switch to it. Resume mode: resolve the PR's current head branch, fetch it, and check
it out under the **local** lane name `build/pr-<pr>-<nonce>` with its upstream set to the remote
head branch — `build push` publishes via that tracked upstream, so the PR updates while the local
name carries the *current* repair claim's nonce. Each repair run gets its own local branch, so a
dead earlier lane can never pin this one (#4868's class). A closed or merged PR refuses (`7`).

**Child-repair mode (`--resume-lane`) — resume for the artifact that has no PR to resume.** An epic
child opens none (ADR 0285), so `--resume` has nothing to take, and a fresh cut off the assembly
branch would throw away the commits a reviewer already graded. This mode instead finds the one local
branch this file's own grammar says was cut for `<number>`
(`packages/fabrika-cli/src/build/lane.ts`'s `childLaneBranches`, the same reader `lane prove` and
`lane brief` take), **re-keys** it to this claim's nonce with `git branch -m`, and checks it out. The
slug comes off that name, so `--slug` is refused; nothing is fetched, because a child's branch is
never published. A re-run under the same nonce resolves the same name and re-keys nothing.

Renaming rather than cutting a second branch is the whole point: two branches carrying one child's
commits is the range `lane prove` reports as underivable, and that refusal cannot be cleared from
inside a worktree, because `git branch -D` refuses a branch another worktree holds (#6386).

**The re-key is proven safe before it runs, because `git branch -m` will not refuse for it.** Unlike
`-D`, a rename of a branch a second worktree has checked out **succeeds** — git exits 0 and retargets
that worktree's `HEAD` to the new name; only the `git switch` afterwards fails, by which point the
prior lane is silently standing on a branch keyed to this one. So the verb reads
`git worktree list --porcelain` first and refuses on `11` naming the worktree that holds the branch,
which is the operator's to release. If a switch fails after a rename did land, the refusal says the
rename stands rather than "nothing was changed" — that phrase is reserved for a tree that was not
touched. Measured against git 2.40.1 rather than reasoned about.

Preconditions, guarded identically to `build tree`: a readable tree root (`11`), a confirmed claim
(`15` / `11`) — in create and child-repair mode on `<number>`, in resume mode on the `--resume` PR's
number, which is the number repair mode claims.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | `--resume`'s PR is proven absent, closed, or merged; or `--resume-lane` found no branch anywhere in this clone's refs cut for `<number>` |
| `10` | `--slug` is not kebab-case, exceeds 5 words, or is flag-shaped; or `--resume-lane` was given beside `--resume` or `--slug` |
| `11` | the fetch failed, the claim state could not be read, or `--resume-lane` could not read this clone's branches or its worktrees, found several candidates, proved another worktree holds the branch, or could not re-key or check out the one it found |
| `15` | proven: the claim on `<number>` is foreign |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build branch: --slug "<value>" is not kebab-case (lowercase letters, digits, single hyphens, ≤5 words).` | 10 | refusal |
| `build branch: cannot fetch <ref>: <reason> — refusing to cut a branch off a stale base.` | 11 | refusal |
| `build branch: PR #<n> is proven closed or merged — nothing to resume.` | 7 | refusal |
| `build branch: --resume-lane takes over the local branch of an epic child, which has no PR — it cannot be combined with --resume <pr>.` | 10 | refusal |
| `build branch: --resume-lane reads the slug off the branch it takes over — drop --slug "<value>".` | 10 | refusal |
| `build branch: no branch anywhere in this clone's refs was cut for #<n> — the build to resume is gone. …` | 7 | refusal |
| `build branch: <a>, <b> were all cut for #<n> — which one this lane resumes is not derivable here; retire the superseded branches, then re-run.` | 11 | refusal |
| `build branch: <branch> is checked out in the worktree <path>, so re-keying it here would rename the branch out from under that lane rather than fail — retiring or releasing that worktree is an operator's act, not this lane's. Nothing was changed.` | 11 | refusal |
| `build branch: cannot read which worktree holds <branch>: <reason> — re-keying it could silently retarget another lane's HEAD, so whether the take-over is safe is UNKNOWN; nothing was changed.` | 11 | refusal |
| `build branch: cannot re-key <old> to <new>: <reason> — nothing was changed.` | 11 | refusal |
| `build branch: cannot check out <new>: <reason> — <old> WAS re-keyed to <new> and that rename stands; this tree is still on the branch it started on, so re-run once <new> is free, or rename it back.` | 11 | refusal |
| `build branch: #<n> is held by <winning token>, not by <caller token>.` | 15 | refusal |

**Scope** — not a judging verb. It mutates only the current tree's HEAD and local refs.

**Examples**

```
$ fabrika build branch 4312 --slug editor-focus-loss --token <token>
build/4312-editor-focus-loss-c1a4d6f8
```

```
$ fabrika build branch 4312 --slug -rf --token <token>
build branch: --slug "-rf" is not kebab-case (lowercase letters, digits, single hyphens, ≤5 words).
$ echo $?
10
```

**Grounding**

- #1920 / #3621 — branch off `FETCH_HEAD` after a real fetch; a stale local `origin/main` is the
  recurring wrong base.
- #4854 — the flag-shaped-slug refusal.
- #4500 — eight trees, one stamp: identity via per-claim nonce makes duplicate lanes
  unconstructible instead of detected.
- 2026-08-03 amendment on #4707 — no stamp files; ownership is derivable from git.

---

## `build scratch`

**Invocation**

```
fabrika build scratch 4312 --slug notes --token <token>
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the claimed issue this lane serves |
| `--slug` | string | yes | — | the file's leaf name, kebab-case, no path separators |
| `--token` | string | yes | — | the token `build claim` handed this lane — which lane is asking (#6037). Not a claim token, or one carrying another session id, is `1` |


**Output** — machine. Exactly one absolute path on stdout, newline-terminated:
`<OS temp root>/fabrika-build/<session-id>/<issue>-<claim-nonce>/<slug>` — the fixed
`fabrika-build` segment namespaces the allocator against everything else in the temp root. The
directory is created if absent. **The claim nonce in the key is what v1's allocator lacked**, and it is `--token`'s nonce — the
CALLER's, not the winning marker's, which is one string for every lane of a session (#6037): v1 keyed on the session id
alone, so two lanes (or two roles) of one session shared a namespace and clobbered each other's
fixed-name files (#4516, #4544, #4875, #4692); v1's own stamp could not separate two pid-less
runs (`scratchpad.ts:26-29`, documented in-source). Keying on the confirmed claim makes the
namespace per-lane by construction.

Preconditions: a confirmed claim on `<number>` (`15` / `11`).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `10` | `--slug` carries a path separator, or is not kebab-case |
| `11` | the claim state could not be read |
| `15` | proven: the claim on `<number>` is foreign |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build scratch: --slug "<value>" must be a kebab-case leaf, no path separators.` | 10 | refusal |
| `build scratch: cannot create <dir>: <reason>` | 1 | refusal (the universal `1` — the verb failed to run) |
| `build scratch: cannot read the claim markers on #<n>: <reason> — the lane is UNKNOWN.` | 11 | refusal |
| `build scratch: #<n> is held by <winning token>, not by <caller token>.` | 15 | refusal |

**Scope** — not a judging verb. Creates one directory, prints one path, writes no file content.

**Example**

```
$ fabrika build scratch 4312 --slug notes --token <token>
/tmp/<redacted>/s-9f2e/4312-c1a4d6f8/notes
```

**Grounding**

- #4516 / #4875 / #4692 / #4544 — the shared-namespace clobber class; per-lane keying is the fix
  the four-skill patch deliberately did not extend to write-code.
- #3086 / #3718 — a fixed `/tmp` leaf is banned; the path is derived, never invented.
- The printed path is machine-local by definition: it must never appear in any posted artifact —
  `build pr` and `build note` red on it (`5`).

---

## `build commit`

**Invocation**

```
fabrika build commit < message.txt
fabrika build commit --message-file "$(fabrika build scratch 4312 --slug commit-message --token <token>)"
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| stdin | text | yes, unless `--message-file` | — | the commit message, file-free |
| `--message-file` | string | no | — | a leaf under this lane's `build scratch` directory; any other path is refused |

**Output** — machine. On success, one JSON object:
`{"answer": "committed", "sha": "<full object name>", "subject": "<the message's first non-blank line>", "carried": "stdin" | "scratch-leaf"}`.
Every refusal produces no stdout.

**The three guards, and the incident each closes.** The verb exists because there was no commit verb
at all: nothing prescribed how a message reached `git commit`, so the call site stayed improvised,
and nothing asserted that the message on the resulting commit was the one the lane wrote. A lane ran
`git commit -F <leaf>` against a leaf holding a **two-day-old message from another lane**; the file
existed, was non-empty, and was a well-formed conventional-commit message, so every cheap check read
green and the commit landed naming an issue the lane had never touched (#5484).

1. **The carrying path is prescribed.** Either **file-free** — the message on stdin, handed straight
   to `git commit -F -`, so there is no second place the bytes live — or a **leaf under `build
   scratch`'s claim-nonce-keyed directory**. A hand-rolled path is **refused** (`10`), not tolerated:
   a path outside the allocator is precisely the one with no per-lane key, which is what let a stale
   file sit where a fresh one was assumed.
   **The containment test keys on the DIRECTORY and never on the leaf name** (§SP rule 2): a plain
   `commit-message` leaf inside this lane's directory is admitted, and a run-keyed leaf anywhere else
   is refused. Keying the leaf is the anti-pattern the allocator retired — a shared directory with
   clever names is still a shared directory.
2. **The message may name only numbers this lane holds.** Every `#<n>` in the message is tested
   against this lane's confirmed claim; one it does not hold is `4`, before any commit exists. In
   resume mode the permitted set also holds the issue the PR itself closes, **read off the PR** and
   never taken on the message's word. This is the guard a shape check cannot be: the borrowed message
   was well-formed and referenced a real issue.
3. **The message is read back off the created commit.** `git log -1 --format=%B` asks git what it
   *recorded*; everything upstream is only a claim about what was *sent*. A mismatch is `9` and the
   refusal prints **both** messages, quoted, so the difference is legible without re-running. The
   commit is created with `--cleanup=verbatim` so git edits nothing and the comparison is honest;
   `normalizeForReadback` is what absorbs the trailing-newline difference, exactly as the two posting
   verbs' read-backs do.

**No refusal repeats a machine-local path.** `build scratch`'s path is machine-local by definition,
and both the `--message-file` refusals and the ones quoting git's own stderr would otherwise carry
one — git names the path it could not read. The path refusals name the **leaf only**, and every
quoted foreign string (git's stderr, the message read back) is masked through the same
`report/leaks.ts` predicate `build pr` and `build note` red on.

Preconditions: a branch that is this lane's (`14`), a claim this session holds (`15` / `11`), and
something staged (`7`).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing |
| `4` | the message names an issue this lane holds no confirmed claim on, or `--message-file` holds no message |
| `5` | the message carries a machine-local path |
| `6` | the message is a bare `@` path reference |
| `7` | nothing is staged — there is no change to commit |
| `8` | the commit ran and HEAD, or the created commit's message, could not be read back — UNKNOWN |
| `9` | proven: the created commit carries a message this lane did not author |
| `10` | `--message-file` is not a leaf in this lane's `build scratch` directory |
| `11` | a precondition read failed — nothing was committed |
| `14` | proven: the checked-out branch is not this lane's |
| `15` | proven: this session does not hold the claim |
| `24` | proven: `git commit` ran and HEAD did not move — no commit was created |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build commit: stdin held nothing — the commit message is the input.` | 3 | refusal |
| `build commit: the message names #<m>, which this lane holds no confirmed claim on — this lane's claim is on #<n>. A commit message names only what this lane owns; a related reference belongs in the PR body.` | 4 | refusal |
| `build commit: --message-file "<leaf>" holds no message — a commit message is the input.` | 4 | refusal |
| `build commit: the body carries a machine-local path: <text> — redact before posting.` | 5 | refusal (the imported predicate's wording) |
| `build commit: nothing is staged — there is no change to commit.` | 7 | refusal |
| `build commit: commit <sha> was created but its message could not be read back: <reason> — what it carries is UNKNOWN.` | 8 | refusal |
| `build commit: commit <sha> carries a message this lane did not author — amend it, then re-run. It needs a human eye.` | 9 | refusal, with both messages quoted above it |
| `build commit: --message-file "<leaf>" is not a leaf in this lane's scratch directory — send the message on stdin, or write it under the path "fabrika build scratch <n> --slug <leaf> --token <token>" prints. That path is machine-local, so it is not repeated here.` | 10 | refusal |
| `build commit: cannot read the index: <reason> — nothing was committed.` | 11 | refusal |
| `build commit: git commit ran and HEAD did not move — no commit was created: <reason>.` | 24 | refusal |

**Scope** — not a judging verb. Creates one commit, or none; writes no file, and pushes nothing.

**Example**

```
$ fabrika build commit < message.txt
{"answer":"committed","sha":"03135b9188d2be6c0a4b7bd0b7a3ff9c53f0f2b1","subject":"fix(build): read the commit message back off the commit (#4312)","carried":"stdin"}
```

**Grounding**

- #5484 — the incident: `git commit -F <leaf>` over a two-day-old message file, committed silently.
  Its corrected mechanism is what shapes the guards: `-F` on a **missing** file dies (`128`), and
  `COMMIT_EDITMSG` is per-worktree, so neither a fallback nor a cross-lane share was involved. The
  file **existed and was stale**, which is why the answer is a keyed directory plus a read-back
  rather than an existence check.
- #4692 / #4516 / #4875 / #4544 — the shared-namespace clobber class the allocator already keys
  against; this verb is what makes a lane use it for the one file that reaches the merge record.
- §SP rules 1 and 2 (`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`) — prefer no
  file at all; where one is unavoidable, uniqueness lives in the directory.

---

## `build check`

**Invocation**

```
fabrika build check --surface code
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--surface` | enum: `code` \| `prose` \| `plan` \| `workflows` | yes | — | the surface whose validators run; the skill names it, this verb anchors it |

**Output** — machine. On green, one JSON object:
`{"verdict": "green", "surface": "code", "tree": "<abs tree root>", "ran": [<the commands that ran>], "unvalidated": []}`.
Red and unknown produce no stdout (`18` / `11`), diagnostics on stderr verbatim from the runners.

`unvalidated` is always present and lists the changed files **this verdict does not cover** —
computed against *this* surface's validators, so it holds both the class no surface validates
(`.sh`, `.sql`, `.css`, …) and the class another surface would have read. Markdown under
`--surface code` is the common case, and its mirror is code under `--surface plan`. A non-empty list
beside a green is the honest reading of a mixed diff, and the same line is repeated on stderr.

The list is a **disclosure, not a second validator run**: `--surface code` names the markdown it
skipped and does not scan it. Running the markdown validators there would make the surface guess at
file classes, which the anchor exists to refuse — so the remedy for a mixed diff that needs its
markdown read is a **second run at a markdown surface**: `--surface prose`, or `--surface plan` when
the markdown is an epic ledger, since `plan` runs the prose validators too. Either admits a mixed
diff (#5301). Each run is green for what it read and names what it did not; between them nothing in
the diff goes unread.

`unvalidated: []` therefore means every changed file was read by **every** validator its class gets
and all of them passed — nothing weaker (#5288), and true at the validator level rather than only at
the file-open level (#5304). Two facts hold that promise up:

- **A class one surface claims, it validates whole.** `prose` and `plan` both cover `markdown`, so
  both run the leak scan and the link resolver; `plan` adds the `## Dependencies` grammar on top.
  `plan` used to run the grammar *instead*, and greened a ledger with `unvalidated: []` while the
  leak scan had never opened it.
- **A file that cannot be read refuses.** Only a file the tree no longer holds — a deletion the diff
  still counts — may be skipped, and only because absence is proven. Any other read fault (a
  permission or IO error) is a read that did not execute, so it refuses on `11` naming the file. One
  catch-all fused the two and skipped both.

Per surface:

- **code** — every command the repo declares under `.fabrika.jsonc`'s `codeValidators`, executed in
  this tree **with the build cache bypassed**. The cache bypass is the design — a cache hit from
  another checkout returned another tree's green three times in one session (#4106) and recurred on
  the review side (#4887) — but the flag expressing it is the repo's, since turbo's `--force` is a
  hard error to a bare `tsc` (#6015). Nothing is compiled in for a repo to inherit: phoenix declares
  `pnpm typecheck --force` and `pnpm lint:worktree` in its own `.fabrika.jsonc` like anyone else. A
  repo with no list — declared empty, or never declared at all — has nothing to run, which refuses
  `11`, UNKNOWN naming which of the two it was — never green, and never the `VALIDATION_RED` that
  says the code failed.
- **prose** — changed markdown files: every relative link resolves against this tree; no
  machine-local path (the imported `doc-leaks.ts` predicate); every fabrika-doc reference cited by
  id exists.
- **workflows** — the changed files under `.github/workflows/`: `actionlint` over exactly those
  files, plus every command the repo declares under `.fabrika.jsonc`'s `workflowValidators`. A
  declared command takes no paths, so the green covers a changed workflow only when `actionlint` ran
  or a declared command's `reads` names it; the rest are reported in `unvalidated`.
- **plan** — everything `prose` runs, plus the changed ledger's `## Dependencies` block parsing
  under the canonical grammar, which is **this section** and is implemented by
  `packages/fabrika-cli/src/build/dependencies.ts`. The section holds only blank lines and list
  lines of two forms, `- phase <int>: <ref>[, <ref>…]` and `- <ref> requires: <ref>[, <ref>…]`,
  where `<ref>` is an issue ref (`#<int>`) or a ledger-local id (`C<int>`); the section ends at the
  next ATX heading or the first thematic break, whichever comes first, and any other non-blank line
  inside it is unparseable and reds. Issue refs must resolve to real issues, ledger-local refs must
  resolve within the ledger, and no child may be its own predecessor. A ledger is markdown, so the
  markdown validators are its baseline and the grammar is the specialization on top.
  **This block is a rendering of the ledger's shape for a human reader, never a source of
  blockedness** — that is the native `blocked_by` graph's alone (#5387, ADR 0301), and
  `build eligible` parses nothing here.

**The prose leak scan predicts the repo's committed-file gate, and is not the body guard.** Those
are two questions with two answers, and asking the body guard about a file in a diff made this verb
red on bytes CI passes clean — a red the lane that inherited it could not clear (#5687). Three shapes
separate them, each a real doc a lane writes: a fenced code block quoting a path-scanning regex (a
segment must be name-shaped here, so a bare marker beside an alternation bar is not a path); a doc
citing a scratch root (`/tmp/…` is a rule for a public *comment*, which has no legitimate example of
one — a doc does); and a doc whose subject IS path hygiene and must spell the shapes out. A body
posted to an issue keeps refusing all three, because nothing gates it.

That last one is repo policy, so it is declared, not compiled in: `.fabrika.jsonc`'s `docLeakExempt`
lists repo-relative path suffixes the leak scan skips. Every failure resolves to *nothing is exempt*
— absent file, absent key, empty array, malformed entry — so the scanner stays strictest and a
mis-declared exemption reads as a red rather than a silent pass. A config that exists and cannot be
read is `11`, UNKNOWN: which docs are exempt is then unknown, and the verdict may not be green.
Fenced code is **scanned**, deliberately — the repo's gate scans docs whole, and skipping fences here
would make the predictor looser than what it predicts.

**A prose red must be this diff's, so the leak scan is baselined against the merge base.** The scan
used to read the whole text of every changed markdown file, so a PR that edited one paragraph
inherited every defect line already in it — content the author never wrote and must not change, which
made a correct one-line doc fix unmergeable (#5755). The verb now scans the file at the merge base as
well and reports only what this diff added. This applies to `--surface plan` too, which runs the same
markdown validators over an epic ledger. Consequences worth knowing before reading a red:

- Identity is the pattern's reason plus the matched bytes, never the line number, because an
  insertion above a leak shifts it. Byte-identical leaks are therefore told apart by **count**: the
  base's copies are a budget the head's occurrences spend, so adding a third copy of a leak the base
  held twice still reds.
- A file the diff creates has no base text, so its whole content is this diff's.
- Both base reads are pinned to the lane root with `git -C`, so the answer does not change with the
  directory you invoke the verb from. Unpinned, a run from a subdirectory listed nothing at the base
  and treated every changed file as created — the old red, back, at exit 0 with nothing to see.
- The baseline is keyed by path, so a **rename reds every leak the file already carried** — the
  new path has no base text. Intended, not a miss: a doc moved to a new home is a fresh chance to
  fix what it carries. It is the one case where a red names a line the author did not write.
- The base text is scanned with the **head's** exemption list, so a diff that removes a doc from
  `.fabrika.jsonc`'s `docLeakExempt` cancels that doc's pre-existing leaks on both sides and greens
  here. `leak-guard.yml` scans it whole and still reds it — the one case where this predictor is
  looser than the gate it predicts, and the gate is the one that decides.

`cli-invocation-guard` reached the same shape for the same class of problem in #4250: its
`attribute()` classifies head findings against the merge base's, keyed on file plus the exact
offending text with the line number deliberately dropped, spent as a multiset budget. Two guards
arriving independently at those three properties is the argument for the pick. The alternative —
read the diff hunks and keep only findings on added lines — is rejected because markdown is edited
by rewriting prose, and a moved paragraph, a re-wrapped line or a rename presents every carried line
as added, so it would reproduce the false red on the most ordinary doc edit there is.

**Only the leak scan is baselined.** A leak is decided entirely by the bytes of its own line; a
link's resolvability is a property of the tree, and the same untouched line goes dead the moment the
diff moves its target — baselining the link resolver would green the PR that broke every link in the
repo.

A predictor and the gate it predicts have to carry the same path shapes, and fabrika may not import
the gate's module (ADR 0238, ADR 0273). So the agreement is pinned rather than promised, on ADR
0251's terms: the canonical shapes are the golden fixture
`packages/fabrika-cli/src/build/__fixtures__/doc-leak-patterns.golden.json`, and each side asserts
against it in a test of its own, so a drift on either side reds instead of shipping. In phoenix the
gate's side is `packages/pipeline-cli/src/tools/leak-guard/fabrika-doc-leak-conformance.test.ts`,
which pins the exempt declarations against each other too. `doc-leaks.ts` carries the why; this is
the pointer to it.

The surface anchor: the verb diffs the branch against its base and refuses a surface whose own file
class the diff does not contain (`--surface prose` over a diff with no markdown is `10`) — the
skill's judgment is taken, then checked against the tree, never silently accepted.

**The anchor refuses an absent class, never a present other one.** One rule holds for every surface,
so a diff is runnable under every surface that claims a class in it: `code` runs the CI commands,
`prose` scans the markdown, `plan` checks the ledger grammar, `workflows` lints the workflow YAML,
and each of them names every changed file it did not open in `unvalidated`. A mixed code+markdown
diff is runnable under three of them on that rule — `code` claims its code, and `prose` and `plan`
both claim its markdown. `prose` used to refuse on the *presence* of a code file, which left the
repo's most common diff shape — one `.ts` plus one `.md` — with no invocation that opened the
markdown at all, so the leak scan and the link resolver never ran on it (#5301). The presence of
another class is not a contradiction with the surface; it is exactly what `unvalidated` discloses.

**A named class for "unvalidatable", because an absence cannot be refused.** The anchor sorts each
changed file into code, markdown, workflow YAML, or **none of them** — that last class is named, not
an absence. A diff that is *wholly* it (only `*.sh`, only `*.sql`) refuses on `22` under **every**
surface: no validator covers those files, so any verdict would be a green over an unread tree. The
remedy is to extend a validator to cover the class, never to rename the surface — widening the code
pattern to swallow `.yml` was considered and rejected, because it would claim a repo's code
validators had validated a shell script (#5229). "Split the diff" is not offered as a remedy anywhere here: a lane
cannot split a diff it has already written (#5301).

**The workflow class is that remedy taken, not an exception to it** (#5991). `.github/workflows/**`
sat in the unvalidatable bucket while CI validated it every run, so a lane whose whole diff was
workflow YAML — the diff class where an unvalidated push costs the most, since the repo's own gates
live there — could reach no green under any surface. It is a class of its own rather than part of
`code` for the reason the rejected widening names: its validators are not the code validators.

Its validators are declared, not compiled in: `.fabrika.jsonc`'s `workflowValidators` holds one entry
per command the repo runs over its own workflows, each an argv plus the `reads` list naming the
workflow files that command opens. Phoenix declares none, and that is the ordinary shape rather than
a gap: the commands here that machine-read a workflow all live in `pipeline-cli`, which ADR 0238
forbids any fabrika verb from invoking, so this repo's workflow surface stands on `actionlint` alone
and refuses `11` where that is absent too. `actionlint` runs on top when this tree has it — it is a pinned tarball CI installs at job time and
no repo's dependency, so its absence is the ordinary case and is **disclosed** beside the green
rather than skipped in silence; the gate workflow's own `actionlint` job is the superseding authority
there, as it is for every verdict this verb prints. That workflow is named by `ci.gateWorkflow` in
`.fabrika.jsonc` — phoenix's `ci.yml` when a repo declares nothing, and a bare filename or the load
is refused `11` (#6026, #6298). A declared command that cannot be spawned is the other
polarity: it ships with the repo, so it is `11`, UNKNOWN, naming the command.

What holds both honest is per-file coverage, not a count of what ran. A declared guard takes no path
arguments — it reads the fixed set it names — so "some validator ran" would not tell a reader that
the workflow *this diff changed* was ever opened, and an early cut of this surface greened with an
empty `unvalidated` list over exactly that (#5991). So a changed workflow counts as opened only when
`actionlint` ran over it or a passing declared validator names it in `reads`; every other changed
workflow is listed in the green's `unvalidated` and disclosed on stderr, and a run where **none** of
them was opened — nothing ran at all, or everything that ran reads other files — is `11`, because
that green is exactly the one the named-class design exists to refuse. This is why `reads` is
mandatory and non-empty: an entry that names no file can only buy the false green back.

Preconditions: a readable tree root (`11`), the lane's branch checked out (`14`).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the diff against the branch base is empty — nothing to validate, zero scope |
| `10` | `--surface` is off-enum, or the diff contains none of the file classes that surface's validators open |
| `11` | a validator could not be executed, a changed file could not be read for a reason other than absence, or the lane's claim could not be read — the verdict is UNKNOWN, never green |
| `14` | proven: the checked-out branch is not this lane's (lane-identity rule) |
| `15` | proven: the lane's claim is held by another session |
| `18` | proven red — the failing runner and its diagnostics are on stderr |
| `22` | proven: no changed file falls in any surface's validators — nothing to run, never a green |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build check: <runner> could not be executed: <reason> — the verdict is UNKNOWN, never green.` | 11 | refusal |
| `build check: cannot read the claim markers on #<n>: <reason> — the lane is UNKNOWN.` | 11 | refusal |
| `build check: cannot read <file> (<reason>) — it is in the diff and is not absent, so the verdict is UNKNOWN, never green.` | 11 | refusal |
| `build check: cannot read .fabrika.jsonc (<reason>) — which docs are leak-scan exempt is UNKNOWN, never green.` | 11 | refusal |
| `build check: cannot list the changed markdown at the merge base <sha> (<reason>) — which defects predate this diff is UNKNOWN, never green.` | 11 | refusal |
| `build check: cannot read <file> at the merge base <sha> (<reason>) — which of its defects predate this diff is UNKNOWN, never green.` | 11 | refusal |
| `build check: cannot read .fabrika.jsonc (<reason>) — which commands validate this repo's workflows is UNKNOWN, never green.` | 11 | refusal |
| `build check: no workflow validator could be executed — actionlint is not installed here (<reason>) and this repo declares none — so no file was opened and the verdict is UNKNOWN, never green.` | 11 | refusal |
| `build check: <n> workflow validator(s) ran, but none of them opened any of the <m> changed workflow file(s) (<files>) — actionlint did not run here (<reason>) and no declared validator reads them, so the verdict is UNKNOWN, never green.` | 11 | refusal |
| `build check: no validator that ran opens <files> — reported in \`unvalidated\`, so this green claims nothing about them.` | 0 | scope note beside a green |
| `build check: <n> workflow validator(s) declared in .fabrika.jsonc.` | 0 | scope note |
| `build check: no repo workflow validator is declared — <reason>.` | 0 | scope note |
| `build check: actionlint did NOT run (<reason>) — <ci.gateWorkflow>'s actionlint job supersedes this verdict on workflow syntax.` | 0 | scope note beside a green |
| `build check: <n> leak-scan exemption(s) declared in .fabrika.jsonc.` | 0 | scope note |
| `build check: nothing is leak-scan exempt — <reason>.` | 0 | scope note |
| `build check: #<n> is held by <winning token>, not by the lane on nonce <nonce>.` | 15 | refusal |
| `build check: --surface prose, but the diff changes no markdown file — the surface is provably wrong.` | 10 | refusal |
| `build check: the diff against <base> is empty — nothing to validate (ADR 0092).` | 7 | refusal |
| `build check: red — <runner> failed; diagnostics above.` | 18 | refusal |
| `build check: no surface validates any of the <n> changed file(s) (<files>) — there is nothing here to run, so the verdict is a refusal, never green.` | 22 | refusal |
| `build check: <n> changed file(s) --surface <surface> does not validate — NOT covered by this verdict: <files>.` | 0 | scope note beside a green |

**Scope** — this tree's diff against the branch base. A zero-file diff is `7` — zero scope, never
a green (ADR 0092). A diff no surface validates is `22` — the same rule one step further in: a file
the verb cannot classify is a file it cannot check, and an unchecked file never counts toward a
green. A green's `unvalidated` list is what keeps the partial case honest — and it is scoped to the
surface that ran, so a file another surface would have read counts as uncovered here too.

**Example**

```
$ fabrika build check --surface code
{"verdict":"green","surface":"code","tree":"/private/var/<redacted>/build-4312","ran":["pnpm typecheck --force","pnpm lint:worktree"],"unvalidated":["README.md","scripts/deploy.sh"]}
```

`ran` echoes whatever `codeValidators` resolved to, one `argv.join(" ")` per validator; the two
above are what **phoenix's** `.fabrika.jsonc` declares, not a contract.

**Grounding**

- #4106 / #4887 — the cross-tree cache false green; cache bypass is the design, not an option.
- #5229 — two extension patterns and no third class: a workflow-only diff greened under `--surface
  prose` having opened no file, and refused under `--surface code` with a message pointing at the
  branch that greened. `22` and `unvalidated` are the two halves of that fix.
- #5288 — `unvalidated` was computed from the third class alone, so `--surface code` over
  `["a.ts", "README.md"]` greened with an empty list: the markdown had a validator, just not the one
  that ran. Scoping the list to the surface closes it, and the mirrored `--surface plan` case, with
  one rule.
- #5301 — the disclosure was honest but there was still nowhere to send the markdown: `--surface
  prose` refused whenever one code file was present, so a mixed diff's prose was unscannable under
  every surface. The anchor now refuses an absent class rather than a present other one.
- #5991 — the unvalidatable class swallowed `.github/workflows/**`, so a workflows-only lane refused
  under every surface and pushed the repo's own gates with no in-tree evidence at all. Carved out as
  its own class with its own validators, declared per repo.
- #5304 — the green's disclosure was true at the file-open level and false at the validator level: a
  catch-all `PlatformError` skipped a file nothing could open, and `plan` claimed the whole `markdown`
  class while running only the grammar. A read that did not execute now refuses on `11`, and a
  surface that claims a class runs every validator that class gets.
- v1's discipline was prose-only (`SKILL.md:895-935`, exact-CI-command mandate with no
  enforcement); here the command set is the verb's, not the agent's memory.
- ADR 0092 — zero diff is a refusal, not a vacuous green.
- The gate's own answer supersedes this verdict wherever they disagree; this verb
  predicts, the gate decides (interface convention rule 6).

---

## `build push`

**Invocation**

```
fabrika build push [--force-with-lease] [--drop-remote-commits]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--force-with-lease` | boolean | no | `false` | permit a non-fast-forward update of this lane's own branch (repair resubmission) |
| `--drop-remote-commits` | boolean | no | `false` | publish a head that does **not** contain the published remote head — a deliberate history rewrite |

**Output** — machine, **single-stream: the entire report is stdout**, and the last line is always
exactly one of:

```
PUSH-VERDICT: MOVED
```

on exit 0. `NOT-MOVED` and `UNKNOWN` are exits `17` and `8` with empty stdout and the report on
stderr — so `tail -1` of stdout on exit 0 is always the verdict line. (v1 *documented* this idiom
and then both call sites redirected the report to stderr, so the documented `tail -1` never ran —
`SKILL.md:778-781` vs `step5-push.sh:47`. Here the channel is part of the contract.)

The protocol: resolve the checked-out lane branch and its **push target** — the tracked upstream
ref when one is set (the resume-mode case, where the local name `build/pr-<pr>-<nonce>` publishes
to the PR's remote head branch), else the branch's own name. Push to that target; then
**independently read the target ref on the remote** (`git ls-remote`) and compare against the
local SHA. `MOVED` requires positive evidence; a push that reported success over a target ref
that did not move is `17`; a probe that failed is `8`. Reading back the local *name* instead of
the push *target* would make every repair push a false `17` — the target is the one fact both
halves share.

Refusals before any push (`19`): HEAD is detached; or the update is non-fast-forward and
`--force-with-lease` was not given. `--force-with-lease` is the only force shape — a bare
`--force` flag does not exist here, and there is no `--no-verify` (#4159: the ban is enforced by
the flag not existing).

**Containment is proven on every path, the force path included (`23`).** Whenever the target ref
already exists, the local head must **contain** the SHA a live `git ls-remote` just read off it —
`git merge-base --is-ancestor <remote head> <local head>`. On the plain path that is the
fast-forward test and its failure is `19`; on the force path its failure is `23`, and a lane that
means the rewrite says so with `--drop-remote-commits`, which publishes anyway and records the
drop on stderr.

`--force-with-lease` does not cover this and cannot: a lease compares the remote against what this
clone last saw of it, so it defends the ref against **another** writer, never against **this**
lane's own head having dropped the remote's commits — and a bare lease is "trivially defeated" by
any `git fetch` the lane already ran (`git push`'s own documentation), which the repair path does.
With the ancestry test formerly guarded by `!--force-with-lease`, the documented repair invocation
had no containment evidence at all and the verb's success test (remote SHA equals the lane's own
head) reported the drop as `MOVED` (#5222).

The remote head must be **in this object database** for the ancestry test to mean anything, and a
repair lane's published head may be a commit this clone has never held. So the verb probes for it
and fetches `<remote>/<ref>` once if it is absent; if it is still absent, containment is **UNKNOWN**
and the refusal is `11` — never `23`, which is a *proven* fact about two commits it holds. This is
also why the read is a live `ls-remote` rather than a remote-tracking ref: a tracking ref a
preceding fetch in the same lane already refreshed proves nothing about what is published.

Preconditions: a readable tree root (`11`), the lane's branch (`14`).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `8` | the push was attempted but the remote ref could not be re-read — the outcome is UNKNOWN (the matrix's `8`: an attempted write whose outcome cannot be proven) |
| `11` | the lane's claim could not be read, or the remote head could not be made readable so containment is UNKNOWN — nothing was pushed |
| `14` | proven: the checked-out branch is not this lane's (lane-identity rule) |
| `15` | proven: the lane's claim is held by another session — nothing was pushed |
| `17` | proven: the remote ref did not move |
| `19` | refused before pushing: detached HEAD, or non-fast-forward without `--force-with-lease` |
| `23` | proven: the local head does not contain the published remote head — the push would drop its commits |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build push: HEAD is detached — refusing to guess a branch.` | 19 | refusal |
| `build push: non-fast-forward — pass --force-with-lease only for this lane's own repair resubmission.` | 19 | refusal |
| `build push: the local head does not contain <remote>/<ref> (<sha>) — this push would DROP <commits>. Rebase onto the published head, or pass --drop-remote-commits to rewrite it deliberately.` | 23 | refusal |
| `build push: cannot prove containment — <remote>/<ref> is at <sha>, which this checkout does not hold and could not fetch. Nothing was pushed.` | 11 | refusal |
| `build push: the remote ref did not move (remote <sha> ≠ local <sha>).` | 17 | refusal |
| `build push: pushed, but the remote ref could not be re-read: <reason> — the outcome is UNKNOWN.` | 8 | refusal |

**Scope** — one branch, one remote ref, read back independently of the push's own report.

**Example**

```
$ fabrika build push
pushed build/4312-editor-focus-loss-c1a4d6f8 → origin
remote ref read back: 03135b91
PUSH-VERDICT: MOVED
```

**Grounding**

- #4136 — a push that died mid-hook read as sent; the independent read-back is the design.
- #4468 — v1's `verified-push` could force-move a branch backward from a detached HEAD; the `19`
  refusal removes the case instead of guarding it.
- #4159 — `--no-verify` unenforceable as prose; here unrepresentable.
- #4540 — `--force-with-lease` as the only force shape protects the remote against a stale local.
- #5222 — the ancestry test was guarded by `!--force-with-lease`, so the repair path, which mandates
  the lease, got no containment check; `23` and the explicit `--drop-remote-commits` escape close it.
- #5263 — the same gap reproduced on v1 from a stale *local branch ref*: the rebase is clean, the
  bare lease is defeated by the lane's own fetch, and the verdict is `MOVED`. Containment against a
  live remote read is the only test that catches it.

---

## `build pr`

**Invocation**

```
fabrika build pr 4312 [--partial] <<'EOF'
…the authored body…
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the claimed issue this PR serves |
| `--partial` | boolean | no | `false` | the acceptance criteria are not all met: the body must say `Part of #<n>`, not `Fixes #<n>` |
| stdin | text | yes | — | the PR body |

**Output** — machine. One JSON object: `{"answer": "opened", "number": 4318, "url": "..."}` — or,
when an open PR for this head branch already exists (this lane's own, by claim),
`{"answer": "existing", "number": 4310, "url": "..."}` on exit 0: an idempotent re-run is an
answer, not an error.

The guards, in order, all before any write:

1. **stdin non-empty** (`3`).
2. **no machine-local path** — the imported `leaks.ts` predicates (`5`, `6`).
3. **body shape** (`4`): the `## Deviations` section reads `Found` through the registered
   `deviations` wire format
   ([`packages/fabrika-cli/src/wire/deviations.ts`](../../../../packages/fabrika-cli/src/wire/deviations.ts)) —
   the same module `review deviations` resolves against, so a body this verb accepts can never
   fail that gate as malformed (#5566). That means: the heading is exactly `## Deviations`, and
   under it either the literal `None.` or one or more entries, each stating all four of
   `**Said:**` / `**Did:**` / `**Why:**` / `**Disposition:**`. "None." is content, silence is not,
   and a prose bullet is refused here rather than a review round later (the *truth* of the
   section stays the skill's — a verb can force the author to write, not to be
   honest); exactly one closing-keyword line, targeting `<number>` and matching `--partial`
   (`Fixes #4312` without `--partial`, `Part of #4312` with it); no second closing keyword aimed
   at any other issue (#4471's stray auto-close).
4. **no forbidden classification** (`10`), by a closed pattern set, checked outside code fences
   and block quotes: `/(not[ -])?control[ -]plane/i` (the §CP assertion class, #4153), a
   `type:<word>` label assertion, and a standalone `p[0-3]` priority assertion. The merge gate
   and triage own those verdicts. The pattern set is closed on purpose: two implementers must
   ship the same guard, and a "any spelling" instruction is two guards.
5. **claim confirmed** (`15`/`11`), **target issue open** (`7`).

The PR title is **derived, not the issue title verbatim**
([`packages/fabrika-cli/src/build/pr-title.ts`](../../../../packages/fabrika-cli/src/build/pr-title.ts)):
the served issue's `type:` label maps to a conventional-commit prefix (`type:bug` → `fix`,
`type:feature` → `feat`, everything else → `chore`) ahead of the issue title unchanged, and a title
that already leads with a conventional prefix passes through untouched. The repo squash-merges with
`COMMIT_OR_PR_TITLE`, so on a multi-commit PR this title becomes the commit subject on `main` —
deriving it is what keeps every builder squash parseable by release-please (#5771).

Then create, **re-read the created PR**, and compare body through `normalizeForReadback` (`9` on
mismatch). The write path is `gh api` with the body from a file — never `-f body=@file`, which
posts the literal string (#4683).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin held nothing |
| `4` | the `## Deviations` section does not read `Found` through the `deviations` wire format — absent, empty, a drifted heading, or an entry short a field — or the closing-keyword line is absent, duplicated, mistargeted, or contradicts `--partial` |
| `5` | the body carries a machine-local path |
| `6` | the body is a bare `@` path reference |
| `7` | the issue is proven absent or closed |
| `8` | the create failed — it may or may not have landed; re-run (the verb re-checks for an existing PR first) |
| `9` | the PR landed but the read-back body does not match |
| `10` | the body carries a control-plane (or type/priority) classification claim |
| `11` | a precondition read failed |
| `14` | proven: the checked-out head branch is not this lane's |
| `15` | proven: this session does not hold the claim |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build pr: stdin held nothing — the body is the input.` | 3 | refusal |
| `build pr: the body's "## Deviations" section is not readable — <the wire format's reason>. State each deviation as an entry, or state "None."` | 4 | refusal |
| `build pr: the body says "Fixes #<n>" but --partial was given — a partial PR must say "Part of #<n>".` | 4 | refusal |
| `build pr: the body carries a closing keyword aimed at #<m> — this PR serves #<n>.` | 4 | refusal |
| `build pr: the body carries a machine-local path: <first hit> — redact before posting.` | 5 | refusal |
| `build pr: the body is a bare @ path reference — write the body, not a pointer to it.` | 6 | refusal |
| `build pr: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build pr: the create failed: <reason> — it may or may not have landed; re-run, the verb re-checks for an existing PR first.` | 8 | refusal |
| `build pr: the PR landed (#<m>) but its body does not read back as sent — it needs a human eye.` | 9 | refusal |
| `build pr: the body asserts a control-plane classification — that verdict is the merge gate's.` | 10 | refusal |
| `build pr: cannot read <what>: <reason> — nothing was written.` | 11 | refusal |
| `build pr: #<n> is held by <winning token>, not by the lane on nonce <nonce>.` | 15 | refusal |

The `11`/`14` tree-precondition messages are `build tree`'s rows with the verb name substituted
(shared conventions).

**Scope** — one PR create against one issue. The head branch is the checked-out one; its nonce
must match the claim (`14` via the shared precondition).

**Examples**

```
$ fabrika build pr 4312 <<'EOF'
Fixes #4312

Editor focus now survives a save: the toolbar re-render no longer steals it.

## Deviations

- **Pre-existing test or fixture changed** — **Said:** the fixture asserts focus lands on the
  toolbar after a save. **Did:** rewrote it to assert focus stays in the editor. **Why:** it
  asserted the defect, so keeping it would have red-lit the fix. **Disposition:** stated here;
  no other test covered the old behaviour.
- **Out-of-scope change** — **Said:** #4312 names the editor only. **Did:** also fixed the same
  steal in the comment box. **Why:** both call the one `refocus()` helper this changes, so
  leaving it would have shipped a knowingly half-fixed helper. **Disposition:** stated here.
EOF
{"answer":"opened","number":4318,"url":"https://github.com/kamp-us/phoenix/pull/4318"}
```

The section is `None.` when there is nothing to disclose, and that is a *checked* claim rather than
a skip — `review deviations` reads it beside the diff's Tier-M scan, so a `None.` over a suppressed
lint rule is a falsified disclosure the gate can see in one read.

```
$ printf 'Fixes #4312\n\n## Deviations\n\n- narrowed the scope a bit.\n' | fabrika build pr 4312
build pr: the body's "## Deviations" section is not readable — an entry carries no **Said:**, **Did:**, **Why:**, **Disposition:** — every entry states **Said:** / **Did:** / **Why:** / **Disposition:**. State each deviation as an entry, or state "None."
$ echo $?
4
```

**Grounding**

- #4542 — the Deviations check must block, not warn.
- #5566 — the check and `review deviations` asked for different shapes, so a conforming body was
  guaranteed to fail the gate closed; both now read the one registered `deviations` format.
- #4471 — a stray closing keyword auto-closed an issue the PR did not fix.
- #4153 — a false control-plane negative shipped in a PR body; the claim is now unrepresentable.
- #4683 / #3086 — the `-f body=@file` literal and the temp-path leak; both guarded here.
- #4544-class — idempotent `existing` answer instead of a duplicate PR on a re-run after `8`.

---

## `build pr-body`

**Invocation**

```
fabrika build pr-body 4318 [--partial] [--repo <owner/name>] <<'EOF'
…the authored body…
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<pr>` | positional integer | yes | — | the open pull request whose body is replaced |
| `--partial` | boolean | no | `false` | the acceptance criteria are not all met: the body must say `Part of #<n>`, not `Fixes #<n>` |
| stdin | text | yes | — | the replacement PR body |

**Output** — machine. One JSON object:
`{"answer": "updated", "number": 4318, "url": "..."}`.

The verb exists because a review FAIL whose whole fix is a body edit — the recurring one is a
`## Deviations` section the gate reads as malformed — otherwise had no guarded route at all: `build
pr` answers `existing` and writes nothing, `build push` moves a head that did not need to move, and
the raw `gh` call the repairer fell back to ran none of the create path's guards (#5618).

The guards are `build pr`'s, in `build pr`'s order with **one step moved**: the served issue is read
off the PR before the two guards that name it can run. Everything still happens before any write,
which is what the ordering is for.

1. **stdin non-empty** (`3`); **no machine-local path** (`5`, `6`); **no forbidden classification**
   (`10`) — the three that need no issue number, so they refuse before a single read.
2. **The PR is open** (`7` proven absent, closed or merged; `11` unreadable).
3. **The served issue** is `parseLaneBranch`'d out of the PR's own head ref — `build/<issue>-<slug>-<nonce>`,
   which is the head ref even for a resumed PR, since resume mode checks out `build/pr-<pr>-<nonce>`
   locally and tracks the original. A head that is not a lane branch is `14`. The **body is never the
   source**: the closing keyword is the thing being checked, so reading the issue off it would let a
   mistargeted body validate itself.
4. **Body shape** (`4`) against that issue — identical to `build pr`'s step 3, same `deviations` wire
   format, same closing-keyword and `--partial` rules.
5. **Claim confirmed and this lane addresses this PR** (`15`/`11`/`14`): the checked-out branch is a
   lane whose claim this session holds, and it serves this PR — the resume branch names it, or the
   create branch *is* its head ref.

Then `PATCH repos/<repo>/pulls/<pr>` carrying `body` alone — no title, no base, no ref — and
re-read the PR, comparing through `normalizeForReadback` (`9` on mismatch). The body travels as an
argv value, never `-f body=@file` (#4683).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin held nothing |
| `4` | the `## Deviations` section does not read `Found` through the `deviations` wire format, or the closing-keyword line is absent, duplicated, mistargeted, or contradicts `--partial` |
| `5` | the body carries a machine-local path |
| `6` | the body is a bare `@` path reference |
| `7` | the PR is proven absent, closed or merged |
| `8` | the update failed — it may or may not have landed; re-read the PR before retrying |
| `9` | the body was replaced but does not read back as sent |
| `10` | the body carries a control-plane (or type/priority) classification claim |
| `11` | a precondition read failed |
| `14` | the PR's head is not a lane branch, or the checked-out branch does not serve this PR |
| `15` | proven: this session does not hold the claim |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build pr-body: stdin held nothing — the body is the input.` | 3 | refusal |
| `build pr-body: the body's "## Deviations" section is not readable — <the wire format's reason>. State each deviation as an entry, or state "None."` | 4 | refusal |
| `build pr-body: the body carries a closing keyword aimed at #<m> — this PR serves #<n>.` | 4 | refusal |
| `build pr-body: the body carries a machine-local path: <first hit> — redact before posting.` | 5 | refusal |
| `build pr-body: the body is a bare @ path reference — write the body, not a pointer to it.` | 6 | refusal |
| `build pr-body: PR #<pr> is proven absent, closed or merged — there is no body to rewrite.` | 7 | refusal |
| `build pr-body: the update failed: <reason> — it may or may not have landed; re-read PR #<pr> before retrying.` | 8 | refusal |
| `build pr-body: PR #<pr>'s body was replaced but does not read back as sent — it needs a human eye.` | 9 | refusal |
| `build pr-body: the body asserts a control-plane classification — that verdict is the merge gate's.` | 10 | refusal |
| `build pr-body: cannot read PR #<pr>: <reason> — nothing was written.` | 11 | refusal |
| `build pr-body: PR #<pr>'s head branch "<ref>" is not a lane branch — this verb rewrites a lane's own PR.` | 14 | refusal |
| `build pr-body: the checked-out branch "<branch>" does not serve PR #<pr> — wrong lane.` | 14 | refusal |
| `build pr-body: #<n> is held by <winning token>, not by the lane on nonce <nonce>.` | 15 | refusal |

**Scope** — one body replacement on one open PR. Nothing else about the PR moves: no commit, no
push, no branch, no title, no base.

**Examples**

```
$ fabrika build pr-body 4318 <<'EOF'
Fixes #4312

Editor focus now survives a save: the toolbar re-render no longer steals it.

## Deviations

- **Out-of-scope change** — **Said:** #4312 names the editor only. **Did:** also fixed the same
  steal in the comment box. **Why:** both call the one `refocus()` helper this changes.
  **Disposition:** stated here.
EOF
{"answer":"updated","number":4318,"url":"https://github.com/kamp-us/phoenix/pull/4318"}
```

```
$ printf 'Fixes #4312\n\n## Deviations\n\n- narrowed the scope a bit.\n' | fabrika build pr-body 4318
build pr-body: the body's "## Deviations" section is not readable — an entry carries no **Said:**, **Did:**, **Why:**, **Disposition:** — every entry states **Said:** / **Did:** / **Why:** / **Disposition:**. State each deviation as an entry, or state "None."
$ echo $?
4
```

**Grounding**

- #5618 — no `build` verb rewrote an open PR's body, so a `deviations malformed` FAIL was repaired
  with a raw `gh` call that ran none of the guards. PRs #5556 and #5599 both went out that way.
- #5566 — the `deviations` shape both this verb and `review deviations` resolve against.

---

## `build note`

**Invocation**

```
fabrika build note 4312 --token <token> [--repo <owner/name>] <<'EOF'
…the progress / handoff note…
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue or PR the note posts to — resolved via the REST issues endpoint, whose response carries a `pull_request` key exactly when the number is a PR; the head stamp applies only then |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository written to |
| `--token` | string | yes | — | the token `build claim` handed this lane — which lane is asking (#6037). Not a claim token, or one carrying another session id, is `1` |
| stdin | text | yes | — | the note body |

**Output** — machine. `{"answer": "posted", "number": 4312, "commentId": 512345, "head": "03135b91"}`.
When the target resolves to a PR, the note is **stamped with the PR's current head SHA at post
time** (appended as a final line `— at 03135b91`); a reader can see at a glance that a note
predates a later push — the stale-repair-note class (#4808) made a spot judgment carry no
freshness signal at all.

Guards: stdin non-empty (`3`), leak predicates (`5`, `6`), claim confirmed (`15`/`11`), target
open (`7`), read-back through `normalizeForReadback` (`9`), write-unknown (`8`).

**Exit status** (beyond the universal four): `3`, `5`, `6`, `7`, `8`, `9`, `11`, `15` — triggers
exactly as in `build pr`, minus the body-shape and classification rows (`4`, `10` are
unreachable: a note has no required sections and no closing keywords; a classification *claim* in
a note is prose the reader weighs, not a label the board consumes).

**Errors** — `build pr`'s rows for `3`, `5`, `6`, `8`, `9`, `11` with the verb name substituted
(shared conventions), plus — `15` is written out rather than inherited, because `note` names its
lane with `--token` where `pr` reads it off the branch, so the two verbs refuse in different words:

| Message (stderr) | Code | Kind |
|---|---|---|
| `build note: #<n> is proven absent or closed — nothing to post to.` | 7 | refusal |
| `build note: #<n> is held by <winning token>, not by <caller token>.` | 15 | refusal |

**Example**

```
$ fabrika build note 4310 --token <token> <<'EOF'
Round 2 findings addressed: focus restore moved out of the render path.
EOF
{"answer":"posted","number":4310,"commentId":512346,"head":"03135b91"}
```

**Grounding**

- #4808 — the stale-note class; the head stamp is the design.
- #3086 — leak guards on everything posted.
- Closed-vocabulary coordination (secure-by-default AC 5): the note is prose *on the artifact*;
  any cross-lane signal names kind + action + this branded ref, and the receiver re-fetches.

---

## `build deviations`

**Invocation**

```
fabrika build deviations 6566 --token <token> [--repo <owner/name>] <<'EOF'
## Deviations

None.
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<issue>` | positional integer | yes | — | the epic child the disclosure is for, and the issue the marker sits on. A pull request is `10`: a PR discloses in its body, which is `build pr` / `build pr-body` |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository written to |
| `--token` | string | yes | — | the token `build claim` handed this lane — which lane is asking (#6037). Not a claim token, or one carrying another session id, is `1` |
| stdin | text | yes | — | the `## Deviations` section, read through the `deviations` wire format before anything is written |

**Output** — machine.
`{"answer": "posted", "issue": 6566, "commentId": 900, "upsert": "created", "retracted": 0, "url": "https://github.com/o/r/issues/6566#issuecomment-900"}`.
`upsert` is `"created"` when the child carried no standing marker and `"edited"` when one was
PATCHed in place; `retracted` counts the superseded markers deleted behind it.

**One marker per issue is this verb's invariant** (#6691, [ADR 0285](../../../../.decisions/0285-epic-machine-ends-in-review.md)).
An epic child opens no PR, so its disclosure is a `build-deviations` marker comment; the tail review
reads every child's through `fabrika wire read --format build-deviations`, and that reader refuses
two conforming `## Deviations` headings as undecidable. The rule is held **at this write seam and
not in the reader** — the reader judges bytes on stdin and cannot see which comment is newer, so a
"newest wins" rule there would have it guess at a genuinely ambiguous body. So the verb edits the
standing marker rather than appending, and retracts every superseded marker of this account's that
the format reads as *this* issue's disclosure — the second half is what makes the invariant hold on
a child a pre-fix lane already stacked.

Guards, in order: stdin non-empty (`3`), bare-`@` body (`6`), the section readable through the
`deviations` format (`4`), target is an open issue and not a PR (`7`/`10`), caller token parses
(`1`), claim held (`15`/`11`), leak predicates over the composed comment (`5`), the authenticated
user and the comment list both readable (`11`), write (`8`), read-back (`9`), retraction (`8`).

The marker line is composed from the positional and never taken from stdin, so a disclosure cannot
name an issue other than the one it sits on. Read-back is a re-fetch of the landed comment asserted
twice — through `build-deviations.read`, the contract a tail reviewer runs, and byte-for-byte
against the composed bytes through `normalizeForReadback`. Retraction runs **after** the live
comment reads back, so a write that then fails can never destroy the standing disclosure.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin held nothing |
| `4` | the `## Deviations` section does not read `Found` through the `deviations` wire format — absent, empty, a drifted heading, or an entry short a field |
| `5` | the composed comment carries a machine-local path |
| `6` | the disclosure is a bare `@` path reference |
| `7` | the issue is proven absent or closed |
| `8` | the write failed, or the disclosure landed and a superseded marker could not be retracted — UNKNOWN either way |
| `9` | the comment landed but the read-back does not yield this disclosure |
| `10` | the number is a pull request, which discloses in its body |
| `11` | a precondition read failed — the issue, the authenticated user, or the comment list |
| `15` | proven: this lane does not hold the claim on the issue |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build deviations: stdin held nothing — an absent disclosure reads as "never considered it"; send the "## Deviations" section, or "None." under its heading.` | 3 | refusal |
| `build deviations: the disclosure carries no "## Deviations" heading — <the wire format's reason>.` | 4 | refusal |
| `build deviations: the disclosure is malformed — <reason> (<evidence>).` | 4 | refusal |
| `build deviations: the body carries a machine-local path: <first hit> — redact before posting.` | 5 | refusal |
| `build deviations: the disclosure is a bare @ path reference — write the section, not a pointer to it.` | 6 | refusal |
| `build deviations: #<n> is proven absent or closed — nothing to disclose on.` | 7 | refusal |
| `build deviations: the write failed: <reason> — UNKNOWN whether the disclosure landed; re-read #<n> before retrying.` | 8 | refusal |
| `build deviations: the disclosure landed on comment <id>, but <k> superseded marker(s) could not be retracted (<ids>) — #<n> still carries more than one, so \`fabrika wire read --format build-deviations\` reads it as malformed; delete them and re-run.` | 8 | refusal |
| `build deviations: posted (comment <id>) but the read-back does not yield this disclosure (<why>) — it needs a human eye.` | 9 | refusal |
| `build deviations: #<n> is a pull request — a PR discloses in its body, and this marker is the epic child's surface (ADR 0285). Use \`fabrika build pr\` or \`fabrika build pr-body\`.` | 10 | refusal |
| `build deviations: cannot read #<n>: <reason> — nothing was written.` | 11 | refusal |
| `build deviations: cannot read #<n>'s comments: <reason> — nothing was written; a partial list would stack a second marker.` | 11 | refusal |
| `build deviations: cannot read the authenticated user: <reason> — nothing was written.` | 11 | refusal |
| `build deviations: #<n> is held by <winning token>, not by <caller token>.` | 15 | refusal |

**Scope** — one issue's marker, written by one claim-holding lane. It runs the posting guards only,
never the tree assertions: a child's disclosure is composed from the branch's work but the comment
is not a git write, and gating it on the tree would strand a disclosure a repair round owes. It
never touches a PR body, never posts a second comment, and deletes nothing but a superseded marker
of this account's that reads as this same issue's disclosure.

**Example**

```
$ fabrika build deviations 6566 --token <token> <<'EOF'
## Deviations

- **Scope narrowing** — **Said:** #6566 names the ledger row and its header. **Did:** wrote the
  row only. **Why:** the header is another child's file. **Disposition:** stated here.
EOF
{"answer":"posted","issue":6566,"commentId":900,"upsert":"edited","retracted":1,"url":"https://github.com/o/r/issues/6566#issuecomment-900"}
```

**Grounding**

- #6691 — a repair round's second marker made the disclosure unreadable through `wire read`, and
  stranded the tail review of epic #5843 on children #6566 and #6567.
- [ADR 0285](../../../../.decisions/0285-epic-machine-ends-in-review.md) — an epic child opens no
  PR, which is why the disclosure surface is a comment at all.
- [ADR 0228](../../../../.decisions/0228-scripts-relay-never-derive.md) — the skill's hand-rolled
  `gh issue comment` is the glue a verb is supposed to own.
- `packages/fabrika-cli/src/review/post-verb.ts` — the upsert spine this verb mirrors: viewer,
  list, edit-or-create, read back. It keys on the head because a verdict is head-bound; a
  disclosure carries no head, so this verb keys on the issue.
- #3173 — a write call's own echo is not evidence; the read-back is a re-fetch.

---

## `build verdicts`

**Invocation**

```
fabrika build verdicts --pr 4310 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | exactly one of `--pr` / `--issue` | — | the pull request whose verdict state is folded |
| `--issue` | integer | exactly one of `--pr` / `--issue` | — | the epic child whose range-scoped verdicts are folded |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository read |

**Output** — machine. One JSON object:

```
{"head": "03135b91", "rows": [
   {"gate": "review-code", "polarity": "FAIL", "sha": "03135b91", "current": true,
    "commentId": 512001, "kind": "marker", "body": "review-code: FAIL @ 03135b91 — the debounce fix races the unmount; see inline notes."},
   {"gate": "native-review", "polarity": "CHANGES_REQUESTED", "sha": null, "current": null,
    "reviewId": 98001, "kind": "native", "body": "…the review's text…"}
 ],
 "rounds": 2, "capReached": false,
 "clearances": [{"round": 3, "at": "2026-08-18T07:16:03Z", "by": "usirin", "commentId": 512400,
                 "authorization": 512399, "honoured": true}],
 "frozenCriteria": [{"text": "add an e2e for the empty-list case", "appendedRound": 3}]}
```

(`frozenCriteria` rows carry `text` and `appendedRound`; the array is empty when nothing was
appended past the freeze. **Each row's `body` is the finding's full text, passed through the
content gate** — the repair loop consumes findings from here and never raw-fetches a comment,
which is what keeps AC 3's one-door property over the repair path. `capReached` is
`rounds >= <the cap>`, where the cap is the `CAP_ROUND` in `src/retry-budget.ts` — the package's one
declared retry budget — raised to the round after the highest one the founder cleared through
`build clear`; it is computed here so the cap is a field read, not a number remembered.)

**Cleared rounds.** `clearances` lists every `cap-cleared` marker on the PR, judged. A row is
`honoured` only when four clauses hold: its author is in `.fabrika.jsonc`'s `capClearAuthors` set at
the PR's **base** ref, that author holds `write+` at the repository ACL read live (ADR 0055 — the
configured set narrows the ACL, it never replaces one, ADR 0294), the round it names is at or past
`CAP_ROUND`, and a dated authorization comment from that same author sits **immediately before** it
and is not itself a `cap-cleared` marker — the strict adjacency `grill rule` enforces, because
without it a second bare marker rests on the first grant's own dated marker and every grant after
the first is authorized by nothing. A row that misses carries the `reason` it missed and grants
nothing; the ACL is read only for authors the configured set already names. The cap is the round
**after** the highest honoured round, so a grant stamped at any round buys exactly the round it
names and a re-posted grant buys one round and not two — the old `CAP_ROUND + <grants>` tally held
that only when the grant landed at exactly `CAP_ROUND`, and a grant past it was inert (#6137).
Because a clearance binds the *round* rather than a head SHA, it survives the push it exists to
permit and is spent the moment the next FAIL round lands. A read that cannot complete —
the config file, a configured team's membership, a named author's permission — is `11`, never an
empty set.

The fold: resolve the PR's current head; fetch **every** comment and **every** review, paginated
in full; parse each comment through the imported `verdict-marker` read; keep the latest marker
per gate namespace; bind each to the current head (`current: true|false` — a stale marker is
visible *as stale*, never dropped, because "the FAIL is old" and "there is no FAIL" are different
facts, #4105's class). **Native reviews are their own row kind**, not coerced into markers —
whether a `CHANGES_REQUESTED` with no marker drives a repair is the open decision #4555; this
verb reports the state honestly and pre-rules nothing. `rounds` counts the distinct heads the FAIL
markers name, computed over the *full* comment set (v1 counted off a truncated 100-comment
snapshot, `stepR-round-count.sh` + `stepR1-verdicts.sh:48`). **The rule, exactly:** take every
FAIL-polarity marker comment; the distinct head SHAs they name — matched by the same prefix rule
that binds a verdict to a head, so an abbreviation and the full SHA are one head — are the rounds.
A round is one graded head, so two gates grading one head are one round however far apart they
post. A FAIL naming no readable head cannot join a head's round and is never dropped: those
cluster among themselves by the inclusive 120-second gap (#4570's boundary, now the fallback's
only home) and the clusters are added to the head count. Counting by wall clock was #6137 — gate
latency read as repair effort and burned the cap at twice the real rate. `frozenCriteria` lists
review-appended acceptance-criterion rows dated at or past `CAP_ROUND`.

**`{"rows": [], ...}` on exit 0 is a proven "no verdicts", readable against the scope line's
comment/review counts. An unreadable page is `11` — never a shorter list.** All content passes
the content gate.

**The child arm (`--issue`).** An epic child opens no PR (ADR 0285), so the same fold is asked of the
range-bound comments on the child issue (ADR 0276) — this is where a lane sent to repair by
`build claim --resume` reads its findings, through a verb rather than a raw fetch. Each row names the
`range` it was formed over instead of a `sha`/`current` pair, `kind` is `range-marker`, and there is
no `head` and no `frozenCriteria`, because neither exists on this surface. A round is one graded
**tip** — the range analogue of one graded head, folded through the same counter — so two gates over
one range are one round. `clearances` is always empty and stderr says why: a grant is recorded
against a PR's base branch and a child has none, so a child at its cap escalates to the operator
rather than reading a grant with nowhere to live. A comment reaching for the range format and missing
it is named on stderr, never dropped.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent or closed; or `--issue`'s number is proven absent, or is a pull request |
| `10` | neither `--pr` nor `--issue` was given, or both were |
| `11` | the head, any comment page, any review page, or the grant-author set could not be read — the fold is UNKNOWN, never partial |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build verdicts: PR #<n> is proven absent or closed.` | 7 | refusal |
| `build verdicts: cannot read <what> (page <k>): <reason> — the verdict state is UNKNOWN, never "none".` | 11 | refusal |
| `build verdicts: cannot read the recorded cap clearances: <reason> — whether the budget is spent is UNKNOWN, never "capped".` | 11 | refusal |
| `build verdicts: give either --pr <n> or --issue <n>, never both and never neither.` | 10 | usage error |
| `build verdicts: #<n> is a pull request — its verdicts are head-bound; drop --issue and pass --pr.` | 7 | refusal |

**Scope** — one PR: its head, all comments, all reviews. The stderr scope line names the head SHA
and both counts, so an empty `rows` is auditable as "N comments read, none carried a marker".

**Example**

```
$ fabrika build verdicts --pr 4310
{"head":"03135b91","rows":[{"gate":"review-code","polarity":"FAIL","sha":"03135b91","current":true,"commentId":512001,"kind":"marker","body":"review-code: FAIL @ 03135b91 — the debounce fix races the unmount; see inline notes."}],"rounds":1,"capReached":false,"frozenCriteria":[]}
```

**Grounding**

- #4105 — a FAIL visible on the PR read back as "none"; polarity and staleness are both explicit
  here.
- #4926-class / `stepR1-verdicts.sh:48` — un-paginated comment reads truncated the fold's input.
- #4570 — the round-count boundary condition, pinned by a required unit test.
- #4555 (open decision) — native-review rows are reported as their own kind, never coerced;
  the ruling lands as a change to the *skill's* routing, not to this verb.
- ADR 0092 / #4208 / #4219 — a proven-empty fold and an unreadable fold sit on different codes.
- #5959 — a founder-cleared round had no representation either enforcement site could read, so it
  could only land as an edit outside the loop; `clearances` is that representation.

---

## `build clear`

**Purpose** — record the founder's clearance of one extra repair round on a PR, as data both
enforcement sites read. The operator's verb, never the builder's: a builder that reads a spent cap
escalates (`ESCALATED`), and this is what an authorized human runs so the next round can be built
inside the loop instead of as an edit outside it (#5959).

**Invocation**

```
fabrika build clear --pr 5953 --authorization authorization.md [--lane-root <dir>] [--task <id>] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request whose repair budget is cleared |
| `--authorization` | path | yes | — | a file quoting the founder's authorization verbatim, carrying an ISO-8601 date |
| `--lane-root` | string | no | `.fabrika/lanes` | the lanes root the local half of the grant is recorded in |
| `--task` | string | no | the lane's only task | the lane task the grant addresses, on a multi-task lane |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository written |

**Output** — machine. One JSON object:

```
{"pr": 5953, "round": 3, "at": "2026-08-18T07:16:03Z", "by": "usirin",
 "authorization": 512399, "marker": 512400, "cap": 4,
 "lane": "recorded on issue in .fabrika/lanes/5941/events.jsonl", "resolvesTo": "cleared"}
```

`resolvesTo` is `cleared` when this run posted the grant, and `reconciled` when the grant was already
on the PR and only the lane was written; on `reconciled` the `at`, `by`, `authorization` and `marker`
fields are the landed grant's, not this run's.

**Who may grant** — an account that is **both** named by `.fabrika.jsonc`'s `capClearAuthors`, read
at the PR's **base** ref so a PR cannot widen the set that clears its own cap, **and** resolved to
`write+` at the repository ACL at the moment it runs. The configured set narrows the ACL, it never
replaces one (ADR 0294): a committed file has no author gate (ADR 0055), so widening the file grants
nothing to an account with no collaboration. Entries are `@user` or `@org/team`, both as GitHub
writes them; a team is expanded through its membership, and a membership or permission that cannot
be read is `11`, never a grant and never a refusal. An absent file, an absent key, an empty array and
a malformed entry are all *nobody may grant* — fail-closed on every axis (ruled 2026-08-18: the
grant-author set is repo configuration, not a compiled-in "founder" concept).

**The clauses are conjunctive**, and any miss resolves to *not cleared*: the PR is open, the budget
is actually spent (`rounds >= ` the current cap — clearing an unspent budget would pre-arm a round
nobody has needed), the invoking account is in the set and above the write floor, and the
authorization is present and dated. A bare stamp is void (#4938), which is why `--authorization` is
required rather than inferred.

**Write ordering is an invariant.** The authorization comment lands first, the `cap-cleared` marker
second, the lane's local bump last. An interrupted run that wrote the marker first would leave a
void grant a careless reader folds as budget; the order used leaves, at worst, a quote that grants
nobody anything, or a lane that freezes one round early until a re-run reconciles it. **One grant is
one round**, keyed by the round it names: it survives the push it exists to permit, and the next
FAIL round spends it.

**A re-run for a round already granted reconciles; it never re-grants.** Once the marker has landed,
the cap it raised is itself the reason the budget test would say "not spent", so a run that finds an
honoured grant at the current round count *skips* the budget test and both writes, and does only the
half that is still undone — the lane's local bump. It answers `resolvesTo: "reconciled"` at exit 0,
carrying the existing marker's ids, so exit `29`'s stated remedy is a command that runs rather than
advice. The lane write is a set insert, so a lane that already took the round answers `already held`
and nothing is doubled.

**What `cleared` proves, exactly.** That a configured account posted a marker naming a round whose
budget was spent, with a dated authorization comment beside it. It does not prove the quoted
authorization is a truthful record of what the founder said; nothing mechanical can, and in a repo
where agents run on a configured account's own token the agent's restraint is what holds — the same
residue `grill rule` carries (#4441).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `5` | the authorization carries a machine-local path |
| `6` | the authorization is a bare `@` path reference |
| `7` | the PR is proven absent or closed, or its budget is not spent — there is no round to clear |
| `8` | a write failed — UNKNOWN; read the PR before re-running |
| `9` | the marker posted and does not read back |
| `11` | a precondition read failed — the config, a team's membership, the invoking account's permission, the comments, the clock |
| `25` | the invoking account is not in the configured grant-author set, or resolves below `write` at the ACL |
| `26` | `--authorization` is missing, empty, or undated |
| `29` | the grant is recorded on the PR and the local lane did not take it — re-run to reconcile |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build clear: --authorization <path> is empty — a clearance with no quoted authorization is void (#4938).` | 26 | refusal |
| `build clear: --authorization <path> carries no ISO-8601 date — the authorization must be dated.` | 26 | refusal |
| `build clear: #<n> has <k> round(s) against a cap of <c> — the budget is not spent, so there is no round to clear.` | 7 | refusal |
| `build clear: <login> is not in .fabrika.jsonc's grant-author set at <ref> — refusing to record a clearance.` | 25 | refusal |
| `build clear: <login> resolves to <level> on <repo>, below write — authority is the ACL's, never .fabrika.jsonc's alone (ADR 0055).` | 25 | refusal |
| `build clear: cannot resolve <login>'s repository permission: <reason> — authority is UNKNOWN, never granted. Nothing was posted.` | 11 | refusal |
| `build clear: the clearance is recorded on #<n> as comment <id>, and the lane at <path> still did not take it: <reason> — the lane still freezes.` | 29 | refusal |
| `build clear: the authorization comment landed as #<id> and the marker write failed — the clearance is INCOMPLETE and grants nothing. Read #<n> before re-running.` | 8 | refusal |
| `build clear: the clearance is recorded on #<n>, and the lane at <path> did not take it: <reason> — the lane still freezes. Re-run to reconcile; the grant is not doubled.` | 29 | refusal |

**Scope** — one PR: its comments (for the round count and the recorded grants), the config at its
base ref, the invoking account's repository permission, and the lane its closing keyword names. The stderr scope line states the round count and
the cap it is judged against, so a refusal is auditable without a second read.

**Example**

```
$ fabrika build clear --pr 5953 --authorization authorization.md
{"pr":5953,"round":3,"at":"2026-08-18T07:16:03Z","by":"usirin","authorization":512399,"marker":512400,"cap":4,"lane":"recorded on issue in .fabrika/lanes/5941/events.jsonl","resolvesTo":"cleared"}
```

**Grounding**

- #5959 — the cap was enforced in two places and neither could see a founder's clearance, so a
  cleared round could only land as a driver-side edit outside the loop.
- #4938 — a bare stamp is void; the quoted, dated authorization is what a ruling means, and it must
  be the comment immediately before the marker.
- #981 — repo configuration is read at the base ref, never from the PR that would change it.
- ADR 0055 / ADR 0294 — authority is the live ACL's; the configured set narrows it, never replaces it.

---

## Completeness self-test

Per the [interface convention](../../docs/cli-interface-convention.md) Part 2: every flag above
carries a type and default; every stdout shape has a literal example; every non-zero code is
enumerated with its trigger (per-verb tables own `3`+; the universal `0/1/126/127` are stated once
in the shared matrix, which owns every code's single meaning); every error names message, stream,
and code; every judging verb states scope and zero-scope behavior; and no clause defers to a v1
script, another skill's prose, or the authoring session. The three hand-checks the brief's
lineage demands: every reachable outcome above was walked against its verb's failure modes; every
example value is derivable from its verb's stated rules (the nonce from the claim token, the
verdict line from the protocol); and sibling verbs guard shared preconditions identically
(`branch`/`commit`/`check`/`push` run `tree`'s assertions; `pr`/`pr-body`/`note`/`deviations` run the same posting guards on
the same codes, and `commit` runs the same authored-text guards on `3`/`5`/`6`).
