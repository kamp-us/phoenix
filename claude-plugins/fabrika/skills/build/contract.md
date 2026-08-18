# `/build` — derived CLI contract

**Skill:** [`build`](SKILL.md) · **Authoring brief:** [#4707](https://github.com/kamp-us/phoenix/issues/4707) · **Date:** 2026-08-08

**Amended 2026-08-09** — the campaign-scope admission term ([ADR 0245](../../../../.decisions/0245-campaign-scope-fence-binds-both-seams.md), [#5013](https://github.com/kamp-us/phoenix/issues/5013)): a new [admission test](#admission-test--scope-admission-and-the-audience-axis) section under shared conventions — scope admission composed with the pre-existing `ready-for:` audience axis, two named axes rather than one widened term — two codes (`20`, `21`) in the shared exit matrix, and the consuming clauses in `build pick` and `build claim`.

**Amended 2026-08-10** — the third file class in `build check` ([#5229](https://github.com/kamp-us/phoenix/issues/5229)): a changed file matching neither the code nor the markdown pattern is now named rather than dropped out of both filters, so a diff nothing validates refuses on a new code (`22`) instead of greening, and a green over a partly-unvalidatable diff carries the files it did not cover.

**Amended 2026-08-13** — `build commit` ([#5484](https://github.com/kamp-us/phoenix/issues/5484)): the group had no commit verb, so the message-carrying path at every call site was improvised and nothing asserted the message on the resulting commit. A lane's improvised `git commit -F <leaf>` read back a two-day-old message from another lane and committed it, silently, with every command exiting 0. The verb prescribes the carrying path, tests the numbers the message names against this lane's claim, and reads the message back off the created commit — plus one code (`24`) in the shared exit matrix.

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
  machine-local-path predicates. `build pr` and `build note` import them.
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
- **A CI-rollup reader.** `ci.yml` owns redness; the review/ship stages read it. `build check` is
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
| `build eligible` | one issue's dependency gate: `eligible` / blocked-by-named-edge / UNKNOWN | derivable entirely from the parent ledger's `## Dependencies` and issue states |
| `build claim` | race the earliest-authorized claim on an issue; win, or name the winner | a deterministic race protocol; *what to do on a loss* stays in the skill |
| `build confirm` | re-prove this session still holds the claim before a mutation | a lookup with a defined answer |
| `build release` | retract this session's own claim | a guarded single write |
| `build issue` | the claimed issue's body + parsed acceptance criteria, through the content gate | fetch + parse via the wire module; *judging* the criteria stays in the skill |
| `build branch` | cut (or resume) the lane's nonce branch off a freshly fetched base | fetch, derive, create — the nonce is a function of the claim token |
| `build scratch` | the per-lane scratch path, allocated fail-closed | deterministic path derivation keyed session + issue + claim nonce |
| `build commit` | create this lane's commit from an authored message, and prove the commit carries it | a prescribed carrying path, a claim test over the numbers named, and a read-back — no judgment; *authoring* the message stays in the skill |
| `build check` | run this surface's validators in this tree, cache-bypassed; green/red/unknown | command execution + tree-binding assertions; *fixing red* stays in the skill |
| `build push` | publish the branch and independently confirm the remote ref moved | push + `ls-remote` read-back, three proven outcomes |
| `build pr` | open the PR from a stdin body, refusing the known defect shapes, with read-back | mechanical guards over an authored body; *authoring* stays in the skill |
| `build note` | post a progress/handoff comment, head-stamped, leak-guarded, with read-back | as `report note`, plus the head stamp |
| `build verdicts` | the paginated, current-head, per-gate verdict fold on a PR | fetch-all + fold via the wire module; *acting on rows* stays in the skill |

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
  `check`, `push` and `pr` run the same tree assertions `tree` runs, with the same codes (`note` runs only
  the posting guards — a stop-report must remain postable from a refused tree) — a sibling that
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

**Two axes, composed — not one widened term.** What both seams run is an **admission test** built
from two separate questions, computed together and answered together:

- **Scope admission** — is the issue inside the campaign in **exclusive focus**? This is the term
  [ADR 0245](../../../../.decisions/0245-campaign-scope-fence-binds-both-seams.md) coins, and it
  names campaign membership and nothing else. Refusal is `20`.
- **The audience axis** — is the issue's `ready-for:` label `ready-for:agent`? This axis is older
  than the fence (#4780); `build pick` already carried it, and ADR 0245 asks for the scope axis to
  be added **beside** it, not folded into it. Refusal is `21`, and it binds a **build-purpose** claim
  only (see `build claim`'s `--purpose`, #5175) — and not even that one when the claim repairs an
  open PR whose served issue is `type:decision` (#5914).

**Keep the two names apart.** *Scope admission* is a different question from the audience axis (who
the work is for), from dependency eligibility (`build eligible` asks whether an issue's predecessors
are done), from priority (a home confers no band, ADR 0219), and from the milestone pick-order
tiebreaker (ADR 0072) — the same not-this list ADR 0245 draws. Among admitted issues the ranking is
unchanged, and a scope refusal never reads as blocked — `16` is `build eligible`'s alone, and no
scope outcome borrows it. This section is the term ADR 0245 asks this contract to carry, at exactly
the width the ADR gives it; the composition with the audience axis is stated here so no reader has
to infer that the coined term swallowed a second question.

**One module, two call sites.** Both axes are evaluated in exactly one place —
`packages/fabrika-cli/src/build/scope-admission.ts` — and that module is **imported** by `build pick`
and `build claim`. Neither seam re-derives either axis, and no verb exists whose only behaviour is
relaying them (the wrapper shape ADR 0238 bans). A second implementation is banned outright: a board
where the picker and the claim step disagree about what is admissible is worse than no fence at all.
The file is named for the axis this contract adds; it **hosts** the audience axis rather than
redefining it, and the two axes stay separately named, separately seated and separately reported
everywhere the module is consumed.

**Both seams, because the pool filter alone has a hole.** Filtering the offered pool is the browse
path. An operator can hand a verb an issue number directly, and a directly-handed number passes
through no pool — so the claim seam runs the same predicate before it writes any marker. Dropping
either one is a hole: without the claim refusal the direct handoff is unfenced, without the pool
filter every off-campaign issue is still offered and the refusal only arrives after an agent has
chosen.

**The inputs, and where each is read.**

- **The declared focus** — the `## Focus` section of the repository's root `ROADMAP.md`. Its grammar
  is canonical here, so an implementer needs no other document:

  ```
  | Milestone | Declared   |
  |-----------|------------|
  | #44       | 2026-08-09 |
  ```

  The table carries **at most one** data row. `Milestone` is `#<int>`, the milestone in exclusive
  focus; `Declared` is the ISO `YYYY-MM-DD` date it was declared. A **missing section and a
  present-but-empty table are the same well-formed default** — no focus is declared. More than one
  data row, a milestone cell that is not `#<int>`, or a date that is not ISO is **malformed** (`4`),
  and malformed is never read as "no focus".
- **The subject** — *which* record the two axes read. An issue is its own subject. A **pull request
  is not**: it carries no milestone and no `ready-for:` label, so a test reading the PR's own record
  refused every repair claim while any focus was declared ([#5562](https://github.com/kamp-us/phoenix/issues/5562)).
  A PR resolves to the issue its lane serves — the first closing keyword in its body, else `Part of
  #<n>`, the same reference `review scope` reads — and **both** axes then read that issue. A PR whose
  body names no readable issue is `refused: no-served-issue` under a declared focus (`20`, and
  overridable like any scope refusal): the fence cannot judge a ticket nobody named, and admitting it
  would let a lane past the focus by omitting one line from a body. **The resolution runs whether or
  not a focus is declared** — the audience axis reads the served issue either way — and only the
  scope refusal is gated on a declaration: while the fence is inert a PR naming no readable issue
  falls back to its own record instead of refusing. A served issue that **cannot be read** is
  `unknown` at either setting (`11`, and not overridable), which is the `unknown` row below.
- **The issue's home** — the number of the open milestone the issue is homed in, as a string; or, for
  an issue carrying a standing-lane label, that label.
- **The issue's audience** — its `ready-for:` label.

**The outcomes — state words, never a boolean.** The admission test returns exactly one across
both axes, and every refusal carries its reason and names which axis refused:

| Outcome | Trigger | Seat |
|---|---|---|
| `admitted` | a focus is declared and the issue's home is that milestone; or the issue carries a standing-lane label; or no focus is declared | kept in the pool · the claim proceeds |
| `refused: out-of-focus` | a focus is declared, the issue's home is some other milestone or no milestone, and no standing-lane label exempts it | `20` |
| `refused: no-served-issue` | a focus is declared and the target is a pull request whose body names no readable issue — neither a closing keyword nor `Part of #<n>`, or one naming an issue proven absent | `20` |
| `refused: audience-not-agent` | the issue carries a `ready-for:` label other than `ready-for:agent`, or carries none at all — absence is an unknown audience, never an agent audience (#4780) | `21` |
| `unknown` | the declaration or the issue's home could not be read (`11`), or the declaration is malformed (`4`) | `11` / `4` |

**The two refusals are separately named and separately seated**, never one collapsed "refused": they
come from the two different axes, they have different remedies (edit the focus row, or re-label the
audience), and the per-issue exclusion reason `build pick` reports is derivable only if the outcome
set keeps them apart.

**The standing-lane exemption, named.** Exactly two labels — `wayfinder:backlog` and
`axis:pipeline-hardening` (ADR 0208) — are **admitted on the scope axis whatever the declaration
says**, and carrying no milestone is not an exclusion for them. A standing lane is milestone-less by
design, so a fence keyed on milestone-presence alone would starve it. The exemption is the label
match and nothing else: bare milestone-absence never confers it, and no third label inherits it
without a founder ruling. The audience axis still applies to a standing-lane issue.

**No declaration ⇒ inert and visible, never a refusal.** With no focus declared, every issue is
admitted on the scope axis and **both seams say so on their scope line**: `focus: none declared —
scope fence inert`. Declaring nothing is the off switch; a fence that refused on absence would wedge
the pipeline the moment nobody had declared a focus, and an operator must be able to see from the
run that the fence is off rather than infer it from an unshortened pool.

**Unreadable ⇒ UNKNOWN, never admitted.** A declaration that cannot be read, and an issue whose home
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
out-of-focus issue names its number and overrides where the lane actually opens. **`build confirm`
and `build release` never run the fence** — it decides what may *start*, so a focus row edited
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
| `16` | proven: the issue is blocked — the open dependency edge is named on stderr |
| `17` | proven: the push completed but the remote ref did not move |
| `18` | proven: this tree's validation is red |
| `19` | refused: the requested push is unsafe (detached HEAD, or a non-fast-forward without `--force-with-lease`) |
| `20` | proven: not admitted on the scope axis, out of focus — the issue's home is not the declared milestone and no standing-lane label exempts it |
| `21` | proven: not admitted on the audience axis, audience not agent — the issue's `ready-for:` label is not `ready-for:agent`, or is absent |
| `22` | proven: every changed file falls outside all three surfaces' validators — there is nothing to run, so the verdict is a refusal, never a green |
| `23` | proven: the local head does not contain the published remote head — the push would drop its commits |
| `24` | proven: `git commit` ran and HEAD did not move — no commit was created |
| `127` | the verb never ran at all (unresolved binary — the shell's code, not this process's) |

**`7` versus `11` is the split the whole group rests on** (the `wire` group's `ABSENT` vs
`ARTIFACT_UNKNOWN` distinction, `packages/fabrika-cli/src/wire/codes.ts`): a 404 is a verdict about the repository; a
5xx or timeout is a verdict about nothing. No verb fuses them, and no error message is worded
"does not exist, or is not readable".

---

## `build tree`

**Invocation**

```
fabrika build tree [--require-clean] [--issue <n>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--require-clean` | boolean | no | `false` | additionally refuse a tree with any uncommitted change — the lane-open posture |
| `--issue` | integer | no | — | additionally prove the checked-out branch carries this claim's nonce — the pre-mutation posture |

**Output** — machine. One line, the tree root's absolute path, newline-terminated. This verb
**reads and never repairs**: it creates nothing, cleans nothing, removes nothing. It also asserts
nothing about *where* the tree is — that is the operator's call, not fabrika's (#5386).

The two assertions, each proven from git state alone:

1. **Clean at open** (`--require-clean`) — any uncommitted change is `13`. A fresh tree carrying
   an unauthored hunk is not yours to keep *or* to clean (#2666).
2. **This lane's branch** (`--issue`) — the checked-out branch parses as a lane branch whose
   number is `--issue` and whose nonce matches this session's confirmed claim (the lane-identity
   rule, defined in `build branch`); a foreign, wrong-number, or nonce-less branch is `14`. No
   stamp file exists to check: ownership is derivable, not recorded.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `11` | the tree root could not be read, or with `--issue` the claim state could not be read — UNKNOWN |
| `13` | proven: uncommitted changes present at a `--require-clean` open |
| `14` | proven: the checked-out branch does not carry this claim's nonce |
| `15` | proven: the claim on `--issue` is foreign |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build tree: cannot read the tree root: <reason> — the ground is UNKNOWN.` | 11 | refusal |
| `build tree: <n> uncommitted change(s) at open — refusing; an unauthored hunk is not yours to keep or clean.` | 13 | refusal |
| `build tree: the checked-out branch "<name>" does not carry claim <token>'s nonce — wrong lane.` | 14 | refusal |
| `build tree: cannot read the claim markers on #<n>: <reason> — the lane is UNKNOWN.` | 11 | refusal |
| `build tree: #<n> is held by <token>, not this session.` | 15 | refusal |

**Scope** — not a judging verb: it reads this process's git state and, with `--issue`, one claim.

**Examples**

```
$ fabrika build tree --require-clean
/private/var/<redacted>/lanes/build-4312
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
`{"pool": [...], "excluded": [...], "scanned": {"p0": n, "p1": n, "p2": n}, "focus": {...}}`.
Each pool entry: `{"number", "title", "priority", "type", "home"}` — `home` is the open
milestone's number as a string, or the standing-lane label (`wayfinder:backlog` /
`axis:pipeline-hardening`) for a lane-exempt issue. Ranked `p0` → `p1` → `p2`, milestone order
within a bucket. **An empty pool is a fact and prints `{"pool": [], ...}` on exit
0** with the scanned counts proving what was searched — never an empty stdout (interface
convention rule 2).

**Each scope-excluded issue is reported with its reason**, so a shortened or empty pool is auditable
from the answer itself rather than only from the counts. Each `excluded` entry is
`{"number", "home", "reason"}`, where `reason` is one of `out-of-focus` / `audience-not-agent` /
`unreadable` — the outcome set of the [admission test](#admission-test--scope-admission-and-the-audience-axis),
one reason per outcome. The scanned counts alone cannot tell a working fence from a broken one; the
reasons can. `focus` is `{"state": "declared", "milestone": "44"}` or `{"state": "none"}`, the same
fact the stderr scope line carries.

The filter, fail-closed on every axis:

- `status:triaged` present, `status:` nothing-else;
- **admitted by the shared admission test** imported from
  `packages/fabrika-cli/src/build/scope-admission.ts` — this verb re-derives nothing. The test
  composes two axes: **scope admission** (an issue whose home is outside the declared focus is
  excluded, with the two standing-lane labels — `wayfinder:backlog` and `axis:pipeline-hardening` —
  admitted whatever the declaration says, because a standing lane is milestone-less by design and a
  milestone-presence fence would starve it) and the pre-existing **audience axis** (`ready-for:agent`
  present; an issue with no `ready-for:` label is excluded, since absence is an unknown audience,
  never an agent audience — #4780, the negative test the brief's acceptance criterion names). With
  **no focus declared** the scope axis admits everything and the fence is reported inert on the scope line and
  in `focus`; a **failed read of the declaration** makes the whole pool `11`, never an unfiltered
  pool — an unfiltered pool on a failed read is the fail-open shape the fence exists to remove. An
  individual issue whose home the listing named but the repository does not resolve is excluded with
  reason `unreadable`, never admitted. This verb takes **no override**: overriding happens at
  `build claim`, where the lane actually opens.
- **unassigned.** Any assignee excludes — assignment is the one attribute that keeps a human's
  document out of this pool (#4764, #4693).
- `type:` is one of `feature` / `chore` / `bug` / `investigation`. `type:decision` and `type:epic`
  never enter; a rendered-visual deliverable is excluded by the *skill* at reading time, not by
  this verb, because modality is not a label.
- open, and not a pull request.

**Every bucket read paginates, and a failed bucket read fails the verb.** v1's candidate pool
printed nothing for a failed bucket and kept going — a gh 5xx on the p0 bucket silently read as
"no p0s" (`step1-candidate-pool.sh:12-13`, its own header admits it; #4926 is the pagination
half). Here either every bucket was read in full or the answer is `11`.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the `## Focus` declaration reads but does not parse — more than one row, a non-`#<int>` milestone, or a non-ISO date; the pool is UNKNOWN, never unfiltered |
| `11` | any bucket read failed or came back truncated, or the focus declaration could not be read — the pool is UNKNOWN, never partial and never unfiltered |

A malformed `--limit` is a plain usage error: `1`, per the reserved table. `20` and `21` are **not**
reachable here: a scope refusal on the browse path is an exclusion with a reason, not the verb's
verdict — the pool still answers on `0`. Those two codes are the claim seam's.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build pick: cannot read the <bucket> bucket: <reason> — the pool is UNKNOWN, never partial.` | 11 | refusal |
| `build pick: cannot read the "## Focus" declaration: <reason> — the pool is UNKNOWN, never unfiltered.` | 11 | refusal |
| `build pick: the "## Focus" declaration does not parse: <detail> — the pool is UNKNOWN, and a malformed declaration is never read as "no focus".` | 4 | refusal |
| `build pick: --limit "<value>" is not a positive integer.` | 1 | usage error |

**Scope** — every open issue in `--repo` carrying `status:triaged`, read via paginated REST, judged
against the declared focus. The scope line on stderr names the per-bucket counts scanned **and the
declaration** — `focus: #44 (declared 2026-08-09)`, or `focus: none declared — scope fence inert` —
so an empty pool is auditable and a fence that is off is visible as off rather than inferred.

**Examples**

```
$ fabrika build pick
{"pool":[{"number":4312,"title":"Editor loses focus after save","priority":"p1","type":"bug","home":"44"},{"number":4488,"title":"Prune the dead lane stamps","priority":"p2","type":"chore","home":"axis:pipeline-hardening"}],"excluded":[{"number":4290,"home":"39","reason":"out-of-focus"},{"number":4301,"home":"44","reason":"audience-not-agent"}],"scanned":{"p0":0,"p1":3,"p2":41},"focus":{"state":"declared","milestone":"44"}}
```

The standing-lane row is the exemption at work: #4488 carries no milestone and is admitted anyway,
while #4290 — homed in milestone 39 — is excluded. With no declaration the fence is inert, and both
the answer and the scope line say so:

```
$ fabrika build pick
build pick: scanned p0=0 p1=3 p2=41 · focus: none declared — scope fence inert
{"pool":[{"number":4290,"title":"Retire the legacy importer","priority":"p2","type":"chore","home":"39"}],"excluded":[],"scanned":{"p0":0,"p1":3,"p2":41},"focus":{"state":"none"}}
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

The derivation: resolve the parent epic (three-way — parent found / proven standalone /
unreadable). For a child, read the parent ledger's `## Dependencies` topology and the states of
every predecessor: a phase predecessor still open, or an open `requires:` edge, is a block, and
**every** blocking edge is named on stderr (#4244, #4920) — a lane learns everything it waits on
from one call, not one edge per call. Blockedness is **derived from the topology, never read off a
label** — a label is a claim, the topology is the fact. The parent body arrives through the content
gate.

**Every predecessor is read before the answer is seated**, so the answer never depends on the order
the topology lists them in. A predecessor whose state could not be read is its **own reported row**
on stderr, never counted closed: beside a *proven* open edge it leaves the verdict `16` (one proven
open edge is proof of blockedness whatever else was unreadable) and is named there so the edge list
is not read as complete; with nothing proven open it is `11`, because the blocking set is only
complete when every predecessor's state is known.

**The `## Dependencies` grammar — canonical here** (no wire module ships for it yet; when one
lands in `packages/fabrika-cli/src/wire/`, it implements this section and this section becomes a
pointer). The section holds only blank lines and list lines of two forms:

```
- phase <int>: <ref>[, <ref>…]
- <ref> requires: <ref>[, <ref>…]
```

where `<ref>` is `#<int>` (an issue) or a ledger-local id matching `C<int>`. Semantics: an issue
in phase *k* is blocked while any ref in a phase < *k* is open; a `requires:` line blocks its
subject while any listed ref is open; a ledger-local ref resolves within the ledger, an issue ref
resolves to that issue's state. Any other non-blank line inside the section is **unparseable**,
and the whole derivation refuses on `4` — "no parseable edges" is never read as "no edges".
`build check --surface plan` validates this same grammar, and
[`references/plan.md`](references/plan.md) points authors at it.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the parent ledger was read but its `## Dependencies` block is absent or unparseable — eligibility cannot be derived, fail-closed |
| `7` | the issue is proven absent (404) or closed |
| `11` | the issue, parent, or any predecessor could not be read — eligibility is UNKNOWN |
| `16` | proven blocked — an open predecessor or `requires:` edge, named on stderr |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build eligible: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build eligible: parent #<p> has no parseable "## Dependencies" block — eligibility cannot be derived, and "no edges found" is never read as "eligible".` | 4 | refusal |
| `build eligible: cannot read <what>: <reason> — eligibility is UNKNOWN, never "eligible".` | 11 | refusal |
| `build eligible: <n> predecessors could not be read — eligibility is UNKNOWN, never "eligible".` | 11 | refusal |
| `build eligible: cannot read <edge-kind> predecessor #<m>: <reason> — its state is UNKNOWN, never counted closed.` | 11 or 16 | detail line, one per unread predecessor |
| `build eligible: blocked by <n> open dependency edges: <edge-kind> #<m>, <edge-kind> #<k>.` | 16 | refusal |

**Scope** — one issue, its parent (if any), and every predecessor the parent's topology names.
The scope line on stderr counts the edges checked, so `eligible` is readable as "N edges, all
closed", never as "no edges found". An edge whose state could not be read is subtracted from that
claim by its own stderr row, so "all closed" is never asserted over an edge nobody could see.

**Examples**

```
$ fabrika build eligible 4312
{"answer":"eligible","number":4312,"parent":null}
```

```
$ fabrika build eligible 4319
build eligible: scanned 2 dependency edges; parent #4300.
build eligible: blocked by 2 open dependency edges: requires: #4310, requires: #4311.
$ echo $?
16
```

```
$ fabrika build eligible 4321
build eligible: scanned 2 dependency edges; parent #4300.
build eligible: cannot read phase predecessor #4310: gh: Bad gateway (HTTP 502) — its state is UNKNOWN, never counted closed.
build eligible: blocked by 1 open dependency edge: phase #4311.
$ echo $?
16
```

**Grounding**

- #4244 — lane entry must refuse while a `requires:` member is open.
- #4920 — the eligibility question needed a verb; prose-derived blockedness was re-derived
  differently per session. Its acceptance also fixes two properties of the answer: a `blocked`
  refusal names **every** open edge, and every unreadable input on the path is `11` with a test
  pinning it, so no read failure anywhere can resolve to "eligible".
- #4104 — `status:planned` children invisible to a label-driven picker; topology-derived here.
- ADR 0092 — an unreadable predecessor is `11`, never a pass.

---

## `build claim`, `build confirm`, `build release`

One protocol, three verbs. The claim is a comment-marker race on the issue (the ADR 0115 shape,
re-implemented): post a claim marker carrying the session's token, re-read the issue's markers,
and the earliest authorized marker wins. **Authorization is ACL-checked** — the marker's *author*
is resolved against repository permissions (the ADR 0055 idiom); the marker's *text* confers
nothing. The token is `build:<session-id>:<uuid>` — one shape, pinned, because v1 left the token
shape ambiguous between comment ids and session ids and callers guessed (#4428).

**Invocation**

```
fabrika build claim 4312 [--repo <owner/name>] [--purpose plan|gate|build]
                         [--override <reason> --override-lane <lane>]
fabrika build confirm 4312 [--repo <owner/name>]
fabrika build release 4312 [--repo <owner/name>]
```

**Inputs** — the first two rows are identical for all three verbs; the last three are `claim`'s alone:

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue (or, in repair, the PR) the claim concerns |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository whose markers are read and written |
| `--purpose` | `plan` \| `gate` \| `build` | no | `build` | why this lane claims; the audience axis binds `build` only (#5175). An off-enum value is `10`, never a fallback |
| `--override` | string | no | — | claim an issue the admission test refused on either axis, naming why; requires `--override-lane` |
| `--override-lane` | string | no | — | the lane the override is taken for; refused without `--override`. Lane and reason are both written into the claim marker |

**`claim` runs the fence before it writes anything.** After the target-open check and **before
any marker is posted**, `claim` puts `<number>` through the
[admission test](#admission-test--scope-admission-and-the-audience-axis) — the same imported
module `build pick` filters on, both axes, never a second derivation. In repair, `<number>` is a PR,
and the test judges the issue that PR serves rather than the PR's own empty home — a PR naming no
readable issue is `refused: no-served-issue` at `20`. A `refused: out-of-focus` is
`20` and a
`refused: audience-not-agent` is `21`, each named on stderr; an unreadable declaration or home is
`11` and a malformed declaration is `4`, and neither ever proceeds. Nothing is written on any of the
four: the issue carries no marker, so a refused claim leaves no trace to retract.

**The purpose decides whether the audience axis binds — it never enters either axis.** `--purpose`
says why this lane claims: `build` (the default) is bound by both axes, while `plan` and `gate` are
bound by the scope axis alone. The audience axis asks whether an agent should pick the issue up to
*build*, and an epic earns `ready-for:agent` only after it has been planned and gated, so fencing
the planner and the gate on it is circular (founder ruling,
[#5175](https://github.com/kamp-us/phoenix/issues/5175); 19 of 20 open epics carried no such label).
The purpose rides **beside** the two axes rather than widening either — each axis still reads the
issue exactly as it did, and only the composition consults the purpose, which is the shape ADR 0245's
repair round settled. A `21` is therefore reachable under `--purpose build` only, and `20` is
reachable under every purpose. `claim`'s purpose line names which reading applied, and the audience
it saw either way, so a claim admitted over a non-agent audience is readable as one afterwards.

**Repair of a decision PR is admitted on its own, with no flag and no override.** When `<number>` is
an open PR and the issue it serves carries `type:decision`, the audience axis does not bind that
claim (founder ruling on [#5866](https://github.com/kamp-us/phoenix/issues/5866), built as #5914).
Triage routes a decision to `ready-for:human`, so `type:decision` and `ready-for:agent` are mutually
exclusive by construction and an ADR PR's repair lane was failing a fence it could never pass — the
only way through was `--override`, which spent a founder-authorized escape hatch on routine repair.
The exemption is read off the **target**, not typed: there is no `--purpose repair`, because a flag
could be passed against a bare issue and would then have to be refused, while naming a PR is already
proof that a build is in flight. Its width is exactly one pairing — the same decision issue claimed
directly is still `21`, an open PR serving any other type still reads the audience label, and the
scope axis is untouched. `claim`'s purpose line names the exemption when it fires.

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
run the fence at all: it governs what may *start*, so a focus row edited mid-lane can neither strand
a running lane nor block its release.

The session id arrives from the environment (`CLAUDE_CODE_SESSION_ID`, named in `--help` with its
unset behavior: unset is a usage error, exit `1` — a claim without an identity is not a claim).

**Output** — machine, one JSON object:

- `claim` on a win: `{"answer": "won", "number": 4312, "token": "build:<sid>:<uuid>", "purpose":
  "build"}` — plus `"override": {"lane": "<lane>", "reason": "<reason>"}` when the win came through
  `--override`, so the answer records the exception as well as the marker does.
- `confirm` when held: `{"answer": "mine", "number": 4312, "token": "..."}`.
- `release` when released: `{"answer": "released", "number": 4312}`.

A loss, a foreign confirm, and a not-mine release produce no stdout — they are exit `15`, the
winner named on stderr. **A lost race is a proven outcome on its own code, never exit 0** — v1's
direct-claim script exited 0 on both won and lost and left routing to prose
(`step3-direct-claim.sh:31,40`, its header admits it), and v1's `claim is-mine` fused "proven
lost" with "no session id" on exit 1 (`claim/command.ts:57`). Both are designed out: `15` is
proven-foreign only; a missing session id is `1`; an unreadable marker set is `11`.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | `claim` only: the `## Focus` declaration reads but does not parse — nothing was written |
| `7` | the issue is proven absent (404) or closed |
| `8` | the marker write failed — it may or may not have landed; re-run `confirm` before anything else |
| `9` | the marker landed but the read-back does not match |
| `10` | `claim` only: `--purpose` is off the `plan` \| `gate` \| `build` enum — a refusal, never a fallback to `build` |
| `11` | the marker set could not be read — ownership is UNKNOWN, never "unclaimed"; or, `claim` only, the focus declaration or the issue's home could not be read — scope admission is UNKNOWN, never admitted |
| `15` | proven: another session's earlier authorized marker wins (`claim`), holds (`confirm`), or `release` was asked for a token this session does not hold |
| `20` | `claim` only, proven: the issue's home is outside the declared focus — no marker was written |
| `21` | `claim --purpose build` only (the default), proven: the issue's audience is not an agent — no marker was written. Unreachable when the target is an open PR serving a `type:decision` issue (#5914) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build claim: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build claim: #<n> is homed in milestone <home>, outside the declared focus #<focus> — refusing before any marker; pass --override "<reason>" --override-lane "<lane>" to claim it anyway.` | 20 | refusal |
| `build claim: #<n> carries <audience>, not "ready-for:agent" — refusing before any marker; pass --override "<reason>" --override-lane "<lane>" to claim it anyway.` (`<audience>` is the issue's `ready-for:` label, or the literal `no "ready-for:" label` when it carries none) | 21 | refusal |
| `build claim: cannot read the "## Focus" declaration: <reason> — scope is UNKNOWN, never admitted; nothing was written.` | 11 | refusal |
| `build claim: the "## Focus" declaration does not parse: <detail> — a malformed declaration is never read as "no focus"; nothing was written.` | 4 | refusal |
| `build claim: --override was given with an empty reason — an override is recorded or it is not one.` | 1 | usage error |
| `build claim: --override was given without a lane — pass --override-lane "<lane>" so the escape hatch names who took it.` | 1 | usage error |
| `build claim: --override-lane was given without --override — a lane names no override on its own.` | 1 | usage error |
| `build claim: --purpose "<value>" is not one of plan \| gate \| build — an unrecognised purpose refuses, and never falls back to build.` | 10 | usage error |
| `build claim: the marker write failed: <reason> — the claim state is UNKNOWN; run "fabrika build confirm <n>" before any further action.` | 8 | refusal |
| `build claim: cannot read the claim markers on #<n>: <reason> — ownership is UNKNOWN, never "unclaimed".` | 11 | refusal |
| `build claim: lost to <token> (posted <timestamp>, authorized).` | 15 | refusal |
| `build claim: the marker landed but the read-back does not match — the claim needs a human eye.` | 9 | refusal |
| `build confirm: #<n> is held by <token>, not this session.` | 15 | refusal |
| `build confirm: no claim exists on #<n> — nothing to confirm; run "fabrika build claim <n>" first.` | 15 | refusal |
| `build release: this session holds no claim on #<n> — refusing to release another lane's.` | 15 | refusal |

**Proven-unclaimed sits on `15` too**: zero markers means this session does not hold the claim,
which is the one fact every `15` consumer acts on (stop mutating; claim first). The stderr detail
separates unclaimed from foreign for a reader; the code deliberately does not, because the caller
action is identical. The same reading applies wherever a sibling verb's precondition says
"claim confirmed (`15`/`11`)": an unclaimed target refuses on `15` with the no-claim message.

**Scope** — one issue's comment markers, paginated in full, plus — for `claim` — that issue's home
and audience against the declared focus. An unauthorized author's marker is counted and reported on
stderr but never wins: content is not authority. `claim`'s scope line names the declaration it judged
against (`focus: #44 (declared 2026-08-09)`, or `focus: none declared — scope fence inert`), so a
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
build claim: #4290 is homed in milestone 39, outside the declared focus #44 — refusing before any marker; pass --override "<reason>" --override-lane "<lane>" to claim it anyway.
$ echo $?
20
```

```
$ fabrika build claim 4290 --override "hotfix for the release blocker" --override-lane build-ui
{"answer":"won","number":4290,"token":"build:s-9f2e:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d","purpose":"build","override":{"lane":"build-ui","reason":"hotfix for the release blocker"}}
```

```
$ fabrika build confirm 4312
build confirm: #4312 is held by build:s-77aa:9d8c7b6a-5f4e-3d2c-1b0a-998877665544, not this session.
$ echo $?
15
```

**Grounding**

- ADR 0115 — detect-and-tiebreak comment claims; re-implemented, never called (ADR 0238).
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
as positive tokens: `found` (with `items`), `absent` (no block reaches for the heading — a fact
the skill judges), `malformed` (something reaches for it and misses — a *defect* the skill must
surface, never silently treat as absent). The distinction is the wire module's whole design;
this verb transports it, it does not flatten it. The body passes through the content gate.

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
fabrika build branch 4312 --slug editor-focus-loss [--base <ref>]
fabrika build branch --resume 4310
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes (create mode) | — | the claimed issue the branch serves |
| `--slug` | string | yes (create mode) | — | kebab-case, ≤5 words, must not begin with `-` |
| `--base` | string | no | `origin/main` | the base ref, **fetched before the branch is cut** |
| `--resume` | integer | exclusive with the positional | — | a PR number whose head branch to switch to, for repair |

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

Preconditions, guarded identically to `build tree`: a readable tree root (`11`), a confirmed claim
(`15` / `11`) — in create mode on `<number>`, in resume mode on the `--resume` PR's number, which
is the number repair mode claims.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | `--resume`'s PR is proven absent, closed, or merged |
| `10` | `--slug` is not kebab-case, exceeds 5 words, or is flag-shaped |
| `11` | the fetch failed, or the claim state could not be read |
| `15` | proven: the claim on `<number>` is foreign |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build branch: --slug "<value>" is not kebab-case (lowercase letters, digits, single hyphens, ≤5 words).` | 10 | refusal |
| `build branch: cannot fetch <ref>: <reason> — refusing to cut a branch off a stale base.` | 11 | refusal |
| `build branch: PR #<n> is proven closed or merged — nothing to resume.` | 7 | refusal |
| `build branch: #<n> is held by <token>, not this session.` | 15 | refusal |

**Scope** — not a judging verb. It mutates only the current tree's HEAD and local refs.

**Examples**

```
$ fabrika build branch 4312 --slug editor-focus-loss
build/4312-editor-focus-loss-c1a4d6f8
```

```
$ fabrika build branch 4312 --slug -rf
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
fabrika build scratch 4312 --slug notes
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the claimed issue this lane serves |
| `--slug` | string | yes | — | the file's leaf name, kebab-case, no path separators |

**Output** — machine. Exactly one absolute path on stdout, newline-terminated:
`<OS temp root>/fabrika-build/<session-id>/<issue>-<claim-nonce>/<slug>` — the fixed
`fabrika-build` segment namespaces the allocator against everything else in the temp root. The
directory is created if absent. **The claim nonce in the key is what v1's allocator lacked**: v1 keyed on the session id
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
| `build scratch: #<n> is held by <token>, not this session.` | 15 | refusal |

**Scope** — not a judging verb. Creates one directory, prints one path, writes no file content.

**Example**

```
$ fabrika build scratch 4312 --slug notes
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
fabrika build commit --message-file "$(fabrika build scratch 4312 --slug commit-message)"
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
| `build commit: --message-file "<leaf>" is not a leaf in this lane's scratch directory — send the message on stdin, or write it under the path "fabrika build scratch <n> --slug <leaf>" prints. That path is machine-local, so it is not repeated here.` | 10 | refusal |
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
| `--surface` | enum: `code` \| `prose` \| `plan` | yes | — | the surface whose validators run; the skill names it, this verb anchors it |

**Output** — machine. On green, one JSON object:
`{"verdict": "green", "surface": "code", "tree": "<abs tree root>", "ran": ["pnpm typecheck", "pnpm lint:worktree"], "unvalidated": []}`.
Red and unknown produce no stdout (`18` / `11`), diagnostics on stderr verbatim from the runners.

`unvalidated` is always present and lists the changed files **this verdict does not cover** —
computed against *this* surface's validators, so it holds both the class no surface validates
(`.yml`, `.sh`, `.sql`, `.css`, …) and the class another surface would have read. Markdown under
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

- **code** — the exact CI commands (`pnpm typecheck`, `pnpm lint:worktree`), executed in this
  tree **with the build cache bypassed** (turbo `--force`). A cache hit from another checkout
  returned another tree's green three times in one session (#4106) and recurred on the review
  side (#4887); bypassing is cheaper than trusting a key that has already lied.
- **prose** — changed markdown files: every relative link resolves against this tree; no
  machine-local path (the imported `leaks.ts` predicate); every fabrika-doc reference cited by id
  exists.
- **plan** — everything `prose` runs, plus the changed ledger's `## Dependencies` block parsing
  under the canonical grammar (defined in `build eligible`): issue refs (`#<int>`) resolve to real
  issues, ledger-local refs (`C<int>`) resolve within the ledger, and no child is its own
  predecessor. A ledger is markdown, so the markdown validators are its baseline and the grammar is
  the specialization on top.

The surface anchor: the verb diffs the branch against its base and refuses a surface whose own file
class the diff does not contain (`--surface prose` over a diff with no markdown is `10`) — the
skill's judgment is taken, then checked against the tree, never silently accepted.

**The anchor refuses an absent class, never a present other one.** One rule holds for all three
surfaces, so a mixed code+markdown diff is runnable under every one of them: `code` runs the CI
commands and names the markdown, `prose` scans the markdown and names the code, `plan` checks the
ledger grammar and names the code. `prose` used to refuse on the *presence* of a code file, which
left the repo's most common diff shape — one `.ts` plus one `.md` — with no invocation that opened
the markdown at all, so the leak scan and the link resolver never ran on it (#5301). The presence of
another class is not a contradiction with the surface; it is exactly what `unvalidated` discloses.

**Three file classes, because two cannot express "unvalidatable".** The anchor sorts each changed
file into code, markdown, or **neither** — the third class is named, not an absence. A diff that is
*wholly* the third class (only `.github/workflows/*.yml`, only `*.sh`) refuses on `22` under **every**
surface: no validator covers those files, so any verdict would be a green over an unread tree. The
remedy is to extend a validator to cover the class, never to rename the surface — widening the code
pattern to swallow `.yml` was considered and rejected, because it would claim `pnpm typecheck`
validated a shell script (#5229). "Split the diff" is not offered as a remedy anywhere here: a lane
cannot split a diff it has already written (#5301).

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
| `build check: #<n> is held by <token>, not this session.` | 15 | refusal |
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
{"verdict":"green","surface":"code","tree":"/private/var/<redacted>/build-4312","ran":["pnpm typecheck","pnpm lint:worktree"],"unvalidated":["README.md","scripts/deploy.sh"]}
```

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
- #5304 — the green's disclosure was true at the file-open level and false at the validator level: a
  catch-all `PlatformError` skipped a file nothing could open, and `plan` claimed the whole `markdown`
  class while running only the grammar. A read that did not execute now refuses on `11`, and a
  surface that claims a class runs every validator that class gets.
- v1's discipline was prose-only (`SKILL.md:895-935`, exact-CI-command mandate with no
  enforcement); here the command set is the verb's, not the agent's memory.
- ADR 0092 — zero diff is a refusal, not a vacuous green.
- The gate's own answer (`ci.yml`) supersedes this verdict wherever they disagree; this verb
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
| `build pr: #<n> is held by <token>, not this session.` | 15 | refusal |

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

## `build note`

**Invocation**

```
fabrika build note 4312 [--repo <owner/name>] <<'EOF'
…the progress / handoff note…
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue or PR the note posts to — resolved via the REST issues endpoint, whose response carries a `pull_request` key exactly when the number is a PR; the head stamp applies only then |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository written to |
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

**Errors** — `build pr`'s rows for `3`, `5`, `6`, `8`, `9`, `11`, `15` with the verb name
substituted (shared conventions), plus:

| Message (stderr) | Code | Kind |
|---|---|---|
| `build note: #<n> is proven absent or closed — nothing to post to.` | 7 | refusal |

**Example**

```
$ fabrika build note 4310 <<'EOF'
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

## `build verdicts`

**Invocation**

```
fabrika build verdicts --pr 4310 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request whose verdict state is folded |
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
 "frozenCriteria": [{"text": "add an e2e for the empty-list case", "appendedRound": 3}]}
```

(`frozenCriteria` rows carry `text` and `appendedRound`; the array is empty when nothing was
appended past the freeze. **Each row's `body` is the finding's full text, passed through the
content gate** — the repair loop consumes findings from here and never raw-fetches a comment,
which is what keeps AC 3's one-door property over the repair path. `capReached` is
`rounds >= CAP_ROUND`, read from `src/retry-budget.ts` — the package's one declared retry budget
— and computed here so the cap is a field read, not a number remembered.)

The fold: resolve the PR's current head; fetch **every** comment and **every** review, paginated
in full; parse each comment through the imported `verdict-marker` read; keep the latest marker
per gate namespace; bind each to the current head (`current: true|false` — a stale marker is
visible *as stale*, never dropped, because "the FAIL is old" and "there is no FAIL" are different
facts, #4105's class). **Native reviews are their own row kind**, not coerced into markers —
whether a `CHANGES_REQUESTED` with no marker drives a repair is the open decision #4555; this
verb reports the state honestly and pre-rules nothing. `rounds` counts distinct FAIL clusters by
the 120-second gap rule computed over the *full* comment set (v1 counted off a truncated 100-
comment snapshot, `stepR-round-count.sh` + `stepR1-verdicts.sh:48`; the off-by-one at the cap is
#4570 — the count here is covered by a unit test at the boundary). **The rule, exactly:** take
every FAIL-polarity marker comment, sorted by `created_at` ascending; a marker whose gap from
the previous FAIL marker exceeds 120 seconds starts a new cluster, a gap of exactly 120 seconds
or less continues the current one; `rounds` is the cluster count. `frozenCriteria` lists
review-appended acceptance-criterion rows dated at or past `CAP_ROUND`.

**`{"rows": [], ...}` on exit 0 is a proven "no verdicts", readable against the scope line's
comment/review counts. An unreadable page is `11` — never a shorter list.** All content passes
the content gate.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent or closed |
| `11` | the head, any comment page, or any review page could not be read — the fold is UNKNOWN, never partial |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build verdicts: PR #<n> is proven absent or closed.` | 7 | refusal |
| `build verdicts: cannot read <what> (page <k>): <reason> — the verdict state is UNKNOWN, never "none".` | 11 | refusal |

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
(`branch`/`commit`/`check`/`push` run `tree`'s assertions; `pr`/`note` run the same posting guards on
the same codes, and `commit` runs the same authored-text guards on `3`/`5`/`6`).
