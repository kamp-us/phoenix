# `/check-epic-plan` — derived CLI contract

**Skill:** [`check-epic-plan`](SKILL.md) · **Authoring brief:** [#4948](https://github.com/kamp-us/phoenix/issues/4948) · **Date:** 2026-08-09

The verbs land in `packages/fabrika-cli/` under the **`plan`** subcommand group, registered in
`packages/fabrika-cli/src/registry.ts` like the shipped groups, every leaf declared via
`leafCommand` (`src/excess-operand.ts` — a bare `Command.make` silently opts out of the
excess-operand guard), and the group registered in `ALIGNED_GROUPS`
(`src/exit-code-alignment.ts`), whose checker reds on a `codes.ts` present in neither map. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs every verb; where this
spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill** (ADR 0238). The v1 machinery
named below — under `packages/pipeline-cli/src/tools/`, `epic-ledger/`, `epic-lock/`,
`scratchpad/`, and the `claude-plugins/kampus-pipeline/skills/review-plan/` scripts — is prior art
**read** for semantics and scars; none is invoked, wrapped, or deferred to. Every v1 module name
cited anywhere in this spec is **non-normative**: the behavior it informs is restated here in full,
and an implementer needs none of those files to build these verbs.

**The group name.** `plan` is this gate's, following the one-group-per-skill precedent
(`build-ui` took `ui`, `build-epic` took `epic`, each reusing `build`'s verbs rather than sharing
its group). The planner `plan-epic` ([#4712](https://github.com/kamp-us/phoenix/issues/4712),
unauthored) takes its own group and may reuse these verbs the same way. **The `epic` group is an
unimplemented spec** — `build-epic`'s contract describes it, and no `src/epic/` exists — so nothing
here allocates against it, and the `3`+ band carries no cross-group obligation in any case.

**What fabrika already ships, reused — never respecified.** The claim is the **`build` group's,
reused as landed verbs** ([`build`'s contract](../build/contract.md)) — the cross-contract shape
`build-ui` sanctioned: this gate claims the epic with `build claim` / `build confirm` /
`build release` and posts a successor note with `build note`. The `build` contract owns those
verbs' behavior; nothing here respecifies them, and **no second lock is derived** (v1's `epic-lock`
is the scar catalogue this avoids: a held label never reclaimed from a dead holder, a release that
dropped the lock unconditionally, five back-off causes on one exit code). Modules reused by import:

- `packages/fabrika-cli/src/io/issues.ts` — `resolveRepo`, `getIssue` (three-way
  `Present`/`Absent`(404 only)/`Unknown`), `listComments` (typed JSON, never `--jq .body`),
  `splitJsonArrays` (`--paginate`'s concatenated arrays), `addLabels`, `removeLabel` (**folds 404
  into success — removal is idempotent**, which is v1 scar F3 gone for free), `listLabels`.
- `packages/fabrika-cli/src/build/dependencies.ts` — `readTopology` (`Parsed`/`Absent`/
  `Unparseable{line,text}`) and `predecessorsOf`. **This spec adds no second `## Dependencies`
  grammar**; `build-epic` imports the same parser for the same reason.
- `packages/fabrika-cli/src/wire/acceptance-criteria.ts` — the total three-armed read
  (`Found`/`Absent`/`Malformed`), fence-aware, near-miss-admitting, refusing more than one
  conforming heading as undecidable. `plan read` imports it per child. The wire registry already
  declares `build-epic` a producer of this format, so it is the pinned contract between the
  planner's output and this gate's input.
- `packages/fabrika-cli/src/wire/verdict-marker.ts` — `emit` / `read` / `bindToHead` and the
  branded 7–40-hex slot. **Entirely pure — it binds any hex string, not only a commit**, which is
  what makes a scope digest bindable through it. Requires one additive change, specified in
  §Scope digest.
- `packages/fabrika-cli/src/build/claim.ts` — `requireClaim` (this session holds it, proven now)
  and its four unfoldable outcomes. Every mutating verb here runs it.
- `packages/fabrika-cli/src/report/leaks.ts` (`scanBody`, `isBareAtReference`) and
  `src/report/compose.ts` (`normalizeForReadback` — **three steps; read the body, the docblock
  understates it**). `plan verdict` imports both.
- `packages/fabrika-cli/src/triage/facet-writes.ts` — the per-issue label write decomposed into
  individually-observable calls **so the failure index is reportable**, never a replace-set `PUT`.
  `plan flip` fans this shape across children.
- `packages/fabrika-cli/src/build/target.ts` — `resolveTargetRepo`, `openIssue` (pre-seats the
  `7`/`11` refusals) and `scannedLine`.

A restatement of any of these would be a transcription, and a transcription drifts. The spec says
*import this*, with the path.

**Considered and deliberately not derived** — each already enforced or owned elsewhere (interface
convention rule 6; conventions §7 homes these in `.out-of-scope/`, unbootstrapped — tracked inline
as the sibling contracts do):

- **A planning lock.** The claim is `build claim` on the epic number. A second mutex would be the
  wrapper-verb shape ADR 0238 bans, and v1's own lock is the reason: `acquire` short-circuits on a
  held label *before* any liveness probe, so a dead holder's lock is never reclaimed and a human
  clears it by hand.
- **A re-plan convergence loop.** The FAIL path is terminal and hands back to `plan-epic`. v1
  exported `runConvergenceLoop` and registered it as no command at all — imported by nothing but
  its own unit test — so its stall test and its park were prose, not mechanism.
- **A pickability predicate.** Whether child `#C` is *ready* (its dependency edges satisfied) is
  `build`'s picker question, open on [#4920](https://github.com/kamp-us/phoenix/issues/4920). This
  gate makes children *eligible*; it computes no second answer to *pickable*.
- **An epic-body writer.** This gate never edits an issue body. The planner owns splicing, with its
  round-trip scars ([#4879](https://github.com/kamp-us/phoenix/issues/4879)).
- **A gate-was-never-run detector.** [#4104](https://github.com/kamp-us/phoenix/issues/4104) is
  open and lane-scoped; a verb here would answer for one epic the question the lane asks across
  all of them.
- **A repo-file existence prober as a verb.** `product-development-cycle.md` is read inline by
  `plan check` (below) and its read failure is surfaced, never folded into absence.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `plan read` | fetch the epic and its children, parse the ledger, print it as one object | fetch + registered parses — no judgment; *what the plan is worth* stays in the skill |
| `plan check` | the deterministic floor: the thirteen hard defect types over the scanned child set | a total function from the ledger to a sorted defect list; the whole pass/fail decision, checkable by construction |
| `plan flip` | flip every `status:planned` child to `status:triaged`, re-gating first, reporting the **observed** result per child | a guarded batch write with a read-back — no judgment; *what a partial flip means* stays in the skill |
| `plan verdict` | post the gate's verdict comment, bound to a scope digest, and read it back | marker composition + a guarded write; the caveats are the skill's judgment, taken as input |

**Considered and not derived: a `plan defects --explain` verb.** A defect's *remedy* is the
planner's judgment, and a verb that authored one would be minting advice the floor cannot check.
The defect codes are self-describing and `plan check --help` prints the table.

## The floor — thirteen defect types, and the one that is not a defect

`plan check` derives a sorted `Defect[]` over this closed enum. The order is the emission order and
is the primary sort key; the secondary key is the lowest ref the defect names.

| # | Type | Condition |
|---|---|---|
| 1 | `MISSING_DEPS_SECTION` | the epic body's `## Dependencies` read is `Absent` |
| 2 | `DEP_CYCLE` | the topology's edges contain a cycle (transitive, not one hop); the cycle is reported as its sorted member set, deduped |
| 3 | `DANGLING_DEP` | a referenced ref is neither the epic, nor a child, nor an issue **proven present** by a 404-discriminating probe |
| 4 | `ORPHAN_CHILD` | the deps section parsed, and a linked child appears in no phase line and no `requires:` line |
| 5 | `MISSING_STORIES_SECTION` | the epic body declares zero user stories |
| 6 | `UNCOVERED_STORY` | a story the epic declares that no child claims |
| 7 | `ZERO_AC` | a child's acceptance-criteria read is not `Found`, or is `Found` with zero criteria |
| 8 | `MISSING_STORY` | the epic declares stories and a child carries no `**Stories:**` line at all (absent ≠ `none`) |
| 9 | `MISSING_LABEL` | a child lacks a `type:` label, a `status:` label, or one of `p0`/`p1`/`p2` |
| 10 | `MISSING_CONTAINMENT` | the repo carries `product-development-cycle.md`, the child is `type:feature`, and its containment is unset or `none` |
| 11 | `NEEDS_TRIAGE_LABEL` | a child still carries `status:needs-triage` |
| 12 | `UNVERIFIABLE_ASSIGNEE` | the child payload's `assignees` key was **not observed** — an unread field is UNKNOWN, never "unassigned is fine" |
| 13 | `HELD_CHILD_UNASSIGNED` | a child carries `ready-for:human` and its observed assignee list is empty |

**Grounded, and corrected against source.** [Brief #4948](https://github.com/kamp-us/phoenix/issues/4948)
names ten types; the live enum is fourteen, because the brief's list was copied from v1's
`review-plan/SKILL.md` prose, which is stale (that file's own validator calls it "the closed 7-type
enum"). The four the brief omits are `ZERO_SCOPE`, `MISSING_CONTAINMENT`, `UNVERIFIABLE_ASSIGNEE`
and `HELD_CHILD_UNASSIGNED`. **Never re-list this enum from a skill's prose; derive it from the
source of truth, which is now this table.**

**`ZERO_SCOPE` is deliberately dropped as a defect and seated as exit `7` instead.** v1 made a
childless epic defect #1 and early-returned, so the ledger was never validated and the verdict
reported exactly one thing wrong about a plan it had not read. A refused scope is not a defect
list of length one: `plan check` refuses on `7`, derives nothing, and says so (ADR 0092).

**`p3` is not admitted.** The priority set is exactly `{p0, p1, p2}`; `p3` was ruled *retired*, not
widened ([#4101](https://github.com/kamp-us/phoenix/issues/4101),
[#2413](https://github.com/kamp-us/phoenix/issues/2413)).

**The two barrier defects are conservative by ruling, and their legacy cost is stated.** A
pre-existing `ready-for:human` child with an empty assignee slot fails the floor, and one such
child blocks the flip for every sibling. Back-fill versus grandfather is **unruled**
([#5026](https://github.com/kamp-us/phoenix/issues/5026)); this contract takes the refusing arm
because the permissive arm would flip a held child into the build pool, which is the exact outcome
the barrier exists to prevent ([#4637-C](https://github.com/kamp-us/phoenix/issues/4637)). The
seam a ruling lands at is this table's row 13.

## The scope digest

Every verdict binds to a **scope digest**: the first **12 lowercase hex** of the SHA-256 of a
canonical serialization of exactly the inputs the floor read. One line per child, ascending by
number, then one epic line, joined by `\n` with no trailing newline:

```
#<number>|labels=<names, ascending, comma-joined>|assignees=<logins ascending comma-joined, or "" observed-empty, or "?" unobserved>|ac=<count, or "?" when not Found>|stories=<ints ascending comma-joined, or "none", or "?" when the line is absent>|containment=<token, or "?">
epic=<number>|stories=<ints ascending comma-joined>|deps=<phase index and refs, ascending, as "p<i>:<ref>,<ref>" segments joined by ";", then explicit edges as "<ref>><ref>" ascending, joined by ";">
```

The digest is a **relation between a verdict and a plan**, not a property of either — the same
discipline `verdict-marker.ts` states for a head SHA. Recomputing it and comparing gives
`Current` / `Stale` / `Unbindable` through the imported `bindToHead`, and those three never fold:
a verdict whose digest cannot be recomputed is `Unbindable`, never `Stale` and never `Current`
(ADR 0058). This is what makes an epic's gate state checkable later; an unmarked verdict is
invisible to any drift check ([#5096](https://github.com/kamp-us/phoenix/issues/5096)).

**One additive change to a shipped module is required**, stated so an implementer does not
discover it mid-build: `verdict-marker.ts`'s `NAMESPACE` is `/^review(-[a-z0-9]+)*$/`, which
admits no non-review namespace. Widen it to `/^(review|check-epic-plan)(-[a-z0-9]+)*$/`. The change
is additive — no existing marker's reading changes, and the `Absent` versus `Malformed`
discrimination the module exists to protect is untouched. **Do not** instead reuse the `review`
namespace: a plan verdict wearing a review namespace is precisely the family confusion the
partition ruling removed (#4891).

**The digest never enters the `ledgerSignature` trap.** v1's signature collapses to the literal
`"clean"` on a PASS, so it cannot distinguish two clean plans and is useless as a drift key. The
digest is computed over the same fields on both arms.

## Shared conventions

Every `plan` verb obeys these; stated once.

- **Answer channel: machine.** Stdout carries the answer only — one JSON object with named keys.
  Scope lines, refusal reasons and notices go to stderr. A non-zero exit prints nothing on stdout
  (`src/verb.ts`'s refuse shape). **The positive answer is always a positive token**: a clean floor
  prints `{"answer":"clean",…}`, never empty stdout — v1's back-off path left stdout empty, making
  "backed off" and "never ran" byte-identical.
- **A 404 is a verdict; anything else is UNKNOWN.** Absence is decided by the HTTP status the API
  returned, never by matching text against `gh`'s stderr. v1 used
  `/404|not found/i.test(stderr)`, which reads an auth-hidden repo as a proven-absent issue and
  folds a spawn fault (a synthetic exit `-1` whose message may contain "not found") into a clean
  404 — turning a real dependency into `DANGLING_DEP` and silently disabling `MISSING_CONTAINMENT`
  for a whole run. No message in this contract is worded "does not exist, or is not readable".
- **Common inputs.** `--repo <owner/name>` (default: `resolveRepo`'s precedence — `--repo`,
  `$CLAUDE_PIPELINE_REPO`, `$GITHUB_REPOSITORY`, then the `origin` remote) on every verb. GitHub
  access per
  [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql),
  paginated in full.
- **Bounded fan-out.** Child reads and child writes run at concurrency **8**, never `"unbounded"`.
  v1 issued one `gh api` per child unbounded, so a sixty-child epic spawned sixty concurrent
  processes and a rate-limit response aborted the whole read.
- **Preconditions.** Every verb runs `resolveTargetRepo`; the two mutating verbs (`flip`,
  `verdict`) additionally run the imported `requireClaim` on the **epic** number (`15`). No verb
  touches a worktree, a branch, or the index, so `build`'s `12`/`13`/`14` are unreachable here.
- **Error-message prefix** is the invoked verb's name, contract-wide.
- **A non-zero exit is UNKNOWN** to the caller until the code is read.

### The shared exit matrix

This matrix owns `code → meaning`; the per-verb tables enumerate only that verb's own reachable
proven outcomes with triggers. `0`, `1`, `2`, `127` are the interface convention's reserved codes
(`src/verb.ts`, the exit-2 bootstrap in `src/bin.ts`), stated **only here**; every verb can return
them.

**Alignment:** `3`–`11` are `report`'s seats, **imported** from `src/report/codes.ts` under a
`REPORT_`-prefixed alias, code-for-code as `build`, `review`, `ship` and `triage` do, and the group
registers those base seats in `ALIGNED_GROUPS` (`src/exit-code-alignment.ts` — its checker verifies
only the overlap with the `report` base, never pairwise against a sibling). **`15` is imported from
`build`'s `codes.ts` verbatim**, because this group holds a `build` claim and a caller driving both
in one sweep must read one meaning for it; `ship` importing `review`'s private band is the shipped
precedent. **`20`+ are this group's own** and carry no cross-group obligation.

| Code | Meaning | `read` | `check` | `flip` | `verdict` |
|---|---|---|---|---|---|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, or the verb failed to run | ✓ | ✓ | ✓ | ✓ |
| `2` | no implementation could be resolved (`src/bin.ts`) | ✓ | ✓ | ✓ | ✓ |
| `4` | a required section is missing, malformed, or unparseable in a document the verb derives from | ✓ | — | — | — |
| `5` | the **authored** text carries a machine-local path | — | — | — | ✓ |
| `6` | the authored text is a bare `@` path reference — not redactable | — | — | — | ✓ |
| `7` | zero scope: the epic is proven absent (404) or closed, or it has zero children | ✓ | ✓ | ✓ | ✓ |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN | — | — | ✓ | ✓ |
| `9` | the write landed but the read-back does not match | — | — | — | ✓ |
| `10` | a value off its closed vocabulary — a semantic refusal, never a malformed-flag usage error | ✓ | ✓ | ✓ | ✓ |
| `11` | a required read failed — nothing was written, no outcome is proven | ✓ | ✓ | ✓ | ✓ |
| `15` | proven: this session does not hold the epic's claim (imported from `build`) | — | — | ✓ | ✓ |
| `20` | proven: the floor found hard defects — a **verdict**, not an error | — | ✓ | ✓ | — |
| `21` | proven: the floor moved between the check and the flip — the re-gate refused | — | — | ✓ | — |
| `22` | proven: the flip applied to some children and not others — the observed set is on stderr | — | — | ✓ | — |
| `23` | proven: a label the flip must write is absent from the repository's taxonomy | — | — | ✓ | — |
| `24` | proven: the verdict's scope digest is `Unbindable` against the live plan | — | — | — | ✓ |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ |

`3` is a seat no `plan` verb reaches: the only stdin-taking verb is `plan verdict`, whose stdin is
**optional** (a PASS with no caveats is an ordinary answer), so an empty stdin is a fact, not a
refusal. `12`, `13`, `14`, `16`, `17`, `18`, `19` stay reserved with `build`'s meanings and are
unreachable here — this gate holds no worktree, no branch and no validation surface. All are
deliberately not re-seated.

**`7` versus `11` versus `20`:** a 404 or a closed epic is a fact about the repository (`7`); an
unreachable GitHub or an unreadable probe is a fact about nothing (`11`); a plan that was fully
read and proved defective is a fact about the plan (`20`).

---

## `plan read`

**Invocation**

```
fabrika plan read 4300 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose ledger is read |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository read |

**Output** — machine. One JSON object:

```
{"answer": "read", "epic": 4300, "children": [
   {"number": 4301, "labels": ["p1","status:planned","type:feature"], "assignees": [], "assigneesObserved": true,
    "criteria": "found", "criteriaCount": 3, "stories": [1,2], "containment": "flag"},
   {"number": 4302, "labels": ["p2","status:planned","type:chore"], "assignees": null, "assigneesObserved": false,
    "criteria": "malformed", "criteriaCount": 0, "stories": null, "containment": null}],
 "epicStories": [1,2,3], "topology": {"phases": [["#4301"],["#4302"]], "edges": [["#4302","#4301"]]},
 "cycleDoc": "present", "digest": "a1b2c3d4e5f6"}
```

The child set comes from the **native sub-issue link list** (`repos/{repo}/issues/{n}/sub_issues`,
paginated in full, typed-JSON decoded — not `--jq`, whose `-r` errors mid-stream on control
characters and reads back as an empty body). **No shipped module reads sub-issues today**; the
package's `getParent` walks child → parent only, so this read is genuinely new and lands as a
sibling of `io/issues.ts`'s paged readers, in their shape: a shape failure is a failure, never an
empty list.

Per child: labels via `getIssue`; the **three-state assignee slot** (`assigneesObserved: false`
when the payload carried no `assignees` key at all — the distinction `UNVERIFIABLE_ASSIGNEE` rests
on); acceptance criteria via the imported wire read, its token carried through
(`found`/`absent`/`malformed`) and **never flattened to a count alone**; `**Stories:**` and
`**Containment:**` fields. `topology` is the imported `readTopology` parse. `cycleDoc` is
`present` / `absent` / `unknown` — three-valued, because a probe that merely failed to read is not
an absent file. `digest` is the scope digest over exactly this payload.

**Fence awareness and duplicate sections are decided here, not inherited.** The imported AC reader
is already fence-aware. For the `**Stories:**` and `**Containment:**` fields this verb applies the
same rule: a line inside a fenced code block is not a field. v1 had no fence awareness anywhere, so
a documentation example inside a fence set a real child's stories. Where two candidate sections
appear, the read is **`4`, not first-match-wins** — v1 silently read the first and ignored the
rest, which makes a plan's meaning depend on ordering nobody stated.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the epic body's `## Dependencies` is `Unparseable`, or a section required by the ledger appears more than once |
| `7` | the epic is proven absent (404) or closed, or it has zero sub-issue children |
| `10` | the issue is not a `type:epic` |
| `11` | the epic, the sub-issue list, a child, or the `product-development-cycle.md` probe could not be read |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `plan read: #<n>'s ## Dependencies block is unparseable at line <l>: <text>` | 4 | refusal |
| `plan read: #<n> carries <k> "<heading>" sections — a ledger with two of one section has no single meaning.` | 4 | refusal |
| `plan read: issue #<n> is proven absent or closed.` | 7 | refusal |
| `plan read: #<n> has zero sub-issue children — there is no ledger to read (ADR 0092).` | 7 | refusal |
| `plan read: #<n> is not a type:epic — refusing to read it as one.` | 10 | refusal |
| `plan read: cannot read <what>: <reason> — the ledger is UNKNOWN.` | 11 | refusal |

**Scope** — one epic, its sub-issue children, one repo-file probe. The stderr `scannedLine` counts
children fetched and names them, so a caller can see the set the digest was taken over. Zero
children is `7`, never an empty answer.

**Examples**

```
$ fabrika plan read 4300
{"answer":"read","epic":4300,"children":[{"number":4301,"labels":["p1","status:planned","type:feature"],"assignees":[],"assigneesObserved":true,"criteria":"found","criteriaCount":3,"stories":[1,2],"containment":"flag"}],"epicStories":[1,2],"topology":{"phases":[["#4301"]],"edges":[]},"cycleDoc":"present","digest":"a1b2c3d4e5f6"}
```

```
$ fabrika plan read 4300
plan read: #4300 has zero sub-issue children — there is no ledger to read (ADR 0092).
$ echo $?
7
```

**Grounding**

- ADR 0092 — zero scope reds; an empty child set is a refusal, not a clean read.
- v1 scar (`markdown.ts`): heading sections were first-match-wins with no fence awareness, so a
  duplicate section was invisible and a fenced example was live data. Both refuse here.
- v1 scar (`github.ts`): `is404` matched `gh` stderr text; this verb branches on HTTP status.
- The three-state assignee slot is #4693's landed shape — unread is UNKNOWN, never permissive.

---

## `plan check`

**Invocation**

```
fabrika plan check 4300 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose ledger is gated |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository read |

**Output** — machine. On a clean floor:

```
{"answer": "clean", "epic": 4300, "scanned": [4301,4302], "digest": "a1b2c3d4e5f6", "skipped": []}
```

On a defective floor the same object with `"answer": "defective"` and a sorted `defects` array,
each `{"type", "refs", "detail"}` — emitted on **stdout** with exit `20`, because a proven FAIL is
an answer:

```
{"answer": "defective", "epic": 4300, "scanned": [4301,4302], "digest": "a1b2c3d4e5f6", "skipped": ["MISSING_CONTAINMENT"],
 "defects": [{"type":"ZERO_AC","refs":[4302],"detail":"acceptance criteria read as malformed"}]}
```

`skipped` names any defect class **not derived** and why it could not be — today only
`MISSING_CONTAINMENT`, when `cycleDoc` is `unknown`. v1 disabled that whole class silently whenever
its probe merely failed; naming it on the answer is the fix. A `skipped` class never makes the
floor clean by omission: with a non-empty `skipped`, `answer` is `clean-partial`, exit `0`, and
the caller can see exactly what was not asked.

This verb re-runs `plan read`'s fetch itself rather than taking a ledger on stdin — a floor that
trusted a caller-supplied ledger would grade a document the caller could edit.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | zero scope, exactly as `plan read` — the epic is proven absent or closed, or has zero children |
| `10` | the issue is not a `type:epic` |
| `11` | any read the floor depends on failed — nothing is graded, no verdict is implied |
| `20` | proven: the floor derived one or more hard defects |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `plan check: #<n> has zero children — refusing to answer over zero scope (ADR 0092).` | 7 | refusal |
| `plan check: <k> hard defect(s) — nothing is flipped. See stdout for the set.` | 20 | notice |
| `plan check: cannot read <what>: <reason> — the floor is UNKNOWN, not clean.` | 11 | refusal |

**Scope** — every child of the epic, no sampling and no cap. The stderr `scannedLine` names the
scanned set on **both** arms, so a PASS states the scope it rests on. Zero scope is `7`.

**Examples**

```
$ fabrika plan check 4300
{"answer":"clean","epic":4300,"scanned":[4301,4302],"digest":"a1b2c3d4e5f6","skipped":[]}
$ echo $?
0
```

```
$ fabrika plan check 4300
{"answer":"defective","epic":4300,"scanned":[4301,4302],"digest":"a1b2c3d4e5f6","skipped":[],"defects":[{"type":"HELD_CHILD_UNASSIGNED","refs":[4302],"detail":"ready-for:human with an empty assignee slot"}]}
$ echo $?
20
```

**Grounding**

- v1's gate exited `0` on FAIL and printed a `✓`/`✗` glyph, so `run-gate.sh && proceed` proceeded
  on a failure. `20` is that hole closed.
- ADR 0047 D2 / #4894 — this verb is the *whole* pass/fail decision; the advisory layer above it
  cannot change the answer.
- ADR 0092 — zero scope reds, and the scanned set is stated on both arms.
- #4101 / #2413 — the priority set is `{p0,p1,p2}`; `p3` is retired, not admitted.

---

## `plan flip`

**Invocation**

```
fabrika plan flip 4300 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose planned children are flipped |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository written |

**Output** — machine. The **observed** result per child, never the intended one:

```
{"answer": "flipped", "epic": 4300, "digest": "a1b2c3d4e5f6",
 "children": [{"number": 4301, "observed": ["p1","status:triaged","type:feature"], "result": "flipped"},
              {"number": 4302, "observed": ["p2","status:triaged","type:chore"], "result": "already"}],
 "flipped": 1, "already": 1}
```

`result` is closed: `flipped` (the labels moved and the re-read proves it) · `already` (it was
already `status:triaged` — an idempotent no-op, not a flip) · `unchanged` (the write did not take;
this arm forces exit `22`).

**The flip is unconditional over every `status:planned` child** — ruled, with no per-child
predicate and no opt-out hook (#4693 AC4). The barrier keeping a held child out of the build pool
is the assignee slot, which this verb never touches and `plan check` checks instead.

Order of operations, each guard designed against a named v1 failure:

1. **Re-gate.** Re-run the floor and recompute the digest. Any defect, or a digest differing from
   the one at check time, refuses on `21`. This is the TOCTOU answer: the gap between deciding and
   writing is closed by re-deciding, not by trusting.
2. **Vocabulary precondition.** Confirm `status:triaged` and `status:planned` exist in the
   repository's label list. `POST .../labels` **creates** an unknown label rather than rejecting it
   (#4285), so an absent label would be silently minted; refuse on `23` instead.
3. **Write, bounded and per-child.** Concurrency 8, decomposed into individually-observable add and
   remove calls so the failure index is reportable — never a replace-set `PUT`. Label removal is
   404-benign through the imported `removeLabel`, so a concurrently-flipped child is a no-op rather
   than an abort. **A failing child does not abort its siblings**; every child is attempted.
4. **Re-read every child** and report its observed labels. v1 asserted the flip from its
   pre-mutation intent list and re-read nothing, so a child left carrying both labels — the ADD
   landing and the DELETE failing — was reported as pickable.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | zero scope — the epic is proven absent or closed, or has zero children |
| `10` | the issue is not a `type:epic` |
| `11` | a read the flip depends on failed — **nothing is written** |
| `15` | proven: this session does not hold the epic's claim |
| `20` | proven: the re-gate found hard defects — the floor is not clean, nothing is written |
| `21` | proven: the floor was clean but the scope digest moved since the check — the plan changed under the gate |
| `22` | proven: some children were written and some were not — the observed set is on stderr |
| `23` | proven: `status:triaged` or `status:planned` is absent from the repository's labels |
| `8` | a write was attempted and no re-read could prove its outcome — UNKNOWN |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `plan flip: the floor is not clean (<k> defect(s)) — refusing to flip.` | 20 | refusal |
| `plan flip: the plan moved since the check (digest <a> → <b>) — re-check before flipping.` | 21 | refusal |
| `plan flip: <a> of <n> children flipped; <b> did not (#<x>, #<y>) — the epic is half-flipped and needs a human.` | 22 | refusal |
| `plan flip: label "<name>" does not exist in <repo> — refusing to create it (#4285).` | 23 | refusal |
| `plan flip: wrote <n> label change(s) and could not re-read <what> — the outcome is UNKNOWN.` | 8 | refusal |
| `plan flip: this session does not hold #<n>'s claim.` | 15 | refusal |

**Scope** — every child of the epic carrying `status:planned`. Zero such children is **not** zero
scope: it is the answer `{"answer":"flipped","flipped":0,"already":<n>,…}` at exit `0`, because a
gate that finds its work already done has succeeded. Zero *children* is `7`.

**Examples**

```
$ fabrika plan flip 4300
{"answer":"flipped","epic":4300,"digest":"a1b2c3d4e5f6","children":[{"number":4301,"observed":["p1","status:triaged","type:feature"],"result":"flipped"}],"flipped":1,"already":0}
```

```
$ fabrika plan flip 4300
plan flip: 1 of 2 children flipped; 1 did not (#4302) — the epic is half-flipped and needs a human.
$ echo $?
22
```

**Grounding**

- #4693 AC4 — the flip stays unconditional; a per-child exception hook is the escape hatch the gate
  deliberately lacks.
- v1 scars: unbounded `Effect.forEach` aborting on the first failure, a two-call flip leaving both
  labels, the PASS comment posted only after every write so a partial flip posted nothing, and
  `discard: true` erasing the per-child record. Steps 3 and 4 answer all four.
- #4285 — `POST .../labels` creates unknown labels; the vocabulary check is a precondition.
- ADR 0058's shape — the re-gate is a relation checked at write time, not a cached decision.

---

## `plan verdict`

**Invocation**

```
fabrika plan verdict 4300 --polarity PASS [--repo <owner/name>] <<'EOF'
caveat: ac-not-checkable #4302 — "works well" states no observable outcome
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic the verdict is posted on |
| `--polarity` | enum: `PASS` \| `FAIL` | yes | — | the gate's verdict; a third token is not a polarity |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository written |
| stdin | markdown | no | empty | advisory caveats, one per line, each `caveat: <kind> #<ref> — <text>`; empty is an ordinary answer |

**Output** — machine.
`{"answer": "posted", "epic": 4300, "polarity": "PASS", "digest": "a1b2c3d4e5f6", "comment": 5230661234, "caveats": 1}`

The comment's first non-blank line is the marker, composed by the imported `emit`:

```
check-epic-plan: PASS @ a1b2c3d4e5f6 — 2 children scanned, floor clean
```

A marker merely quoted further down is not one. Below it the verb renders the scanned set, the
defect list on a `FAIL`, and the caveats verbatim under their kinds.

**Caveat kinds are a closed set** — `ac-not-checkable` · `brief-fidelity` · `slice-too-broad` ·
`dependency-implied-not-declared`. An off-set kind refuses on `10`. Caveats are **advisory**: they
are recorded beside a `PASS` and the verb has no path by which a caveat changes the polarity
(ADR 0047 D2). A `FAIL` polarity with no defects on record refuses on `10` — the polarity is the
floor's, taken as input, not the caller's opinion.

Guards, in order: polarity on-enum (`10`); every caveat kind on-enum and every caveat naming a ref
in the scanned set (`10`); the recomputed digest binds through `bindToHead` (`24` on `Unbindable`);
the authored text leak-scanned (`5`/`6`) — the caveat text is model-authored, which is exactly the
surface those seats exist for; post, then **re-read the posted comment** and compare through
`normalizeForReadback` (`8` on an unprovable write, `9` on a mismatch). The verb is the only emit
path; a hand-posted marker is how v1's corpus carried a fake-looking PASS for weeks.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `5` | the authored caveat text carries a machine-local path |
| `6` | the authored caveat text is a bare `@` path reference |
| `7` | zero scope — the epic is proven absent or closed |
| `8` | the comment was posted and no re-read could prove it — UNKNOWN |
| `9` | the comment posted but the read-back does not match |
| `10` | polarity off-enum; a caveat kind off the closed set; a caveat naming a ref outside the scanned set; `FAIL` with no defects on record |
| `11` | a read the verdict depends on failed — nothing is posted |
| `15` | proven: this session does not hold the epic's claim |
| `24` | proven: the scope digest is `Unbindable` against the live plan |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `plan verdict: --polarity must be PASS or FAIL — got "<v>".` | 10 | refusal |
| `plan verdict: caveat kind "<v>" is not in the closed set (ac-not-checkable, brief-fidelity, slice-too-broad, dependency-implied-not-declared).` | 10 | refusal |
| `plan verdict: caveat names #<n>, which is not in the scanned set.` | 10 | refusal |
| `plan verdict: --polarity FAIL, but the floor recorded no defects — a verdict relays the floor, it does not form one.` | 10 | refusal |
| `plan verdict: the scope digest cannot be recomputed against the live plan — the verdict would bind nothing.` | 24 | refusal |
| `plan verdict: the comment posted but does not read back — the verdict needs a human eye.` | 9 | refusal |
| `plan verdict: the authored caveats carry a machine-local path (<masked>).` | 5 | refusal |

**Scope** — one epic, one comment. Not a judging verb: it relays a verdict the floor produced.

**Examples**

```
$ fabrika plan verdict 4300 --polarity PASS <<'EOF'
caveat: ac-not-checkable #4302 — "works well" states no observable outcome
EOF
{"answer":"posted","epic":4300,"polarity":"PASS","digest":"a1b2c3d4e5f6","comment":5230661234,"caveats":1}
```

```
$ fabrika plan verdict 4300 --polarity FAIL <<'EOF'
caveat: vibes #4302 — feels thin
EOF
plan verdict: caveat kind "vibes" is not in the closed set (ac-not-checkable, brief-fidelity, slice-too-broad, dependency-implied-not-declared).
$ echo $?
10
```

**Grounding**

- #5096 — an unmarked verdict is invisible to any drift check; the marker plus the scope digest is
  what makes gate state checkable by a later reader.
- ADR 0058 via `bindToHead` — `Unbindable` never renders as `Current`.
- ADR 0047 D2 — caveats annotate, never block; there is no code path from a caveat to a polarity.
- `report/leaks.ts` — the caveat text is model-authored prose reaching a public surface, which is
  the seat `5`/`6` exist for.
- v1 hand-posted a gate verdict by hand at least once and it read as genuine; the single emit path
  plus the read-back is that hole closed.

---

## Required repo files (verb-level)

The skill's own table ([SKILL.md](SKILL.md)) carries the run-level rows; these are the reads and
writes this contract's verbs make, so an implementer sees the dependency set in one place.
Vocabulary: **fail-loud** / **degrade** / **bootstrap** (front-door, #4952).

| Must exist | Why | When missing |
| --- | --- | --- |
| The epic issue: `type:epic`, a `## Dependencies` block, native sub-issue links | `plan read` derives the whole ledger from it | **fail-loud** — exit `4`/`7`/`10` naming the gap; route to the planning lane. |
| Child issues carrying `### Acceptance criteria` blocks | the imported wire read supplies `ZERO_AC`'s input | **fail-loud** — the read's `absent`/`malformed` is carried as a token and becomes a defect; no criterion is invented. |
| Labels `status:planned`, `status:triaged`, `status:needs-triage`, `ready-for:human`, `type:*`, `p0`/`p1`/`p2` | the floor reads them; the flip writes two | **fail-loud** — `plan flip` exits `23` rather than creating a label (#4285); taxonomy creation is the front door's. |
| `product-development-cycle.md` at the repo root | gates whether `MISSING_CONTAINMENT` is derived | **degrade** — the class is skipped, named in the answer's `skipped` array, and the arm becomes `clean-partial`. Never silently dropped. |
| Repository permissions readable | `build claim`'s ACL-sourced ownership resolution (ADR 0055) | **fail-loud** — as declared in [`build`'s table](../build/contract.md); an unreadable permission is `Unknown`, never a demotion. |

---

## Completeness self-test

Per the [interface convention](../../docs/cli-interface-convention.md) Part 2: every flag carries a
type and default; every stdout shape has a literal example; every non-zero code is enumerated with
its trigger (the shared matrix owns each code's single meaning, the per-verb tables own the
triggers, and the universal `0`/`1`/`2`/`127` are stated exactly once); every error names its
message, stream and code; every judging verb states its scope and its zero-scope behavior; no
clause defers to a v1 script, another skill's prose, or the authoring session — every
cross-reference is to a **landed sibling fabrika contract or a shipped module by path**.

The three hand-checks, which the presence tests above cannot perform:

1. **Every reachable outcome has a code.** Walked per verb, including the modes v1 had no name for:
   a partial flip (`22`), a floor that moved under the gate (`21`), a label the repo does not carry
   (`23`), a digest that cannot bind (`24`), and a defect class that could not be derived (the
   `skipped` array plus the `clean-partial` arm, which is an *answer*, not a code). The one
   deliberate non-seat is `3`: `plan verdict`'s stdin is optional, so an empty stdin is a fact.
2. **Every example value is derivable.** The digest from the serialization in §Scope digest; the
   defect `type` values from the thirteen-row table; `result` from the closed
   `flipped`/`already`/`unchanged` set; the marker line from the imported `emit` template.
3. **Sibling verbs guard shared preconditions identically.** All four run `resolveTargetRepo` and
   the `type:epic` check; both mutating verbs run the imported `requireClaim` on the epic; `read`,
   `check` and `flip` share one zero-scope rule (`7` on zero children) and `flip` states its one
   documented divergence — zero *planned* children is an answer, not a refusal — with its reason.
