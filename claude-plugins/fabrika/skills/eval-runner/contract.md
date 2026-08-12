# `/eval-runner` — derived CLI contract

**Skill:** [`eval-runner`](SKILL.md) · **Authoring brief:** [#5400](https://github.com/kamp-us/phoenix/issues/5400) · **Date:** 2026-08-10

One new verb. Everything else this skill runs is the shipped `eval` group —
`packages/fabrika-cli/src/eval/` — reused by pointer, never respecified. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs; where this spec and
that doc disagree, the doc wins and this spec is the bug.

**Implementation ticket:** [#5411](https://github.com/kamp-us/phoenix/issues/5411) — `eval post`
is specified here and does not exist yet.

**Sequencing dependency, discharged:** the reused group and the `eval-record` wire format landed
with PR [#5401](https://github.com/kamp-us/phoenix/pull/5401) (#4678's lane), squashed as
`c1ec3937`. This contract was first authored against that PR's **pre-repair** head `59ce3b3a` and
is re-derived here against the merged shape — which is a different shape, not a formality: the
record payload's `unmeasuredCases` field and the group's `15`/`16`/`17` seats both arrived after
`59ce3b3a`. Read every claim below against `packages/fabrika-cli/` on `main`.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill**
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). GitHub
access per
[skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `eval post` | post one head-bound eval record as a PR comment — upsert per `(head, cell)`, leak-scanned, read back | format read, live-head comparison, comment upsert and read-back are a protocol; *whether* and *when* to run the suite is the skill's judgment |

### Reused, not respecified

Five shipped `eval` verbs are this skill's deterministic layer, reused as landed —
`check` · `cases` · `run` · `graded` · `report`. The group ships six more that this skill's path
does not touch: `keeps` (the ruled-KEEP corpus), `baseline record` / `baseline compare` (#5404's
cost ceiling), and `scorecard` / `trend` / `churn` (#5415's committed series and co-gate)
(`packages/fabrika-cli/src/eval/command.ts`, seats in `src/eval/codes.ts`, mechanics in
`src/eval/graded-axis.ts` and `src/eval/spawn.ts`, record format in `src/wire/eval-record.ts`,
registered as `eval-record` in `src/wire/registry.ts`). A pointer to code cannot drift the way
prose can; nothing below restates their flags, shapes, or codes. Their run-count, median, and
token mechanics are ruled on [#4637-B](https://github.com/kamp-us/phoenix/issues/4637) (comment
5150138987, ruling 4) and encoded in [ADR 0253](../../../../.decisions/0253-eval-record-is-an-eval-namespaced-pr-comment.md)
/ [ADR 0252](../../../../.decisions/0252-grading-chain-dispersion-and-decline-criterion.md); this
contract cites and does not re-derive them.

### Considered and deliberately not derived

Each is a real proposal someone could make again. (Conventions §7 homes these in a plugin-root
`.out-of-scope/`, which no fabrika skill has bootstrapped yet; until it exists they live inline,
the same tracked debt the sibling contracts carry.)

- **An archive verb, or any durable store beyond the record and the committed series.** The
  personal authoring skill's `~/fabrika-eval-runs/` archive is the named prior art this skill
  replaces (#4679 comment 5247171842); a fabrika archive verb would rebuild it one directory
  over. The durable surfaces are the posted record (ADR 0253) and #4680's committed series —
  both already specified elsewhere.
- **A scorecard-commit verb writing `claude-plugins/fabrika/reports/eval/`.** The series file's
  shape, filename mechanics, and the #4637-ruling-4 pins reconciliation are
  [#4680](https://github.com/kamp-us/phoenix/issues/4680)'s call — the freeze-lift gate. A
  runner-side writer would pre-decide it. It has since **landed as `fabrika eval scorecard`**
  (PR #5415), which changes nothing here: this skill still reads the series and never writes it,
  and the writer it defers to is now a shipped verb rather than a pending one.
- **A bar or gate verb.** The 100% floor, the 90% per-stage bar and the trend co-gate belong to
  the merge gate ([#4681](https://github.com/kamp-us/phoenix/issues/4681)); dispersion is
  recorded and never gates (ADR 0252). The runner emitting a PASS/FAIL is the exact polarity the
  `eval-record` format refuses by construction.
- **A CI entry point.** Eval and baseline runs execute in a plain (non-worktree) agent session on
  an operator's machine, never in CI (#4679 comment 5247166010); the package reds any workflow that
  invokes the model-bearing verbs. CI's leg is reading artifacts, and that is #4681's. The
  non-worktree half is enforced by nothing here and cannot be: a worktree-isolated session's harness
  guard refuses any command carrying the token `eval` (#5406), so the run simply never happens
  there. The skill's `RUN-SITE-IS-AN-OPERATOR-SESSION` anchor carries the reader-facing statement.
- **A conductor verb sequencing the suite.** Which sets to run, at which head, at what cost, and
  whether to retry a whole five-run block is judgment — the skill's whole remaining job. A
  sequencing verb would be a script deciding what a session should.

## Shared conventions

- **Answer channel: machine.** Stdout carries the answer and nothing else; refusal reasons,
  scope statements and progress go to stderr. Every "nothing found" prints a state word.
- **Common inputs.** `--repo <owner/name>` (default: the resolution chain the shipped groups
  use — `$CLAUDE_PIPELINE_REPO`, else `$GITHUB_REPOSITORY`, else the `origin` remote; none
  resolvable → exit `1`). `--json` swaps the line grammar for one object with named keys.
- **Every list read paginates and reports its scanned count** on stderr.
- **A non-zero exit is UNKNOWN.** No partial answer on a non-zero exit
  (`packages/fabrika-cli/src/verb.ts`).

### Exit codes

`eval post` allocates from the shipped group table (`packages/fabrika-cli/src/eval/codes.ts`) —
never from a sibling contract's prose. Universal codes `0` / `1` / `2` / `127` carry the
convention doc's meanings and are stated only here. Shared base seats are imported from
`report/codes.ts` — `3`, `5`, `6`, `8`, `9` and `11`, each carrying the base meaning unchanged.

**The three new seats are derived from the tables as merged, never assumed.** `report/codes.ts`
(the base every aligning group must clear — `exit-code-alignment.ts`) occupies
`3`–`11`, `27` and `28`; the `eval` group holds `4` and `7` as shared seats and `12`–`17` as its
own — `12` `INTEGRITY_VIOLATION`, `13` `RUNS_NOT_EXECUTED`, `14` `NO_MEASUREMENT`, `15`
`ABOVE_BASELINE` (#5404), `16` `BASELINE_INCOMPARABLE` (#5404), `17` `NOT_COMMITTABLE` (#5415). The
lowest three numbers free of both tables are therefore **`18`, `19` and `20`**, and that is where
this verb's own refusals seat. An earlier draft of this contract seated them at `15`/`16`/`17`,
which #5404 and #5415 have since occupied — re-derive against the shipped tables before trusting
any number here. The group's `7`
(`ZERO_SCOPE` — a set carrying no cases) is **not** reused for this verb's absent-target refusal:
the base meaning and the group's widened meaning are different facts, and one number may not
carry both inside one group.

| Code | Meaning | Source |
|---|---|---|
| `3` | stdin was read and held nothing | import `EMPTY_STDIN` |
| `4` | stdin's bytes do not read as an eval record — `Absent` or `Malformed`, wire reason on stderr | group `MALFORMED_DOCUMENT` |
| `5` | the record's bytes carry a machine-local path | import `LEAKED_PATH` |
| `6` | the body is a bare `@` path reference — the record never arrived | import `BARE_AT_PATH` |
| `8` | the create/edit failed — UNKNOWN whether a comment landed | import `WRITE_UNKNOWN` |
| `9` | the comment landed but the read-back does not yield this record | import `READBACK_MISMATCH` |
| `11` | a precondition read failed — nothing was written, the outcome is UNKNOWN | import `PRECONDITION_UNKNOWN` |
| `18` | `STALE_HEAD` — the record's `sha` is not the PR's live head; re-run at the head, never re-bind | new seat |
| `19` | `INCOMPLETE_SCAN` — the comment enumeration is provably short of the declared count, so the upsert match is unprovable | new seat |
| `20` | `TARGET_ABSENT` — the PR is proven absent (404) or closed | new seat |

---

## `eval post`

**Invocation**

```
fabrika eval post 9041 [--repo <owner/name>] [--json]
```

The record's bytes arrive on **stdin only** — no `--body`, no `--body-file`: a path flag is how a
machine-local path reaches a public surface while the poster reads success, and the record is
already a self-contained artifact carrying every value this verb needs.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number the record lands on |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | eval-record bytes | yes | — | the record exactly as `eval graded` emitted it — marker line, blank line, fenced JSON payload |

There is deliberately no `--sha` and no `--cell`: both live inside the record, which is the
single artifact — a flag repeating a payload field is a second home the two can drift between.

**Output** — machine channel. One line:
`posted\t<RECORDED|UNRECORDABLE>\t<sha>\t<cell>\t<created|edited>\t<comment-url>` — where
`<sha>` and the outcome token are the record's own, `<cell>` is `<stage>` or `<stage>/<surface>`
as the payload carries it, and the fifth field says whether the upsert created a fresh comment or
edited this `(head, cell)`'s existing one.

With `--json`:
`{"outcome":"posted","token":"RECORDED"|"UNRECORDABLE","sha":…,"cell":{"stage":…,"surface":…,"model":…},"upsert":"created"|"edited","commentUrl":…,"scanned":<comments>}`.

**What the operation does, in order — each step gates the next.**

1. **Read stdin through the registered format** — `read` from
   `packages/fabrika-cli/src/wire/eval-record.ts`, imported, never a second parser. `Absent`
   (the first non-blank line does not reach for the format) and `Malformed` (it reaches and
   fails, including every payload re-derivation the module refuses on) are both the `4` refusal
   with the wire reason verbatim on stderr. Empty stdin is `3`; a bare `@` path is `6`.
2. **Resolve the PR.** Proven absent (404) or closed is `20` — a fresh seat, because this group's `7` already means *the eval set carries zero cases* and one number may not carry two facts inside one group. An unreadable PR is `11`.
3. **Compare the record's `sha` against the PR's live head** (prefix match, the format's own
   binding relation). Not the live head is the `18` refusal: a record bound to a tree the PR has
   left is re-run at the new head, never re-bound — the stale-head class at the emit seam.
4. **Leak-scan the record's bytes** — the predicate at
   `packages/fabrika-cli/src/report/leaks.ts`, imported. A machine-local path is `5`. A capture
   manifest's `transcriptPath` pasted into a record body is the expected offender.
5. **Sweep the PR's comments, paginated and count-checked**, testing each body's first non-blank
   line through the format's `read`. Received short of the declared count is `19` — a short
   sweep could create a duplicate where an edit was owed. A comment that reaches for the format
   and fails it is surfaced as a stderr notice with its comment id, never silently dropped.
6. **Upsert on the `(head, cell)` key** (ADR 0253: one comment per `(head, cell)`, latest in
   force): a swept comment whose record's `sha` prefix-matches this record's and whose
   `cell` (stage, surface, model) equals this record's is edited in place — the newest such
   comment when several match; otherwise a new comment is created. The write failing is `8`.
7. **Read it back, unconditionally, from live PR state**: re-fetch the comment, hand its body to
   the format's `read`, require `Found` with this record's `sha`, token and cell, and compare the
   whole body against the bytes sent through `normalizeForReadback` from
   `packages/fabrika-cli/src/report/compose.ts` — imported; its third step (strip trailing
   newlines) is the one a re-derivation drops, and dropping it fires `9` on clean runs. A
   mismatch is `9`.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — no record arrived |
| `4` | stdin's bytes do not read as an eval record (`Absent` or `Malformed`, wire reason on stderr) |
| `5` | the record's bytes carry a machine-local path |
| `6` | the body is a bare `@` path reference — the record never arrived |
| `8` | the create/edit failed — UNKNOWN whether a comment landed |
| `9` | the comment landed but the read-back does not yield this record byte-conforming |
| `11` | the PR, its live head, or its comment list could not be read — nothing was written |
| `18` | the record's `sha` is not the PR's live head — re-run the suite at the head, never re-bind the record |
| `19` | the comment enumeration is provably short of the declared count — the upsert match is unprovable, and a blind create could shadow an edit |
| `20` | the PR is proven absent (404) or closed — a record has no home here |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `eval post: no record on stdin — pipe the bytes eval graded emitted.` | 3 | refusal |
| `eval post: stdin does not read as an eval record (absent or malformed: <wire reason>) — post the emitted bytes, never a hand-assembled comment.` | 4 | refusal |
| `eval post: the record carries a machine-local path at line <k> (<class>) — a transcriptPath is machine-local and perishable; strip it (ADR 0273).` | 5 | refusal |
| `eval post: the body is a bare "@" path reference — the record never arrived. Pipe its bytes on stdin.` | 6 | refusal |
| `eval post: PR #<n> not found in <repo>.` | 20 | refusal |
| `eval post: PR #<n> is closed — a record there enters no series; post on the PR that carries this head.` | 20 | refusal |
| `eval post: create/edit failed: <reason> — UNKNOWN whether the record landed; sweep the PR's comments before retrying.` | 8 | refusal |
| `eval post: posted, but the read-back does not yield this record (<wire reason>) — the PR may carry a garbled record; inspect comment <id> before re-running, since a garbled comment does not match the upsert key.` | 9 | refusal |
| `eval post: cannot read <what> for #<n>: <reason> — nothing was posted.` | 11 | refusal |
| `eval post: PR #<n>'s head is <live>, not <sha> — the tree this record measured is gone; re-run the suite at <live>, never re-bind (ADR 0253).` | 18 | refusal |
| `eval post: received <k> of <m> declared comments on #<n> — refusing the partial sweep; a blind create could shadow the edit this record owes.` | 19 | refusal |
| `eval post: comment <id> reaches for the eval-record format and fails it: <wire reason>.` | 0 | notice |

**Scope** — one PR: its metadata and live head, its full comment list (paginated,
count-verified), plus the caller's stdin. The sweep's scanned count goes to stderr on the answer
path. Zero existing record comments is a fact, not a failure — the upsert creates. Steps 2–5's
reads failing is `11`: nothing written, outcome known-unwritten.

**Examples**

```
$ fabrika eval graded claude-plugins/fabrika/skills/triage/evals/evals.json \
    --stage triage --model <model> --plugin-dir claude-plugins/fabrika --sha 03135b91 \
  | fabrika eval post 9041
posted	RECORDED	03135b91	triage	created	https://github.com/<owner>/<repo>/pull/9041#issuecomment-9100000001
```

```
$ fabrika eval post 9041 --json < record.txt
{"outcome":"posted","token":"RECORDED","sha":"03135b91e7d4a2c6f1b8093a5c4d2e1f6a7b8c9d","cell":{"stage":"review","surface":"skill","model":"claude-opus-4-6"},"upsert":"edited","commentUrl":"https://github.com/<owner>/<repo>/pull/9041#issuecomment-9100000001","scanned":14}
```

```
$ fabrika eval post 9041 < record.txt
eval post: PR #9041's head is 7be402c1, not 03135b91 — the tree this record measured is gone; re-run the suite at 7be402c1, never re-bind (ADR 0253).
$ echo $?
18
```

(The comment URLs and numbers above are sample data, not real targets.)

**Grounding**

- ADR 0253 — the record's home is a PR comment, one per `(head, cell)`, latest in force; this
  verb is that storage rule made a protocol.
- #3173's class — a hand-rolled `gh api` emit posted garbage and self-reported success; one
  sanctioned emit path with an unconditional live-state read-back is the cure, the same shape
  `review post` ships.
- #3769 / #4338's class — staleness read as current; the `18` refusal keeps a measured tree and
  a live tree from being conflated at the write seam.
- #4679 comment 5247166010 / 5247171842 — results land on portable surfaces only; this verb is
  the portable-surface write, and its leak scan is what keeps a machine-local `transcriptPath`
  out of it.
- `review post` (the sibling emit verb) seats its stale-head refusal on `12`; this group's `12`
  is `INTEGRITY_VIOLATION`, so the same fact seats locally at `18` — cross-group divergence
  above `11` is the doctrine, and the shared refusal is deliberately re-seated, not imported.

---

## Required repo files

The skill-level table in [`SKILL.md`](SKILL.md) is the run-level declaration; this verb adds one
row of its own:

| Must exist | Why this group needs it | When missing |
| --- | --- | --- |
| A pull request on the resolved repo carrying the record's head | the record's storage is a PR comment (ADR 0253) | **degrade** — the skill's `RECORD-LOCAL` terminal: the bytes wait at a stated repo-relative path; `eval post` itself simply refuses `20` on a PR that is not there. |

## The eval-enumeration obligation (leaf rule)

Stated once, in [`SKILL.md`](SKILL.md)'s "Eval enumeration" section. This spec adds nothing to
it; the eval mechanics belong to #4637-B and the shipped group.
