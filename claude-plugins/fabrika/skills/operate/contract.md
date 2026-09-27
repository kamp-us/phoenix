# `lane` verbs — derived CLI contract

**Skill:** [`operate`](SKILL.md) · **Date:** 2026-09-27

These verbs live in `packages/fabrika-cli/src/lane/`, grouped under `fabrika lane`. Each verb's
`--help` owns the caller facts: invocation, flags, answer bytes, a one-line meaning per exit and a
runnable example. This file owns what help leaves out, per the
[leaf help size and shape](../../docs/interface-convention.md#leaf-help-size-and-shape) rule: how a
value is derived, why a check exists, the order mutations run in, and the conditions behind each
exit. A verb's help ends on a pointer to its section here. Read one section by heading:

```bash
fabrika wire doc-section --heading "lane transition" < <skill-base>/contract.md
```

A `lane` verb with no section here still carries these facts in its own `--help`.

## Shared conventions

### The lanes root

Every repository-rooted verb resolves its lanes root before any other read. With `--root` absent,
the root is derived off the primary checkout of the repository that owns the cwd, so every worktree
reads the same ledger.

- `39` — no `.git` entry exists at or above the cwd, so there is no owning repository from which to
  derive the default lanes root. An unreadable repository identity is UNKNOWN at `11`. `39` is NOT
  "no lane here", so it is never a boot.
- `65` — the lanes root stands inside a linked worktree instead of the repository that owns it, so
  it is a second copy of that ledger frozen at whatever moment it was written. Nothing was read and
  nothing was appended. Pass a root under the owning repository, or drop `--root`.

### The shared read and record exits

- `4` — the lane record (`workflow.json`, `events.jsonl`) was read in full and is not the shape.
  Every defect is on stderr.
- `7` — no lane there. Copy a workflow template, or run `lane open`, to open one.
- `8` — the append or write did not land, so the event is NOT recorded.
- `11` — a lane, board or tree read failed. Whatever the verb was asked is UNKNOWN, never fresh and
  never proven.
- `13` — the task is not in the machine, names no issue, or `--task` was omitted on a multi-task
  lane.
- `21` — the key is not a lane key.

### The proof refusals

`lane transition` and `lane report` prove an event through `lane prove`'s own read before they
append it, and refuse on the prover's own code with the log byte-identical. The remedies are
`lane prove`'s, unchanged:

- `22` — the artifact is provably absent.
- `23` — a required namespace has no current or still-binding verdict. Re-read, record nothing.
- `24` — a FAIL under a claimed PASS or park, or under a claimed rewind a PR still linking the issue
  or a closed issue.
- `25` — several candidates: several open PRs link the issue, or several lane branches carry the
  child's commits.
- `67` — a standing lane class routes this event into a cell the head derives nothing for. `23`
  says a namespace this head derives holds no binding verdict yet, and is answered by producing
  one. `67` says the head derives no such namespace at all, and is answered by relaying the classes
  the head raises, which `review scope` prints.

### Park causes and lane classes

`lane transition` and `lane report` are the two verbs here that take `--cause` and `--class` on a
`BLOCKED`, with the meanings on those flags. They are not the only writers of one: `lane recover
--spawns` records a `BLOCKED` with the fixed cause `spawn-dead` when it parks a dead builder.

- An optional `--cause` lands on a BLOCKED's event line and is what `recipe unpark` keys its recipe
  table on. Every cause also carries a route, `driver` or `founder`, saying whose failure the park
  is. A BLOCKED with no cause is the bare park it always was: it is novel and routes to a human, so
  it costs a human UNBLOCKED.
- `35` — `--cause` is outside the closed park-cause set, or rides on an event that is neither
  BLOCKED nor the machinery LAP.
- `52` — a BLOCKED names no cause at all, under a repo declaring `parkCause.uncaused: "refuse"`.
  Name one from the closed set; the log is unappended.
- A repeatable `--class` lands the lane classes standing at the event on the same line. It is the
  fact the machine's `class:<name>` arms route on: `--class ui` on a WIP sends the lane to
  `build:ui`, and it stands until another event names a different set.
- `38` — `--class` is outside the closed lane-class set.

## `lane status`

### Output

One lane's derived state, folded fresh from the whole `events.jsonl` on every invocation. There is
no resident process and no snapshot. The status JSON carries:

- a compound `stateValue`: the active phase maps to each task's leaf state, future phases read
  `"waiting"`, and a finished workflow is a bare terminal;
- `status`, `active` or `done`;
- per-task `{retries, maxRetries, …}` context, with the tripped tasks in `errors`.

A lane whose task reached a `done:diagnosis` arm's final answers that leaf as the bare terminal,
`diagnosed` on the coder machine, rather than the workflow's `complete`. A finished investigation
reads as itself and never as the shipped lane's word.

### Exit status

`4`, `7`, `11` and `21` are the [shared read exits](#the-shared-read-and-record-exits); `11` means
the lane's state is UNKNOWN, never fresh. `39` and `65` are [the lanes root](#the-lanes-root).

## `lane transition`

### Output

Records one operator event on the lane's append-only log after the machine accepts it, never
before, and after `lane prove`'s own read proves the artifact behind it. The proof is this verb's,
not a command a driver is told to run first:

- a DONE and a PASS reach the log only with their artifact behind them;
- a reviewer's park reaches it only while no FAIL at the head says the run reached a verdict;
- a WIP out of `review` or `review:ui`, the rewind to `queued` that spends no retry and no lap,
  reaches it only while the task's issue is open and no open PR links it;
- every other event answers `not-required`, or `not-walkable` where this lane's machine walks no
  such event out of the task's leaf, without a board read.

stdout is `{previous, event, current, taskAffected}` with the two stateValues around the fold, plus
`waitGrant` when the resume granted waits, `rationale` when it named why the park was cleared, and
the prover's own `deferred`, `partial`, `landed` and `diagnosis` where the read answered them. These
are the same fields `lane report` records, so the driver's line and a shell's carry the same facts.

An invalid event is refused loudly and the log is left byte-identical: no cell in the task's
current state (tea's NoCellError, surfaced verbatim), an event outside the operator's set, a task
outside the active phase, or a finished workflow.

A cleared round is NOT recorded here. It is a `<TASK>.CLEARED` event that `build clear` or
`lane clear` appends; it targets no state, and the operator's set is unchanged.

`--cause` and `--class` follow [park causes and lane classes](#park-causes-and-lane-classes).

An optional `--grant-wait` lands the waits a resume buys on the same UNBLOCKED line, so one recorded
event both clears the park and pays for the read the lane resumes to take. It is the human fallback
for a `human:queue-stall` whose `recipe unpark` proving read cannot run. `build clear` is not it:
that buys a repair round and never a longer wait.

An optional `--rationale` rides the same UNBLOCKED and says why the park was cleared. It is the
driver's own recommendation, which `recipe unpark` passes when it clears a driver-routed park, and
which `lane status` reads back as the task's standing `rationale`.

### Exit status

- `4`, `7`, `8`, `11`, `13`, `21` — the [shared exits](#the-shared-read-and-record-exits). On `11`,
  whether the event is proven is UNKNOWN.
- `12` — the event is refused and the log is unappended.
- `22`, `23`, `24`, `25`, `67` — [the proof refusals](#the-proof-refusals).
- `35`, `38`, `52` — [park causes and lane classes](#park-causes-and-lane-classes).
- `36` — a resume would restore the state and not the budget it lands on. Out of an error final,
  record the cleared round first; the two land in either order, `build clear` where a pull request
  carries the founder's grant and `lane clear` where the lane has none. Out of a wait park, grant
  the waits on this same resume, which `recipe unpark` does once it has proven the queue moved.
- `40` — another writer held the ledger lock.
- `47` — `--grant-wait` is not a whole grant of at least one wait, or rides on an event that is not
  UNBLOCKED.
- `53` — `--rationale` says nothing, or rides on an event that is not UNBLOCKED.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane clear`

### Output

Grants one repair round on a lane whose budget is spent, by appending the `<TASK>.CLEARED` event
that is the only source of a repair budget. Where the task has a pull request, it grants that PR's
own budget the same round in the same act. This is the driver's seat.

It reaches the lanes `build clear` cannot: an epic child and a chore lane open no pull request, and
they parked at their cap with a door nothing could walk. It also reaches the PR-side budget a
builder actually reads, which a lane-side grant alone never bought.

The round is DERIVED on both sides, never typed. The lane's is the round the task's own declared cap
freezes at, given the grants already in its log; the PR's is its FAIL-marker round count. So one
call buys exactly one round, and the next needs its own call and its own recommendation.

The `--rationale` is posted on the PR as the grant's dated authorization, and the `cap-cleared`
marker lands beside it, so `build verdicts` honours it through the same four clauses it honours a
founder's grant under. The account still has to be in `.fabrika.jsonc`'s grant-author set at the
PR's base ref, and still has to hold write+ at GitHub's ACL: the ruling moved the founder DOCUMENT
off a driver's grant and never the ACL. `build clear` is unchanged, and stays the founder's verb for
a bare PR-side grant with no lane clear behind it.

The PR half runs FIRST, so every refusal leaves the log byte-identical and a re-run derives the same
round. A task with no pull request answers `pr: null`, and the lane-side grant proceeds.

stdout is `{answer, lane, task, round, budget, rationale, pr}`:

- `answer` is `cleared` on a grant that landed, and `held` on one the log already carried. A grant
  is keyed by its round and set-semantic, so a re-run doubles nothing.
- `pr` is `null`, or `{number, answer, round, cap}` whose own `answer` is `cleared` (posted now),
  `held` (an honoured grant already stood at that round) or `unspent` (the PR's budget was not
  spent, so there was no round there to clear).

It grants a repair round and never a longer wait; waits ride their own resume through
`lane transition --grant-wait`. Recording the grant does not move the task: the park's door is still
the `UNBLOCKED`, and the two land in either order.

### Exit status

- `4`, `7`, `13`, `21` — the [shared exits](#the-shared-read-and-record-exits).
- `5` — the `--rationale` carries a machine-local path and is headed for a public pull request.
- `6` — the `--rationale` IS a bare @ path reference.
- `8` — the append did not land, or a comment write on the PR did not. The round is NOT cleared.
- `9` — the marker posted and does not read back.
- `11` — the lane, the board, or the invoking account's authority could not be read. UNKNOWN, and
  nothing posted.
- `20` — several open PRs link the task's issue. Which one carries its budget is not this verb's to
  guess.
- `47` — the task still has budget to spend, so there is no round to grant.
- `53` — `--rationale` says nothing.
- `66` — the invoking account is outside the grant-author set at the PR's base ref, or below write.
  A marker it posted would be void, so the whole grant is refused; `build clear` from an account
  that may is the route.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane report`

### Output

Records a spawned shell's terminal token on the lane's append-only log. The token→event map in code
(`report.ts`) picks one of the operator's events. The mapped event is then proven exactly as
`lane prove` proves it, because a token is a self-report:

- a DONE and a PASS reach the log only with their artifact behind them;
- a reviewer's park only while no FAIL at the head says the run reached a verdict;
- a WIP out of a review cell only while the issue is open and no open PR links it;
- every other event answers `not-required`, or `not-walkable` where this lane's machine walks no such
  event out of the task's leaf, without a board read.

Only then does the append ride `lane transition`'s exact path, validated against the folded state
first and refused unappended otherwise.

Optional `--pr` and `--comment` refs land on the event line itself, so the event names its evidence,
visible through `lane history`. `--pr` is also what the closure read reads: the ref is handed to the
prover as well as recorded on the line, because the closure is judged off exactly that PR.
`--cause` and `--class` follow [park causes and lane classes](#park-causes-and-lane-classes); a repo
that declares `parkCause.uncaused: "refuse"` refuses a cause-less BLOCKED at `52` rather than
recording one.

Four more fields land on the line, and each is the prover's, never a flag:

- `deferred` names the namespaces the proof subtracted from this cell's bar and handed to a later
  one, such as the routed `review-ui` an epic child owes its epic's tail. It is absent wherever the
  bar was whole.
- `partial` rides the ship stage's DONE. It says whether the merge behind this terminal carried
  `Part of #N` and left the issue open, which is what the machine's `merge:partial` arm routes on.
  It rides at BOTH polarities, `true` on a partial merge and `false` on a closing one, so the line
  records that the closure was read and `lane reconcile` never buys that read again. It is absent
  wherever no closure was read: every event but the ship stage's DONE, plus a ship DONE whose read
  answered `unknown`. `landed` rides beside it as that read's evidence, the merged PRs the closure
  judged, absent wherever `partial` is. So a recorded `false` says which reader wrote it and not
  only which way it fell, which is what `lane reconcile` reads to tell a real answer from the old
  nominator's fallthrough.
- `diagnosis` rides a DONE out of `build`. It says the prover stood this terminal on a diagnosis
  comment rather than a pull request, which is what the machine's `done:diagnosis` arm carries a
  finished investigation to its own `diagnosed` terminal on, instead of the `review` it opened no PR
  for. It rides at `true` only, and only off `lane prove`'s no-PR arm. All three builder terminals
  report one DONE, so a `SHIPPED-PR` and an epic child's `BUILT-NO-PR` carry no such field and fold
  to `review` exactly as they always did.
- `routed` is `deferred`'s complement: the required namespaces the proof stood on a head-bound
  routed-elsewhere record for, rather than on a verdict. `deferred` says a verdict is still owed
  somewhere; `routed` says none is owed at all. It is absent wherever every namespace was judged.

One token is not a constant, and `routed` is what makes its line legible. `ROUTED-ELSEWHERE` maps
flat to BLOCKED and, out of `review:ui` alone, also names PASS; the proof picks between them. A
published route beside a complete set of binding verdicts is a finished review, so the verb records
the PASS, drops the `--cause` the caller passed, and the lane walks to `ship`. A missing, stale,
unauthorized or unreadable route, an outstanding required review or a standing FAIL all leave that
proof unearned and record the caused park byte-for-byte as before. The advance is tried, never
assumed: this lane's own machine must hold the arm, and `lane prove` must earn it unmodified. No
`review-ui` verdict is written or assumed either way.

A queue wait is floored as well as counted. A WIP standing in `ship:queued` is refused at `55`
unless 480s of elapsed time, the shipper's own watch horizon, have run since that task's last
recorded line. So the wait budget measures how long a PR has sat rather than how fast a driver
passes, and the refusal names the seconds still to run.

One group of tokens belongs to no shell: the machinery group (`REPLAY-COLLIDED`, `BASE-DRIFTED`,
`BASE-CONFLICTED`, `QUEUE-EJECTED`, `SEAT-DIRTY`, `SHELL-DEAD`), which a driver records about the
pipeline itself. Each maps to the machine's LAP event, spending the lap budget instead of the repair
one. Each carries its own cause off the same closed set with no `--cause` typed; pass one to
override it, and a cause outside the set still refuses at `35`.

stdout is `{token, previous, event, current, taskAffected}` plus the refs, plus `deferred` when the
proof deferred anything, `routed` when it stood on a route, `partial` at whichever polarity the
closure read answered, `diagnosis` where the terminal stood on one, and `landed` where it answered
at all.

### Exit status

- `4`, `7`, `8`, `11`, `13`, `21` — the [shared exits](#the-shared-read-and-record-exits). On `11`,
  whether the event is proven is UNKNOWN.
- `12` — the mapped event is refused and the log is unappended. That includes a machinery lap whose
  cause this lane's own machine holds no arm for, which a lane opened before that cause existed
  would otherwise loop the stage on.
- `22`, `23`, `24`, `25`, `67` — [the proof refusals](#the-proof-refusals).
- `32` — the token is no shell's terminal token. Refused, never interpreted.
- `35`, `38`, `52` — [park causes and lane classes](#park-causes-and-lane-classes).
- `40` — another writer held the ledger lock.
- `55` — a `ship:queued` re-fold arrived inside the elapsed-time floor, or the clock on that task's
  last line reads as no date. The log is unappended and the wait unspent, and the only remedy on
  the first is time.
- `68` — `--integrate-exit` and `--assembly-head` are missing on a FAIL out of an epic child's
  `integrate` cell, malformed, only half given, or given on any other line. The log is unappended.
  That pair is the only record a repair builder's `build claim --lane` reads an integrate FAIL off,
  and it lands on the line as `integrate`.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane attach-integrate`

### Output

Attaches the `lane integrate` exit and assembly head to an epic child's integrate FAIL that was
recorded before `lane report` carried them. `build claim --lane` reads an integrate FAIL only off
that pair, and once the pair-less FAIL folded the task back into `build`, `lane report` refuses the
pair there at `68`. So a lane in that state has no builder that can take its repair.

This verb appends one `<TASK>.CORRECTED` line naming the FAIL by its `at` and carrying
`integrate: {exit, head}`. No recorded line is rewritten or dropped, and `build claim` and
`build resume-child` read the FAIL through the correction exactly as if it had been recorded with
the pair. The line is judged before the ledger lock and again under it.

A FAIL an earlier attach already paired is not refused: a second run appends a second CORRECTED and
the later pair wins, which is how a wrong exit or head is fixed.

stdout is `{lane, task, event, corrects, integrate}`.

### Exit status

- `4` — the lane record was read in full and is not the shape, or the log does not replay.
- `7`, `11`, `21` — the [shared read exits](#the-shared-read-and-record-exits).
- `8` — the append did not land, so the pair is NOT attached.
- `13` — the task is not in the machine, or `--task` was omitted on a multi-task lane.
- `40` — another writer held the ledger lock.
- `68` — the named line may not take the pair, or the pair is malformed, and the log is unappended.
  It refuses when the named line is not a FAIL recorded out of `integrate`, when a later DONE on the
  task already answered it, when `lane report` recorded it with its own pair, when no line or more
  than one of the task stands at that `at`, or when the exit is not `42`, `43` or `44` or the head is
  not a commit sha.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane prove`

### Output

Reads the artifact a lane event claims: artifacts over self-reports. It writes nothing; the append
stays `lane transition`'s. Exit `0` carries three answers, and the `proof` field says which:

- `proven` read the artifact;
- `not-required` is an event this leaf walks that claims no artifact, so record it;
- `not-walkable` is an event the machine would refuse out of this leaf, so record nothing.

The walk question is the lane's own machine's, asked before any claim is derived. It separates an
event name no state holds a cell for (the ledger's own namespaced `ISSUE.PASS`, or a typo) from a
recognised event this leaf owes no cell, of which a PASS out of the `blocked` park is the pinned
case. The stderr names what the leaf does walk. Both used to answer `not-required`, so a driver who
ran the read before the UNBLOCKED that reopens the lane read a green that had checked nothing.

Four events carry a claim, and which artifact answers them is the task's shape.

**On a single-issue lane and on an epic run's tail:**

- A DONE out of `build` or `build:ui` claims an open PR whose body links the task's issue. For an
  investigation it claims instead the diagnosis comment a no-PR builder posted since the task
  entered build, which is the one arm that answers a `diagnosis` field beside the proof. `lane
  report` relays that field onto the recorded line, where the machine's `done:diagnosis` arm reads
  it.
- A PASS out of `review` claims a current-head verdict in every namespace that PR's diff derives,
  governance included, minus, and only minus, a routed namespace this very event's arm hands to a
  later cell of this lane's own machine (`--class ui` into `review:ui`), which then proves the whole
  set.
- A `review-ui` verdict counts only while its evidence opens, which is `ship gate`'s own re-check:
  the gallery's hosted captures are re-read through GitHub's renderer and held to the sha256 each
  one records. One whose evidence does not open rows `unopened`, which proves no PASS and is no FAIL
  a park must answer. A re-check that could not read the comment rows `unknown`.
- A verdict is current only if it binds this head AND was written after the newest standing ruling
  on the issue. A founder ruling recorded by `decision rule` moves the contract, so a PASS written
  before it graded a spec that no longer holds, and rows stale at `23`. The rulings are read through
  the same roster-gated scan `review criteria` folds, so an off-roster marker rules nothing. A
  comment page or roster that will not read is `11`, never "nobody ruled". The park arm asks none
  of this.

**On an epic run's child, which opens no PR at all:**

- A DONE out of `build` or `build:ui` claims the commits its lane branch adds over `epic/<n>` in
  THIS tree.
- A PASS out of `review` claims a range-scoped verdict on the child issue still bound to the content
  that range carries now, for every namespace that range derives except the routed one. A child's
  deferral is unconditional, and its creditor is the tail.

**The reviewer's park** is the third claim: a BLOCKED out of `review` or `review:ui` on a lane that
owns a PR. It is the first negative claim: it says the run reached no verdict, so a still-binding
FAIL refuses it at `24`, and every unreadable half records it.

**The review rewind** is the fourth: a WIP out of `review` or `review:ui` on a single-issue lane,
which the coder machine walks back to `queued` without spending a retry or a lap. It is the second
negative claim: it says the task's issue is still open and no open PR links it any more, because the
PR under review was re-pointed at another issue. A closed issue is finished work for `lane settle`,
never a rewind. It reads the same nominator `lane brief` resolves its PR through. It answers
`proven` with `evidence.kind: no-linking-pull` when no candidate's body links the issue, refuses at
`24` while one or more still does, and is UNKNOWN at `11` when the board does not read. It is never
recorded on a guess, since it drops the review.

**A DONE out of `ship` or `ship:queued`** answers `not-required` too, and reads one thing more on
the way: whether the merge behind it closed this issue or carried `Part of #N`. It answers that as a
`closure` field reading `closes`, `partial` or `unknown` beside the usual ones, with a `landed`
field naming the merged PRs an answered read stood on; `lane report` relays both onto the recorded
line. That closure is read off the PR `--pr` names and NOT off the nominator, which cannot see the
subject: GitHub builds the closing edge from closing keywords, and the search half pins `is:open`,
so a merged `Part of #N` is a node in neither. It is a routing fact, not a claim. It refuses nothing
about the merge and nothing about the board: no `--pr`, or a PR read that failed, answers
`unknown`, which records NO `partial` and leaves the line for `lane reconcile` to read again rather
than stranding the shipper.

The refusals are artifact-independent, so the range arms take no new seat.

### Exit status

- `4`, `7`, `13`, `21` — the [shared exits](#the-shared-read-and-record-exits).
- `11` — a lane, board or tree read failed, so the proof is UNKNOWN, never proven. An epic branch
  this tree does not carry is UNKNOWN too, as is a shallow clone whose graft boundary is the
  assembly tip or the child's fork point, where the stderr names `git fetch --deepen=25`.
- `22` — the artifact is provably not there.
- `23` — a required namespace has no current or still-binding verdict. Re-read, record nothing.
- `24` — a FAIL under a claimed PASS, or under a reviewer's claimed park; or, under a claimed review
  rewind, an open PR that still links the issue or the issue closed.
- `25` — several open PRs link the issue, or several lane branches carry the child's commits.
- `38`, `67` — see [the proof refusals](#the-proof-refusals) and
  [lane classes](#park-causes-and-lane-classes).
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane history`

### Output

The lane's append-only event log, verbatim: one `{task, event, at}` per recorded event, in append
order. Each line also carries, where it applies:

- the `pr` or `comment` ref, where the event was recorded with one as its evidence;
- the `round` a `CLEARED` clears;
- the `classes` a class-carrying event named;
- the `diagnosis` a build DONE proven off a diagnosis comment carries;
- the `deferred` namespaces a proof subtracted from that event's bar and handed to a later cell, such
  as the routed `review-ui` an epic child owes its epic's tail, absent wherever the bar was whole;
- the `partial` a ship's DONE carries at either polarity once its closure was read: `true` where the
  merge left the issue open, `false` where it closed it, absent where nobody read it; and the
  `landed` PRs that read stood on beside it.

The log IS the history. `from` and `to` are reconstructible by folding, never stored. A lane with no
events yet answers `[]`.

### Exit status

`4`, `7`, `11` and `21` are the [shared read exits](#the-shared-read-and-record-exits). `39` and
`65` are [the lanes root](#the-lanes-root).

## `lane print`

### Output

The lane's compiled machine topology: phases in order, the two workflow terminals, and per task its
initial state, retry budget, and each state's legal events. Everything absent refuses at transition
time.

### Exit status

`4` (`workflow.json` read in full and not the shape), `7`, `11` and `21` are the
[shared read exits](#the-shared-read-and-record-exits). `39` and `65` are
[the lanes root](#the-lanes-root).

## `lane open`

### Output

Boots one lane: creates `<root>/<key>/` and places the committed template the key selects as its
`workflow.json`, the coder template for an issue number and the chore template for a
`chore:<name>` key. The lane is placed at its initial state, not at a stage: walk it with
`lane transition`, which proves each event against the board before it records one.

**Class seeding.** For an issue, its `class:<name>` labels seed `machine.context.issue.classes`.
Without class labels, the template stays byte-identical. Unsupported class names refuse at `38`
before placement, with nothing written; correct the labels before retrying. A chore key reads no
issue labels.

**An existing lane dir** is refused loudly at `14` with nothing written. Resuming needs no boot, and
overwriting a machine mid-drive would corrupt a live fold.

**The epic check.** An ISSUE key first reads that issue's type, its native sub-issue links and its
parent edge. The coder template has one task, so an epic has no machine here and is refused at `46`
before anything is written. Both halves of "epic" are asked for, because they answer for different
moments: a planned epic carries children, and an epic nobody has planned yet carries none and is
known only by its `type:epic` label, which is the window the wrong-template lane was booted in. The
refusal names which case it is: an unplanned epic goes to `plan-epic` first, and a planned one is
booted with `fabrika lane emit <n>`. Epic wins the precedence, so a sub-epic still routes to
`lane emit`.

**The child check.** An epic's CHILD carries neither fact, and is refused at `48` instead: a child
gets no lane of its own. That refusal reads the parent lane's emitted task set before it speaks, so
it names one of three routes:

- drive the parent lane, when its machine holds the child's task;
- place the child in the parent epic's `## Dependencies` block and run `fabrika lane amend <parent>`
  first, when the machine provably holds no such task;
- say the task set is UNKNOWN, rather than asserting membership either way, when the parent lane is
  absent, unreadable or malformed, or the parent number itself did not read.

The parent edge rides the issue read already made, so the type and the two link facts cost one read
between them. A `chore:<name>` key drives no issue and is never asked.

**The prior-lane check.** An issue key whose lane directory is absent is then asked whether the
board already hangs a pull request off that issue, one only a driven lane opens. A hit is refused at
`63` with nothing written. A ledger is a lane's whole state and `.fabrika/` is gitignored, so
removing the directory and booting again would restore a spent repair budget and record no granted
round anywhere. The refusal names the pull request to drive, and the one door out of a spent budget:
a recorded round grant, `build clear` on the lane's PR or `lane clear` on a lane that has none. For
the prior ledger no clearance can produce, because it was written on another operator's machine, it
names `--from-board`. The check is asked only over an absent directory, so an existing lane still
answers `14` and a re-run reads as the resume it is. An unreadable answer is `11`, never "no prior
lane".

**`--from-board`** reaches that refusal and nothing else, and it reads the board rather than
trusting itself: exactly one pull request hangs off the issue, it is open, and every namespace its
head derives has answered on the same fold `lane prove` takes for a PASS. Anything short of that is
`63` again with its own reason: a standing FAIL (a repair is owed, and how many rounds the prior lane
spent is what nothing here can prove), a verdict that no longer binds the head, several pull
requests, or a merged or closed one. An unread board is `11`, never a seat. On admission the boot
does two things no ordinary boot does. It places the document with `maxRetries: 0`, so this lane
mints no repair budget the board did not prove, and a FAIL parks at `human:budget-spent` until
`lane clear` grants a round. And it records the adoption as a comment on the issue BEFORE anything
lands on disk, so a seat nobody can review is never taken.

So an issue key costs two board reads about the issue itself, its type and links and then the
prior-lane read, and the cap gate adds one claim-marker read per candidate lane it counts.

**The cap gate.** Last before the write, an issue key is counted against `laneConcurrencyCap` as the
repository that OWNS the cwd declares it. That is the same checkout the lanes root derives from, so a
linked worktree is capped by the primary checkout's `.fabrika.jsonc` and not by its own tracked
copy. A seat is held by an issue lane under this root that has not folded to done AND whose issue
carries a live `lane claim` marker, plus every lane no read can account for. An active lane nobody
claims is idle and holds nothing, and an archived one is already out of the count. There is no
override flag; raising the number in the config is how it changes.

### Exit status

- `8` — the write did not land, so the lane is NOT booted.
- `11` — the template, the lane dir's existence, or the issue's child list could not be read.
  UNKNOWN, never a boot.
- `14` — the lane already exists.
- `21` — the key is not a lane key.
- `38` — an unsupported class label; nothing written.
- `46` — the issue is an epic, typed `type:epic` or carrying sub-issue links, so this template is the
  wrong machine for it.
- `48` — the issue hangs under a parent, so it gets no lane of its own. The line names whether the
  parent lane holds its task, provably does not, or did not read, and routes accordingly.
- `51` — the lanes root already holds as many CLAIMED lanes as `.fabrika.jsonc`'s
  `laneConcurrencyCap` allows. The cap, the claimed count, every lane holding a seat and, separately,
  the number of idle unclaimed lanes are named, and nothing was written.
- `63` — the board says this issue already had a lane. Every pull request that proves it is named,
  and a re-boot would launder its spent repair budget, so nothing was written. Under `--from-board`
  the same code carries the board's own reason for not seating it.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane emit`

### Output

Generates a lane machine from the epic's board state. It reads the epic body's `## Dependencies`
topology, the shape `ledger topology` stages, and emits `<root>/<epic>/workflow.json`: one region
per child in the coder template's exact shape, phase-sequenced, parallel within a phase.

- Each child's `class:<name>` labels seed its `machine.context.<task>.classes`. Unsupported class
  names on any live child refuse at `38` before placement, even when the topology omits that child;
  correct the labels before retrying.
- A closed child boots its region in a final state (`completed` → `shipped`, any other close →
  `frozen`), so a partly-built epic's machine can still terminate.
- Deterministic: the same epic body bytes and the same child links (number, state, close reason and
  class labels per child) emit the same machine bytes.

stdout is `{answer: "emitted", epic, workflow, phases, children, dropped: {count, rows}, bytes}`.

**An existing lane** is refused at `14` with no exception: a lane on disk is never re-emitted over.
The refusal names the whole remedy: retire the lane directory, then re-run this verb. That remedy is
for a lane running the wrong MACHINE, which `fabrika lane migrate --check` is what says. A running
lane whose PLAN changed goes to `fabrika lane amend <n>` instead, which re-derives the machine over
the log it keeps rather than discarding every landed child's record with the directory.

**Machinery laps.** `machineryLaps.onEmit` picks which machine is written. Like the cap, it is read
from the `.fabrika.jsonc` of the repository that owns the cwd, so a linked worktree reads the primary
checkout's copy. `off`, the shipped default, emits today's bytes exactly. `on` adds the machinery LAP
arms and seeds each task's lap counter, so a machinery failure spends laps rather than the repair
budget, and a spent lap parks on `human:machinery-stall` rather than on the repair budget's own
`human:budget-spent`. The machine is fixed at emission, so flipping the key moves no lane already on
disk. An unreadable key is UNKNOWN at `11` with nothing written.

**`--children`** starts from the board's live sub-issue list. Every ref the topology names and that
list does not leaves its phase and every requires list naming it, a phase left with no members is
elided, and every ref that went is reported whole on stdout and stderr. It is the descope escape, and
opt-in because the same stale ref is a typo on the other reading. Every other topology defect
refuses exactly as it does without the flag.

**The cap gate** is `lane open`'s: an epic's lane holds a seat like any other while a driver claims
it.

### Exit status

- `4` — the topology was read in full and does not parse. The defective line, duplicate placement or
  unplaced requires subject is named. A defective line's refusal also teaches the placement:
  editorial or history prose belongs below a `---` thematic break, which ends the section.
- `7` — the epic is proven absent or closed.
- `8` — the write did not land.
- `11` — the epic, its child list or the lane dir could not be read. UNKNOWN.
- `14` — the lane already exists; retire its directory and re-run to rebuild it.
- `15` — no `## Dependencies` topology: plan the epic first. Under `--children`, every ref the
  topology placed was dropped, so it declares no child.
- `16` — the topology references a non-child, named. The refusal names both escapes: re-run with
  `--children`, or repair the body with `fabrika ledger retopology <epic>`. Unreachable under
  `--children`.
- `17` — the topology holds a cycle, path named. Checked over what survives `--children`.
- `38` — an unsupported class label on a live child.
- `51` — the lanes root already holds as many CLAIMED lanes as `laneConcurrencyCap` allows. The idle
  unclaimed count is named separately.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane amend`

### Output

Amends one RUNNING epic lane's task set. It re-reads the epic body's `## Dependencies` block and
re-derives the machine `lane emit` would emit from it today. Only where the lane's own recorded
history survives the change, it appends one `<EPIC_N>.AMENDED` line and writes the re-derived
`workflow.json`.

This is the verb for a plan that changed after emission: a child added to the topology, or a
not-started child re-sequenced into a later phase. Before it existed the only routes were retiring
the lane directory and re-emitting, which discards `events.jsonl` and every landed child's record
with it, or hand-driving the rest of the epic outside its own ledger.

- **The log is appended to and never rewritten.** No recorded line is edited, reordered or dropped.
  The amendment line moves no task and reaches no machine: the fold consumes it, exactly as it
  consumes `lane reconcile`'s CORRECTED. Its `tasks` payload names the set the re-derived machine
  holds, which is the whole audit of the change.
- A task new to the topology boots `queued` carrying no history. A task that has not started may
  move to any phase, later ones included.
- **It reconciles nothing.** The block is read exactly as it stands, and a block still naming a
  child the board closed is `fabrika plan restage`'s to repair, never this verb's to guess at.
- The lap axis is read off the lane's OWN machine and not off `.fabrika.jsonc`, so a repo that
  flipped `machineryLaps.onEmit` since the emission does not have that flip land as a side effect of
  adding a child.

**`--defer <task>` is the one route out of a mid-flight descope**, and the only way a task carrying
recorded history may be dropped; without it that drop still refuses at `61`. It requires
`--defer-reason`, and it names the plan change on the amendment line rather than dropping the task
silently. The appended line gains a `defers` payload carrying, per task, the id, the `at` of that
task's last recorded entry (the bound, derived off the log under the append lock, never typed), and
the reason. So the ledger goes on accounting for every entry the dropped task recorded, which is
what the `61` refusal was protecting. A later fold excuses exactly those bounded lines from the
unknown-task check, and refuses anything the bound does not cover, including a child quietly
reintroduced after the deferral.

Before it writes, the deferred child's own issue is read for a live `build-claim:` marker. A held
claim refuses at `64`, and an unreadable thread is UNKNOWN at `11`, never an absence. So a deferral
detaches no worker, kills nothing and discards no branch or worktree. It touches the CHILD ISSUE not
at all: `fabrika ledger defer <epic> --child <n>` is the board half, which unlinks it and leaves it
OPEN as the follow-up. `lane status` then prints the deferred rows, so deferred does not read as
completed, and `lane history` still prints the child's own events verbatim.

A topology that already derives the machine on disk answers `{answer: "current"}` with nothing
appended and nothing written. stdout on a change is
`{answer: "amended", lane, epic, workflow, tasks, added, dropped, deferred, phases, children, bytes}`.

Every refusal is proven BEFORE the append and before the machine write, so the lane is
byte-identical after it.

### Exit status

- `4` — the lane record on disk was read in full and is not the shape, or its log already does not
  replay through the machine it is running. This lane is not one to amend.
- `7` — no lane there, or the epic is proven absent or closed.
- `8` — the append or the machine write did not land. The stderr says which, and a recorded
  amendment whose machine write failed is completed by re-running this verb.
- `11` — the lane, the epic, its child list or the machine document could not be read. UNKNOWN,
  nothing written.
- `15` — no readable `## Dependencies` topology: there is nothing to amend to.
- `16` — the topology references a non-child, named.
- `17` — the topology holds a cycle, path named.
- `40` — another writer holds the lane's ledger lock. Retry once the holder clears.
- `60` — the new topology places no phase for a task this ledger records as LANDED, named with the
  final it landed in. The ledger is the only record that work landed, so put the child back in a
  phase or close the epic over what it built.
- `61` — a task carrying recorded history cannot replay to the leaf it stands on under the
  re-derived machine: it is dropped while mid-flight, or its log reaches a cell the new region does
  not hold. Each offending task is named; an authorized descope names it with `--defer` instead.
- `62` — the epic body's `## Dependencies` block was read in full and is not a topology: an
  unparseable line, a child placed in two phases, or a requires subject placed in none. The defect
  is the ISSUE BODY's, so `fabrika plan restage` is the repair and nothing on disk is at fault.
- `64` — a `--defer` does not describe this lane: the task is not in this machine, the new topology
  still places it, it carries no recorded history to defer, `--defer` and `--defer-reason` were not
  given together, or a live build claim on the child says a worker is still on it. Every one of
  those is repaired by changing the flag or the board, never by re-planning the epic.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane brief`

### Output

The spawn prompt for one task's current leaf state, folded fresh from the ledger, so a driver
pastes a brief rather than composing one. stdout is the `lane-brief` wire format. It carries:

- which lane, task, state and shell;
- this driver's lanes root, resolved absolute. The shell passes it back to `lane report` as
  `--root`, and a relative one would resolve against the shell's own worktree;
- the fabrika entrypoint resolved for this repo. It is repo-relative in a checkout of fabrika's own
  repo, so each worktree runs its own copy, and absolute for an installed one no worktree has a
  `node_modules` for;
- the resolved issue and PR URLs. They are URLs only: the spawned shell re-reads its own ground;
- the format's byte-fixed rules.

Hand the bytes to the spawn verbatim. A line appended under them is text the format's own reader
calls malformed.

On an epic lane a child's state resolves no PR at all and briefs the epic issue, the epic branch and
the range to judge. The tail task briefs the run's single PR under the same refusals. The tail's
`build`, the repair round its review's FAIL retries into, briefs that PR together with the assembly
branch `epic/<lane>` its head sits on, under a rules paragraph naming the lane driver as the one
shell that moves that branch.

Every brief standing on that assembly branch is also checked against it. The `fabrika:` entrypoint
is repo-relative in a checkout, so it resolves inside the shell's own worktree, and a branch cut
before a lane verb landed on the trunk hands that shell a copy of this CLI which cannot execute the
contract the brief states: the shell does the work, produces its verdict, and cannot record it. So
the branch's own tree is read for every lane verb the brief tells the shell to run (`lane report`
today), and a missing one refuses at `59` naming it and the remedy, `lane refresh`. An absolute
entrypoint is an installed copy the branch does not carry and is not judged.

### Exit status

- `4`, `7`, `13`, `21` — the [shared exits](#the-shared-read-and-record-exits).
- `11` — the lane, the issue, its PRs, this fabrika's own entrypoint, the assembly branch's tree or,
  on a child `review` state, this tree's branches could not be read. UNKNOWN. A shallow clone whose
  graft boundary is the assembly tip or the child's fork point seats here too, since every ancestry
  answer over it is wrong; the stderr names `git fetch --deepen=25`.
- `18` — the leaf state routes to no shell: `queued`, `blocked`, `human:*`, a final.
- `19` — neither the task nor the lane names an issue, or that issue is proven absent.
- `20` — zero open PRs where the state needs one, the tail's repair round included, or several where
  one is required.
- `22`, `25` — a child `review` state's range, on the seats `lane prove` already spends on the same
  two facts: no local branch in this tree carries the child's commits (`22`), or several do (`25`).
- `59` — the assembly branch does not carry a lane verb this brief tells the shell to run. Refresh
  the branch, then brief again.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane dispatch`

### Output

The dispatch contract lives in
[Codex dispatch](../../../../packages/fabrika-cli/docs/codex-dispatch.md): the inputs, the
`assemblyRefresh.onDispatch` refresh an epic child gets before its brief, the order of the worktree,
reconciler and `codex exec` steps, what counts as success, and the retained worktrees and logs.

In short: it creates a dedicated detached git worktree and runs `codex exec` with a fixed skill
preload envelope and the emitted lane brief unchanged. It preserves Codex model and policy
configuration. Process exit zero alone is not completion: a new task terminal and fresh artifact
proof are required. stdout is `{harness, task, event, worktree}`, and worktrees are retained.

### Exit status

- `11` — a missing input, isolation, process or state failure; also a repository identity the
  refresh gate cannot read.
- `18` — an unsupported harness or an inactive state.
- `22` — no unique new terminal.
- `42` — the pre-dispatch refresh met a conflict. The branch is proven back at its pre-merge head and
  no worktree is created. Record the park the refusal names (`--cause assembly-conflict`) rather
  than dispatching over the unrefreshed branch.
- `39` — the lanes-root resolution ahead of every read, which refuses on either of its two arms:
  `--root` absent and no repository derivable off the cwd, or a present `--root` that is relative
  and a cwd that itself holds neither `.fabrika` nor `.git`. `65` is
  [the lanes root](#the-lanes-root).
- `lane refresh`, `lane brief` and `lane prove` refusals pass through on their own codes, including
  `lane brief`'s `59`.

## `lane assembly`

### Output

Places the working tree an epic run assembles in: `epic/<n>` checked out at
`.claude/worktrees/epic-<n>`, both derived from the epic number and never taken from the caller.
stdout is the tree's absolute path. The invoking checkout is NEVER switched.

It is idempotent in both directions:

- a worktree already holding the branch is resumed and its path answered with nothing written;
- a branch that outlived its worktree, the state `--remove` at a terminal leaves behind, is checked
  out again as it stands, never re-cut off a fresh base;
- a worktree whose directory is gone but whose record git still carries (`prunable`) is that same
  state: the registration is cleared and the branch placed again, never answered as a live path.

**Every resume fetches first** and asks one question of the branch it found: does `origin/HEAD`
already carry its content. A multi-phase epic that shipped an intermediate tail lands in exactly
that state. The branch holds nothing the trunk lacks and conflicts with everything the trunk took
since, and until this read the verb could not tell it from an ordinary unlanded resume.

The read is squash-aware because this trunk is. Ancestry is the fast path, and a branch it calls
unlanded is settled by cumulative patch id: the branch's own net diff against the trunk, matched
against the patches the trunk took since their merge base, limited to the paths the branch touches
(200 commits back). A match means it landed as a squash, and a branch that adds nothing to the
trunk at all counts the same.

A contained branch is re-cut off `origin/HEAD` in one `worktree add --no-track -B`, and the note
says it re-cut and which of the three proofs opened it. Its seat, if it still has one, is dropped
first WITHOUT `--force`, so git refusing to drop uncommitted work is what keeps unlanded bytes out
of a re-cut. Containment is the whole warrant: a branch that is not contained, including one whose
squash carried a conflict resolution so its patch does not match, resumes exactly as before. No
board is read: whether the tail PR merged is never asked.

`--remove` is the lane's terminal step. It fetches nothing and never forces: a dirty assembly tree
is unlanded work, so git's refusal is the answer.

Every mode reads the outcome back off `git worktree list` before answering.

### Exit status

- `4`, `7` — the [shared read exits](#the-shared-read-and-record-exits). On `7`, emit the run's
  machine first.
- `8` — the placement or removal ran and did not read back, or a contained branch's seat would not
  drop. UNKNOWN.
- `11` — the working trees, the branches, the fetch, `origin/HEAD` or the containment read could not
  be read: a failed fetch, an `origin/HEAD` naming no commit, a diff or patch read that failed.
  Nothing was placed or removed, and the containment answer is never resolved either way.
- `33` — `epic/<n>` is checked out in the main working tree. Switch that tree off it first.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane assembly-pr`

### Output

Derives one piece of the prose an epic run's single assembly PR opens with, and prints it bare on
stdout so the `gh pr create` fence interpolates a value instead of deriving one. It opens, edits and
reads back no pull request.

- `--field title` prints `feat(epic): <the epic issue's own title>`. The conventional type is
  `build/pr-title.ts`'s map, reused rather than re-derived, because release-please classifies the
  squash subject and that rule lives in exactly one place. This verb only stamps the `(epic)` scope
  over it.
- `--field about` prints the `## About this epic` section derived from the epic's `## Pitch`
  **Problem** paragraph, read through the same section reader `guard pitch-guard check` uses.

That text is never passed through raw:

- a closing keyword is swapped for a word GitHub's documented keyword list does not carry, and the
  `#<n>` it aimed at is left as written;
- the paragraph is cut to its opening sentences under a word budget, so a triage-length Problem does
  not land as the section, with `[…]` marking what was left behind;
- what is lifted lands as a block quote in the epic's own words. That is the shape `build pr`'s body
  guard already reads as reproduced rather than asserted, so a Problem naming `type:epic`, a
  priority or control-plane keeps its sentence intact instead of being reworded into something that
  only looks safe.

The result is then re-read through `build pr`'s own body predicates, so a section this verb answers
cannot be one that guard refuses. An epic with no `## Pitch`, or a pitch with no Problem paragraph,
is an ANSWER and not a refusal: empty stdout with the reason on stderr, so the run still publishes
its PR with no section rather than being stranded over prose.

### Exit status

- `1` — `--field` is not `title` or `about`, or the target repo could not be resolved.
- `7` — the epic is proven absent or closed.
- `11` — the epic could not be read. UNKNOWN, never a derived title.
- `56` — the issue carries no `type:epic`, so an assembly PR's prose is not its to give.
- `57` — the derived section still carries a stray closing keyword or a classification claim after
  neutralisation. Reword the epic's Problem paragraph, or write the section by hand; `--field title`
  is unaffected.

## `lane assembly-body`

### Output

Guards the epic run's single assembly PR body on its way to `gh pr create`. It reads the body from
stdin and relays it unchanged on stdout when it closes the epic: the same bytes, plus a trailing
newline when the body lacked one. It opens, edits and reads back no pull request.

An epic run is one branch and one PR, so that PR is the run's whole landing. A tail body reaching
the epic through `Part of #<epic>`, or closing only its landed children, merges without closing it.
The lane then folds to `shipped` and then `complete` over an epic the board still calls open, and an
operator re-dispatched on it parks on `LANE-TERMINAL` with no door out.

The link reader is `issueRefsOf`, the very one `lane/closure.ts` judges the merged PR with, so this
guard refuses exactly the bodies that reader would later call partial or leave unreadable, and the
two cannot disagree about one body. The tail's other closing keywords, one per landed child by
contract, are not judged. What is required is a closing keyword whose target is the epic itself,
tested by membership rather than by first match, because a scalar reader would answer off whichever
child leads.

It reads no board and takes no `--repo`. The number's epic-ness was established one command earlier
in the same fence by `lane assembly-pr`'s `56`, and a second network read would only add an UNKNOWN
to a judgement the bytes on stdin fully decide.

### Exit status

- `1` — stdin could not be read. The body is UNKNOWN, never empty.
- `3` — stdin was read and held nothing.
- `5` — the body carries a machine-local path. Redact before opening.
- `6` — the body is a bare `@` path reference. Write the body, not a pointer to it.
- `58` — no closing keyword aims at the epic; stderr names what the body reaches it by instead.
  Write `Fixes #<epic>`, or leave the run's PR unopened.

## `lane integrate`

### Output

Merges one reviewed child's branch into the epic run's assembly worktree, `epic/<n>` at the path
`lane assembly` placed, both derived from the epic number and never taken from the caller. It proves
the merged tree holds together before the branch keeps it.

The order is the verb:

1. `git merge --no-ff`;
2. the repo's declared `dependencyReconciler` (for example `pnpm install --frozen-lockfile`), run IN
   that worktree so the install reads the lockfile the merge just brought;
3. the repo's declared `codeValidators` over the merged tree.

It reconciles after the merge, never before, since an assembly worktree placed before a child
existed still holds the pre-merge install. Every refusal below the merge resets the assembly branch
to `ORIG_HEAD` and reads its head back, so a recorded FAIL names a branch that never carried the bad
merge. Nothing is ever pushed here: that is `lane push`, and recording the DONE is the driver's.

**A textual collision is not always the end of the run.** Under `assemblyReplay.onCollision`
(shipped `off`), the child's commits are replayed onto the tip:

- hunks that are a plain keep-both, both sides adding lines where the base had none, are kept both
  ways;
- a pick whose every unmerged path is a lockfile named in
  `assemblyReplay.lockfileRegenerator.lockfiles` and marked `merge=binary` in `.gitattributes` is
  regenerated by that declared command and staged;
- the child's own branch is moved onto the replayed range, and that range is merged `--no-ff` like
  any other landing;
- a hunk that is not a plain keep-both resets through the captured head, proves the reset, and names
  `--cause replay-conflict` as the park to record.

With the key off, `42` is byte-identical to what it always was.

On exit `0` the last stdout line is `INTEGRATE-VERDICT: MERGED`, or `INTEGRATE-VERDICT: REPLAYED`
after a replay. The line above it is the merged head either way. Above that a replay prints its
machinery event, `{event, child, replay, onto, range, resolved, regenerated, commits, reReview,
budget}`. Its `range` is the moved range the child owes one review round over, and its `budget`
reads `unspent`, because a replay is machinery working rather than the child failing.

### Exit status

- `4`, `7` — the [shared read exits](#the-shared-read-and-record-exits). On `7`, emit the run's
  machine first.
- `8` — a restore or a head read-back did not land. UNKNOWN, so nothing may be recorded.
- `11` — the working trees, the branches, the head, `.fabrika.jsonc` or a validator could not be
  read, or the repo declares no `codeValidators`. UNKNOWN, never green.
- `22` — no branch by that name. Take it off `lane prove`'s evidence.
- `33` — `epic/<n>` is checked out in the main working tree.
- `41` — no working tree holds `epic/<n>`. Place it with `lane assembly`.
- `42` — the child conflicts and was not replayed: the merge was aborted and nothing was installed.
  Or the replay hit a hunk that is not a plain keep-both, or a lockfile regenerator that failed,
  could not start, or wrote beyond the lockfiles, and the branch was reset and proved back.
- `43` — the merged lockfile does not install, the reconciler could not be run, or it changed a
  tracked file.
- `44` — the merged tree failed a code validator: the semantic collision.
- `45` — the assembly worktree already held modified tracked files before the merge, so nothing was
  merged, installed or validated. That dirt is the driver's tree and not the child's range; clean the
  seat and integrate again.
- `54` — the replay landed and the child's branch would not follow it onto the replayed range,
  usually because a working tree still stands on that branch. Nothing was merged and the seat is
  back, so free the branch with `fabrika build retire` or park on `--cause worktree-holds-branch`.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane refresh`

### Output

Merges the trunk into the epic run's assembly worktree, `epic/<n>` at the path `lane assembly`
placed, both derived from the epic number and never taken from the caller, so the tail's review
binds to a head the merge queue can take.

Nothing else in this package touches trunk after the first cut. `lane assembly` cuts off
`origin/HEAD` once, and a resume fetches only to judge whether the branch is already landed, merging
nothing. So the branch drifts behind trunk with nothing to notice, and `lane push` names "fetch and
re-merge" as the remedy for its `29` without any verb performing it.

The order is the verb: refuse a dirty seat, `git fetch origin`, resolve `--base` to a commit, answer
CURRENT when the branch already carries it, else `git merge --no-ff` and re-read HEAD. A clean merge
is silent and parks nothing. A conflict aborts, resets through `ORIG_HEAD` and PROVES the reset by
re-reading HEAD, and the refusal names `--cause assembly-conflict` as the park to record. A reset
that will not take is `8`, never the clean conflict refusal.

Two callers reach the verb automatically, and each is gated by its own `assemblyRefresh` arm. Both
ship `off`, and both arms are read from the `.fabrika.jsonc` of the repository that owns the cwd,
never the cwd's own copy.

- `--on-review`, typed by the driver on the tail's way into review, is gated by `onReview`.
- The pre-dispatch call `lane dispatch` makes itself, before it cuts a child's worktree off the
  branch, is gated by `onDispatch`. It is never typed.

A hand call omits `--on-review` and is never gated. Nothing is pushed and no lane log is written:
publishing the refreshed head is `lane push`'s, and recording the park is the driver's.

On exit `0` the last stdout line is `REFRESH-VERDICT: MERGED`, `REFRESH-VERDICT: CURRENT`, or
`REFRESH-VERDICT: DECLINED` under a gated automatic call whose arm reads `off`. The line above it is
the head. A DECLINED prints no head, because nothing was read.

### Exit status

- `4`, `7` — the [shared read exits](#the-shared-read-and-record-exits). On `7`, emit the run's
  machine first.
- `8` — the restore or a head read-back did not land, or the merge reported success and the head did
  not move. UNKNOWN, so nothing may be recorded.
- `11` — the working trees, the head, the seat's cleanliness or the fetch could not be read.
  UNKNOWN, never green.
- `21` — `assemblyRefresh` is malformed in `.fabrika.jsonc`, so whether this repo refreshes its
  assembly branch is UNKNOWN.
- `22` — `--base` names no commit after the fetch.
- `33` — `epic/<n>` is checked out in the main working tree.
- `41` — no working tree holds `epic/<n>`. Place it with `lane assembly`.
- `42` — the trunk conflicts with the assembly branch. The merge was aborted and the branch was
  proven back at its pre-merge head.
- `45` — the assembly worktree already held modified tracked files, so nothing was fetched or
  merged. Clean the seat and refresh again.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane push`

### Output

Publishes the assembly branch of one epic run, `epic/<n>`, derived from the epic number and never
taken from the caller, and INDEPENDENTLY confirms the remote ref moved by reading it back with
`git ls-remote`.

It is the sanctioned push for the one branch no spawned shell owns. `build push` refuses that
branch, because the branch carries no build claim's nonce. The whole report is stdout, single-stream,
so the last stdout line on exit `0` is always `PUSH-VERDICT: MOVED`. No force flag exists: the
assembly branch only ever grows, one merge per landed child.

### Exit status

- `4`, `7` — the [shared read exits](#the-shared-read-and-record-exits). On `7`, emit the run's
  machine first.
- `8` — pushed, but the remote ref could not be re-read. The outcome is UNKNOWN.
- `11` — the lane, HEAD, the remote ref or containment could not be read. Nothing was pushed.
- `26` — the tree is not on the assembly branch, or HEAD is detached.
- `29` — the push would drop commits the remote holds. Fetch and merge, never rewrite;
  `lane refresh` is the verb that does it.
- `30` — proven: the remote ref did not move.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane retrigger`

### Output

Schedules a fresh CI run on every OPEN pull request based on an epic run's assembly branch,
`epic/<n>`, derived from the epic number and never taken from the caller, after `lane push` moved
that branch.

GitHub recomputes `refs/pull/<n>/merge` when a base moves, but emits no `pull_request` event for a
base push (the event fires on opened, synchronize and reopened). So nothing schedules a run, and
every child keeps reporting checks over the tree its base had before the push. A workflow re-run
cannot serve: it replays the original event's `GITHUB_SHA` and `GITHUB_REF`, which is the stale
merge commit. Close/reopen is forbidden, because it tears the pull request's preview stage down
mid-deploy.

So the head is moved instead, through GitHub's own `PUT /pulls/{n}/update-branch`, which merges the
base into the head branch and is a synchronize. A run is scheduled against a merge ref computed now;
nothing is closed, nothing is force-pushed and no commit is rewritten.

- It is idempotent by construction. A child whose head already contains the base tip is read,
  reported `current` and never written to, so a second call right after a first writes nothing.
- The staleness read is the platform's own comparison against the base as it stands, never the pull
  request's frozen `base.sha`.
- Each write carries `expected_head_sha`, so it is refused rather than misaddressed when a sibling
  moved the head first.
- Nothing is pushed, no working tree is touched and no lane log is written.

On exit `0` the last stdout line is `RETRIGGER-VERDICT: RETRIGGERED`, `RETRIGGER-VERDICT: CURRENT`
(children exist and all already carried the base) or `RETRIGGER-VERDICT: NONE` (no open pull request
is based on the branch). The lines above it are one row per child: `#<pr> current`, or
`#<pr> <commits behind> behind, <head before> -> <head after>`.

### Exit status

- `8` — an update was accepted and the head did not move inside its 60s window, or a read failed
  after this sweep had already moved a child's head. A merge may still be in flight, so re-read
  before writing again.
- `11` — the pull request list or a comparison could not be read and this sweep had written to no
  child. UNKNOWN over an untouched sweep, never an empty one.
- `42` — the assembly branch does not merge into one or more of the head branches, so those children
  need a repair round before their checks can run at all.

## `lane stale`

### Output

Sweeps every lane on disk and answers which ones nothing is driving. A lane's ledger records state,
not liveness, so a shell that dies leaves the lane reading active forever. The age here comes off the
`at` every event line already carries; nothing new is stored.

How long a lane may be silent is its OWN horizon, not one number for the pipeline. Each lane is
judged against the budget of the work driving it: a build shell's, a review shell's, a ship shell's,
or the dispatch budget for a task nothing has picked up. Every row reports the `budgetMinutes` it was
judged against. `--older-than` overrides that for every lane; without it, `olderThanMinutes` in the
answer is `null`, which says the budgets did the judging.

stdout is `{now, olderThanMinutes, scanned, summary, lanes}`, oldest silence first. Each lane carries
its folded `stateValue`, its last event's timestamp, its age in minutes, the budget it was judged
against and one verdict:

- `stale` — non-terminal, unparked and silent past the threshold;
- `moving`;
- `parked` — blocked or a `human:*` hold. A park is meant to sit;
- `terminal`;
- `unstarted` — a lane with no events at all, so no age to judge;
- `unreadable` — the lane is there and its record is not readable. It is reported, never dropped.

Both default roots are swept unless `--root` names one. An absent root holds no lanes and is not a
fault, and zero lanes is an empty answer at exit `0`. Stale lanes exit `0` too: this reports, it
never resumes. Without `--claims` the whole sweep runs off disk and makes no network call.

**`--claims`** additionally reads the board and pairs each NON-TERMINAL lane with the claim standing
on its issue. That is the other half a session limit strands: the dead builder's claim marker
outlives it, and the lane log cannot see that. Each paired row then carries
`claims: {"state":"held",token,session,author,commentId} | {"state":"unclaimed"} |
{"state":"unknown",reason}`. A board read that failed is `unknown`, never `unclaimed`. The answer
carries a top-level `claims` summary, `null` when the board was never asked. Chore lanes drive no
issue and are not paired.

Nothing here clears a claim. A stranded BUILD claim leaves through `fabrika build adopt` then
`fabrika build release`. The LANE claim a killed operator seat strands on the same issue, which this
sweep does not read, leaves through `fabrika lane adopt` then `fabrika lane release`.
`fabrika build claimants <n>` reads one issue's build claims the same way.

### Exit status

- `1` — `--older-than` is not a non-negative number of minutes.
- `11` — a root is there and could not be listed. The lane set is UNKNOWN, never a short list.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane seats`

### Output

How many seats the lanes root is holding against `laneConcurrencyCap`, read WITHOUT booting
anything. It is the one lane verb an operator may run before it claims a lane. It creates no lane
directory, posts no claim marker and appends no log line, so running it when the cap is full costs
nothing and leaves nothing to release. `lane open` is where a boot is asked for and refused at `51`.

The count is `lane open`'s own, unchanged. A seat is an issue lane under this root whose log folds to
active AND whose issue carries a live `lane claim` marker, plus every lane no read can account for: a
record that will not load, a log that will not replay, or a claim the board would not answer for. An
active lane nobody claims is IDLE and holds nothing; it is reported separately, never counted. An
archived lane is under a sibling root and is already out of the count, and a chore lane is counted
by nobody.

stdout is `{answer, root, cap, held, retryAfter, free, claimed, unaccountable, idle}`. `answer` is
one of:

- `full` — `held` is at or past the cap, so a boot would take `51`. An operator reading this before
  `lane claim` ends LANE-WAITING instead of spending a claim, no sooner than the `retryAfter`
  instant: one pass of a driver's own loop past now, since nothing on disk says when another lane
  will reach a terminal.
- `free` — a seat is available.
- `uncapped` — the config declares no cap, so nothing bounds this root and `free` is `null`.

`laneConcurrencyCap` is read from the `.fabrika.jsonc` of the repository that OWNS the cwd, the same
checkout the lanes root derives from. So a linked worktree is counted against the primary checkout's
declaration and not its own tracked copy. There is no override flag: raising the number in the
config is how it changes.

### Exit status

- `11` — the cap could not be read, or the root is there and could not be listed. How full it is is
  UNKNOWN, never zero and never free.
- `39`, `65` — [the lanes root](#the-lanes-root). `39` is never a boot.

## `lane migrate`

### Output

Brings each booted lane's `workflow.json` up to the committed template its root selects, but only
where the swap provably moves nothing. `lane open` places a byte-identical copy at boot and refuses
to overwrite one afterwards, so a template edit reaches lanes booted after it and no lane already on
disk. That is safe until a token→event map in code changes with it, at which point every booted lane
is asked for a cell its frozen machine does not have.

Two things are kept:

- the lane's own `machine.context`, which is per-lane DATA (the task's `maxRetries`, and whatever
  else a lane declares) and would be erased by a verbatim copy;
- any lane whose machine was GENERATED rather than booted. An emitted epic document has no committed
  template to be brought up to, and is reported, never touched.

State is the event log replayed from scratch with no snapshot, so the swap is safe exactly when the
existing `events.jsonl` folds to the same per-task leaf state through both machines. Anything else
is a rewritten history, not a migration.

Each lane carries one verdict:

- `current` — already the machine this verb would write, read past formatting;
- `migrated` — judged safe and written;
- `stale` — judged safe, `--check` withheld the write;
- `generated` — not booted from this template;
- `mismatched` — the machine is not the one this lane's issue calls for, never written;
- `duplicate` — this lane drives an epic's CHILD, whose parent's lane already owns the work: a
  second ledger booted before `lane open` refused one. Reported, never written, never migrated;
- `unsafe` — the log will not replay through one of the two machines, or it folds to a different
  state. Named, never written;
- `unreadable`.

stdout is `{check, scanned, summary, lanes}`.

**The shape judgement.** Staleness was the only wrongness this sweep could see, and a coder-template
lane booted on an epic grafts cleanly and read `current`. So each ISSUE-keyed lane is additionally
judged against its issue's type and its native sub-issue links, and every judged row carries
`shape: {"state":"matches"} | {"state":"mismatched",reason} | {"state":"duplicate",parent,reason} |
{"state":"unknown",reason}`. A board read that failed is `unknown`, never `matches`, and a booted
child lane is `duplicate`, never `matches`. That read is the verb's only network call, one per
issue-keyed lane; chore lanes drive no issue and are not judged. A mismatched lane is skipped ahead
of every migration verdict and the sweep exits `46`. A duplicate lane is skipped the same way and
moves NO exit code: a stray ledger is a report, and retiring its directory is an operator's act this
verb never takes. Where unsafe lanes are present too, `37` wins as the more dangerous class.

**Roots.** Both default roots are swept unless `--root` names one. A named root is read as a
relocated root whose lanes may have booted from either committed template: the lane's own machine
id picks, never the root's position. An absent root holds no lanes and is not a fault.

**A lane key narrows.** An optional lane key narrows the sweep to that one lane and changes nothing
else: every other entry under the swept roots is neither read, judged nor written. That is what lets
a driver holding one lane discharge the write its own lane needs without touching the lanes other
drivers are mid-drive on. The key is matched as this verb renders it, so a chore root's entry is
addressed `chore:<name>` and an issue lane by its directory name. Unaddressed, the whole-root sweep
is exactly what it has always been: the release-time shape, and still the default. `--check`
composes with a key: judge that lane, write nothing.

### Exit status

- `7` — a lane key was given and no lane under the swept roots carries it. Nothing was judged and
  nothing was written; a key matching nothing is never a sweep of zero reported as clean.
- `11` — a template could not be read, or a root is there and could not be listed. The lane set is
  UNKNOWN, never empty.
- `37` — at least one lane cannot take the template without moving. Those lanes are named on stderr
  and none of them was written, and so are the ones that were.
- `46` — at least one lane runs a machine its issue does not call for. An epic's lane is rebuilt by
  retiring its directory and re-running `fabrika lane emit <n>`.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane reconcile`

### Output

Sweeps every lane on disk, answers which ones recorded a merge closure the board disagrees with,
then appends the line that corrects it. The machine sends a merged `Part of #N` back to `queued`
instead of folding the lane to a terminal, but the routing fact rides the recorded event as a
`partial` payload. So every lane shipped before that field existed replays through the guard's
fallthrough and still folds to `complete` over an open, buildable issue.

The log is append-only and no recorded line is ever rewritten. The repair is a `<TASK>.CORRECTED`
line naming the earlier line's own `at` and carrying the payload it should have had, which the fold
resolves before any message reaches the machine.

**Nomination is offline.** A lane is nominated by the latest recorded event that reached a
`merge:partial` cell carrying no answer its reader can trust, located off the compiled machine. So a
region declaring no partial arm (an epic tail) nominates nothing, and only a nominated lane costs a
board read. Two lines qualify:

- one that recorded no `partial` at all;
- one whose `partial: false` names no `landed` evidence. That is the mark of the nominator blind to a
  merged `Part of #N`, which wrote every `false` before the fix that read closures off the named PR.

It is the evidence that tells the two apart and never the line's timestamp, since a cutoff date would
hold only while that fix's own merge beat it. The second kind is re-read at most once: the correction
this sweep appends is what settles the line, never the polarity it lands on.

**Budget.** Budget ONE read per never-confirmed lane, not hundreds per sweep. Whichever way the board
answers, the answer is appended as a correction: `partial: true` on a merge that left its issue open,
`partial: false` on one that closed it. So the line carries its own answer and never nominates again,
and the ship stage now records `false` too. The first pass over a backlog shipped before that field
existed is still hundreds (228 of one repo's 298 guard-declaring lanes when it was counted, and a run
has exhausted a rate limit part-way through), but it is paid once. Every pass after it costs only the
lanes shipped since, and a rate-limited run leaves every lane it did confirm confirmed, so re-running
resumes rather than restarts. `--check` withholds the append, so it buys nothing for the next sweep
and pays the same reads twice.

That read is ONE pull request. The line being corrected already names the merge it stands on, and it
is read directly rather than nominated, because a MERGED `Part of #N` is invisible to both nomination
reads: the closing edge is built from closing keywords, and the search half is `is:open`. The union
finds nothing for exactly the case this verb catches. A line naming no PR falls back to the nominator
at open-or-merged.

Each lane carries one verdict:

- `current` — no recorded event reached the guard without its answer;
- `misrouted` — the board proves the merge partial, `--check` withheld the append;
- `corrected` — judged partial and appended, which sends the lane round again;
- `closes` — the board proves the merge closed the issue, `--check` withheld the append;
- `confirmed` — judged closing and appended. The lane still folds to complete, and the line now says
  so, so the next sweep skips it;
- `unmigrated` — this lane's own machine declares no merge-closure guard and the committed template
  it booted from does, so nothing here can judge its merge. Run `fabrika lane migrate` and re-run
  this sweep. An emitted epic machine and an epic tail declare none by design and read `current`;
- `unknown` — the board did not answer, it answered and named no merged PR linking the issue, or the
  lane drives no issue. A read that proves no closure is never read as `closes`;
- `unreadable` — the lane record or its log could not be read, or the log does not replay. A row,
  since nothing here caused it and nothing here can fix it;
- `unappended` — this run tried to append and could not.

Every judged row carries `corrects: {task, at, state, pr}` and the from/to stateValue the correction
moves the lane between, equal on a closing read, which is the row saying it moved no task. A
misrouted or corrected row also carries the merged `prs` proving the merge partial, and a closes or
confirmed row the board's own `why` instead. stdout is `{check, scanned, summary, lanes}`.

Both default roots are swept unless `--root` names one, which is read as a relocated root whose lanes
may have booted from either committed template. An absent root holds no lanes and is not a fault.

### Exit status

- `8` — at least one append this run tried did not land, so whether that lane still needs a
  correction is UNKNOWN. Those lanes are named on stderr, and so are the ones that were corrected.
- `11` — a committed template could not be read, or a root is there and could not be listed. The lane
  set is UNKNOWN, never empty.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane recover`

### Output

Sweeps every lane on disk and records the event its own artifact already proves but its ledger never
learned. A shell posts its SHA-bound verdict on the artifact and then records the event. Killed
between the two, it leaves the verdict standing and the ledger silent, and the lane sits non-terminal
until a driver happens to run `lane prove` by hand: one lane sat in review for 448 minutes carrying
a proven PASS on its PR.

Each non-terminal lane's active tasks are read off the fold, and a task standing in a leaf that OWES
a provable event is asked about: PASS out of `review`, PASS out of `review:ui`. Those are the arms of
`lane prove`'s claim table whose artifact only a FINISHED shell can have produced. Two arms are left
out, for one reason: a shell that is merely still working satisfies each of them.

- The BLOCKED a reviewer's park claims is negative ("the run reached no verdict"), proven by the
  absence of a contradiction rather than by an artifact anyone posted. A sweep standing on it would
  park every lane whose reviewer is still running.
- The DONE out of `build` or `build:ui` claims OpenPull, which proves on the existence of one open PR
  linking the issue: a fact about the PR being open, never about the builder being done with it. A
  lane in a repair round carries exactly that PR for the whole round, so a sweep standing on it would
  move the lane to review under the live builder.

It introduces NO proof path and NO second way onto a log. The bar is `lane prove`'s read, unchanged,
and the append is `lane transition`'s whole path: the same machine validation, the same proof gate
and the same ledger lock. What moves is only who runs them. It records on the literal `proven` and on
nothing else. `not-required`, `uncontradicted` and every refusal code leave the lane byte-identical
and land as their own row, so an unreadable board is a row to re-run rather than a lane moved on a
read nobody made.

**`--spawns` parks rather than finishes.** A lane standing in `build` or `build:ui` whose build claim
has outlived the builder's own budget, with NO lane branch in this clone and NOTHING on the surface
that lane's role publishes to, is a lane whose shell is gone and which will never move again. Lane
7778 held a seat against the concurrency cap for five days because recording its
`BLOCKED --cause spawn-dead` was a driver's act and its driver was gone.

- The publication surface is the role's and not the leaf's. A single lane and an epic tail publish an
  open PR whose body links the issue. An epic child publishes onto its own lane branch and opens no
  PR at all, so on a child the branch read IS that conjunct and no board read is made.
- That whole conjunction is the predicate, read through the same `build/dead-claim.ts` budget
  proof the spawn-dead unpark row reads. Every answer short of it is a `working` row that changed
  nothing: a claim inside its budget (the live-but-quiet builder), a branch still carrying the dead
  builder's commits, an open PR, or no claim at all.
- A read that did not settle, an unreadable board or several open PRs linking the issue, is
  `unreadable` and never dead. Its reason names the read that did not settle rather than one nobody
  made.
- It retracts nothing HERE, and it is not the end of the chain. The park it records is exactly the
  pair `recipe/parks.ts` keys its spawn-clear clearance on, so `recipe unpark` retracts the claim on
  the same age proof one verb later with no human between the two. The authorizing ruling is cited by
  the `@ruling` tag in `packages/fabrika-cli/src/lane/recover-verb.ts`.
- Its rows are `parked` (appended) and `parkable` (`--check` withheld it). It is OFF unless the flag
  is passed, because it spends a board read per lane standing in build.

**Budget.** Budget a recoverable lane at TWO board reads: this sweep asks what the proof says, and
`lane transition` asks again under its own gate before appending, which is that gate declining to
take this sweep's word for it. Every other judged task costs one. `--check` pays the first read alone
and appends nothing.

Each row carries one verdict:

- `recovered` — proven and appended. Its `to` is the append's OWN answer, which `lane transition`
  derives under the ledger lock from a fresh re-read of the log, so a writer that landed after this
  sweep's unlocked fold is accounted for. Every other row's `to` is the offline preview, which is all
  a move that never happened has;
- `recoverable` — proven, `--check` withheld the append, so its from/to is that preview;
- `unproven` — the proof did not answer `proven`. The row carries its `proof` label and `proofCode`,
  so a not-required is told from an unreadable board without re-reading anything;
- `refused` — the artifact proves the event and the append path refused it (this lane's own machine,
  or its config), so a re-run buys nothing;
- `contended` — `40`: another writer held this lane's ledger lock for the whole wait budget, so
  nothing was validated and nothing appended. The same event is still the right one and the sweep
  says so on stderr, which is why this is not bucketed with `refused`;
- `current` — the lane is non-terminal and no active task stands in a leaf that owes a provable
  event;
- `terminal` — the fold is done, so nothing is owed and no board read is spent;
- `unreadable` — the lane record or its log could not be read, or the log does not replay. A row,
  since nothing here caused it and nothing here can fix it;
- `unappended` — this run tried to append and could not.

stdout is `{check, scanned, summary, lanes}`. Both default roots are swept unless `--root` names one;
an absent root holds no lanes and is not a fault. Every root is LISTED before any lane is appended
to, so an unlistable second root refuses a run that has written nothing rather than discarding the
rows of a first root it already recovered.

### Exit status

- `8` — at least one append this run tried did not land, so whether that lane is still missing its
  event is UNKNOWN. Those lanes are named on stderr, and so are the ones that were recovered.
- `11` — a root is there and could not be listed. The lane set is UNKNOWN, never empty, and nothing
  was appended.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane archive`

### Output

Moves one lane directory from the lanes root to the archived root, so the sweeps stop reporting a
lane they can never judge. `lane reconcile` reads such a lane `unreadable` and `lane migrate`
`unsafe` on every run, forever. The fault is an event the machine has no cell for, and neither verb
may rewrite an append-only log to fix it: sealing writes a line for something that did not happen,
and widening `frozen` lets a lane at its retry cap ship with no unblock. So the record moves aside
instead, and nothing in it is touched.

**One gate decides the move.** The log must fail to replay under the same judgement `lane migrate`
makes: through the lane's own machine or through the committed template, and through the lane's own
machine alone when that machine was generated by `lane emit` and binds no template. A replaying log
is refused with the directory where it was, so a genuinely broken lane still shows up on every sweep.

The issue does NOT have to be closed. A bricked ledger whose issue is open had no route out at all:
repair needs the replay that is broken, `lane settle` needs a board closure, and the closed-issue gate
refused the archive. So its `laneConcurrencyCap` seat stayed held, and the only remedy left was
hand-deleting an append-only log. A log no machine can fold is a lane nobody can drive, whatever the
issue says, which is the whole thing that gate was protecting.

**The claim goes with the lane.** A live `lane-claim` marker on the issue is RETRACTED before the
move, so the issue does not read as held by a lane that is no longer there. A claim this caller does
not name refuses at `31` rather than being swept out from under its driver; `--token` names it. A
dead seat is taken back through succession, `fabrika lane adopt <lane> --session <dead> --reason
"<why>"` then `fabrika lane release <lane> --token <the token adopt printed>`, which deletes the
marker, because adopt alone leaves the claim standing and the archive refuses again.

**Order.** The replay judgement runs first, because it is local and free, so a replaying lane costs
no board read at all. Retraction runs before the move, so a move that then fails leaves an unclaimed
lane where it was rather than a claim nothing can release.

The archived root is a SIBLING of the lanes root, never a directory under it, which is why no sweep
needs a skip rule: `reconcile` and `migrate` read the roots they are handed and are never handed this
one. The record stays readable: `fabrika lane history <lane> --root <archived-root>` and
`fabrika lane brief` read an archived lane when pointed at it.

stdout is `{answer:"archived", lane, issue, from, to, through, defects, retracted}`. `through` is
`current` or `candidate`, naming which machine refused the log, and `defects` names why.
`retracted` lists the marker comment ids the claim retraction deleted: empty where the issue carried
no claim, and on a chore key, which has no claim thread.

### `--sweep`

`--sweep` takes no lane and keeps the closed-issue gate the single-lane route dropped, because that
narrowing was ruled for the route an operator takes by hand, and nothing has ruled on a sweep that
moves a lane whose issue is still open. It walks the lanes root, archives each lane whose issue reads
closed AND whose log will never replay, and prints one row per lane it examined: archived, or skipped
with the reason (replays / issue open / unjudgeable / key names no issue / unreadable / the archived
root already holds it / the move did not land).

- A lane whose move landed and whose destination does not read back is a THIRD outcome,
  `moved-unverified`, and never a skip. That directory is no longer where it was, so a row calling
  it skipped would state the one thing now known to be false.
- A lane whose judgement is UNKNOWN is never archived. A directory name that resolves to no issue
  number is skipped and named rather than fatal, so one unaddressable key costs no other lane its
  sweep.
- It retracts no claim, so a swept lane whose issue still carries a live lane-claim marker leaves
  that marker standing. The named single-lane route is the one that retracts.

Its stdout is `{answer:"swept", root, present, archivedRoot, examined, archived, lanes}`. It exits
`0` on every skip, because a skip is a row, not a failure. It exits non-zero only where the lane set
is UNKNOWN (`11`) or a move that cleared both gates did not land (`8`) or does not read back (`9`).
The rows reach stderr either way, so a partly-applied sweep is always enumerable.

### Exit status

- `4`, `7`, `21` — the [shared read exits](#the-shared-read-and-record-exits).
- `8` — the move did not land, or a claim marker would not retract. The lane is NOT archived.
- `9` — the move reported success and the destination does not read back.
- `11` — the lane, a committed template, the destination probe or the claim thread could not be
  read, or a committed template that is this lane's own could not be built into a candidate. UNKNOWN,
  never a move. A GENERATED machine binds no template and is not that case, so its own fold is the
  whole judgement.
- `14` — the archived root already holds a lane by this key; a move onto it would bury a record.
- `31` — the issue carries a live lane claim this caller did not name. Pass `--token`, or clear a
  dead seat with `fabrika lane adopt` THEN `fabrika lane release`, since adopt alone leaves the claim
  standing.
- `50` — the log replays, so every sweep can judge it and there is nothing to move out of scope.
- `39`, `65` — [the lanes root](#the-lanes-root); `39` here covers both default roots.

## `lane settle`

### Output

Appends the terminal the board's own closure proves, to a lane whose own flow never reached one. Two
stranded shapes, one verb:

- a lane parked while its issue closed not planned or duplicate owes no artifact;
- a lane sitting in build or review while its issue closed completed over a merged PR was
  hand-shipped past the ledger.

Neither can be ended by the operator's six. DONE claims an open PR that is not there, BLOCKED only
parks, and UNBLOCKED resumes work that is already over. So the only remedy was deleting the lane
directory, which erases an append-only history instead of recording an outcome. This appends ONE
line and moves nothing on disk; `fabrika lane history <lane>` still reads the whole log.

**The board read is the whole entitlement.**

- A `state_reason` of `not_planned` or `duplicate` records `<TASK>.CANCELLED`.
- `completed` PLUS at least one merged pull request whose body links the issue (closing keyword or
  `Part of`) records `<TASK>.LANDED`, carrying those pull request numbers as `landed` and the first
  one's merge commit as `sha`. The pull requests are read only on the completed arm, so a
  cancellation costs one board read.
- Everything else appends nothing. An open issue refuses at `49`. A read that failed, a close
  carrying no `state_reason`, a reason outside the three, or a completed close naming no merged
  linking PR are all UNKNOWN at `11`: a completed close with nothing that did it is genuinely
  unread, not a landing.

**`--landed-by <pr>`** supplies exactly that missing link and nothing more, for a closure a human
closed by hand over a merge whose body cites some other issue. The board must still read that PR
merged, so an unmerged one refuses at `23` and one this repository does not hold at `22`, both with
the log unappended, and an unreadable read stays UNKNOWN at `11`. A body-proven landing is judged
FIRST and wins, so the flag can only ever fill a gap. The line it appends carries
`assertedBy: "caller"` beside its `landed`/`sha`, which is how this verb's own stdout and
`lane history` tell an asserted link from a body-proven one; a body-proven line carries no such
field at all.

Neither event is an operator event. The operator's six are unchanged and `lane transition` refuses
both, so DONE's proof semantics are untouched. A live authorized lane claim refuses at `31` unless
`--token` names it, so a lane another session is driving is not ended underneath it; an unreadable
claim thread is UNKNOWN, never "unclaimed".

The lane then folds to the terminal stateValue `cancelled` or `landed`, its own. It is neither
`complete`, which would claim this lane's flow finished it, nor `tripped`, which would claim it
failed. So `lane status` and `lane stale` read it done, and it holds no seat against
`laneConcurrencyCap`. The offline gate runs first, so a lane already carrying a terminal costs no
board read at all.

stdout is `{answer:"settled", lane, issue, previous, event, current, taskAffected, outcome}`, plus
`landed` and `sha` on a landing, and `assertedBy` on an asserted one.

### Exit status

- `4`, `7`, `21` — the [shared read exits](#the-shared-read-and-record-exits).
- `8` — the append did not land, so the terminal is NOT recorded.
- `11` — the lane, the board closure, the pull requests, the `--landed-by` pull request or the claim
  thread could not be read, or the closure proves no terminal. UNKNOWN, never an append.
- `12` — this lane already carries a terminal, or the task is in a final. There is nothing here to
  settle.
- `13` — the task is not in the machine, or `--task` was omitted on a multi-task lane.
- `19` — the key names no issue, so the closure gate can never be satisfied. The refusal says which
  of the two: a chore lane, which is not settleable at all, or an issue-kind directory name carrying
  no leading issue number.
- `22` — `--landed-by` names no pull request this repository holds.
- `23` — `--landed-by` names a pull request that has not merged.
- `31` — the issue carries a live lane claim this caller did not name.
- `40` — another writer holds the ledger lock; retry.
- `49` — the issue is open.
- `39`, `65` — [the lanes root](#the-lanes-root).

## `lane claim`

### Output

Races the earliest AUTHORIZED lane-claim marker on the issue a lane drives: posts this driver's token
(`lane:<session-id>:<uuid>`), re-reads, and wins or names the winner. Prints
`{"answer":"won","lane":"…","number":n,"token":"…"}`.

- The namespace is the driver's own, `lane-claim:`/`lane:`, never `build-claim:`/`build:`. So the
  builder this driver spawns claims the same issue and wins; the two races never see each other.
- Authorization is the author's repository permission; marker text confers nothing.
- No admission test runs here. The fence is the spawned builder's.
- `--token` makes the re-claim idempotent per DRIVER. Handed the token this driver already holds, a
  lane it already owns answers won with that same marker and writes nothing, so N claims can never
  leave N markers for a later release to peel off one at a time. A same-session marker under another
  nonce is a sibling driver and races normally.
- A `chore:<name>` lane, or any key that is not a board number, has no thread to race on. It answers
  `{"answer":"unclaimable","lane":"…","why":"…"}` at exit `0` with nothing written.
- A lane-adopt marker of this DRIVER standing with no claim beside it refuses the `--token` path on
  `31` and names the release that retracts it, rather than racing a fresh marker past a comment
  nothing later would name.
- An adopt older than the marker it would fence is read as adopting some earlier claim. So one stray
  adopt no longer fences every marker its session posts on the number, and confers no later marker
  either. The same order holds on both arms, so one succession answers mine to exactly one lane.

### Exit status

- `1` — no session id is set (`FABRIKA_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`,
  `PI_SUBAGENT_PARENT_SESSION`), or a `--token` that is not a lane-claim token of this session.
- `8` — the marker write failed. UNKNOWN, never a claim.
- `9` — the marker landed and does not read back.
- `11` — the marker set could not be read. UNKNOWN, never "unclaimed"; this run's own marker is
  retracted first.
- `21` — the key is not a lane key.
- `31` — proven lost. A lost race retracts this run's own marker and exits `31`, never `0`,
  including when the winner is another driver of THIS session, since ownership turns on the whole
  token and never the session id.

## `lane release`

### Output

Retracts this DRIVER's OWN lane-claim marker, and only its own, so the lane is drivable again. It is
run at both ends of the loop, the terminal fold and the park. Prints
`{"answer":"released","lane":"…","number":n}`.

- `--token` says which driver that is. Ownership turns on the whole token, so a sibling driver of one
  session is a foreign holder here and its marker is never swept.
- Every marker carrying this driver's token goes, not merely the winning one, so a duplicate a
  re-claim left behind cannot outlive the release.
- It ALSO retracts this driver's own lane-adopt marker. With a claim beside it, both comments go,
  answering `{"answer":"released","lane":"…","number":n,"adopted":"<session>"}`. With NO lane-claim
  marker standing, the state adopting an already-released claim leaves, that adopt is retracted alone
  under the same answer.
- That second case used to be unreachable. Ownership answered "unclaimed" the moment no claim
  survived, so this verb said "nothing to retract" while `lane claim` went on counting the comment
  and losing to it, and a hand-deleted comment was the only way out.
- Only the driver the marker's "by <token>" names reaches it. A sibling driver reads the thread as
  unclaimed and retracts nothing, exactly as it may not sweep a sibling's claim.

### Exit status

- `1` — no session id is set (`FABRIKA_SESSION_ID`, `CLAUDE_CODE_SESSION_ID` and
  `PI_SUBAGENT_PARENT_SESSION` consulted), `--token` omitted on a board number, or a `--token` that
  is not a lane-claim token of this session.
- `8` — the retraction failed, or a stranded adopt was not retracted. Whether the lane is still held
  or still reads as adopted is UNKNOWN.
- `11` — the marker set could not be read.
- `21` — the key is not a lane key.
- `31` — proven: held by another driver, or neither a claim nor an adopt of this driver stands.

## `lane adopt`

### Output

Posts the succession marker a stranded operator seat's lane claim needs:
`lane-adopt: <session> by lane:<this-session>:<uuid> · <ISO> · reason: <text>`. It writes ONE comment
and posts no claim marker. `fabrika lane release <lane> --token <the token this prints>` then
resolves that claim as this driver's and retracts both comments, after which
`fabrika lane claim <lane>` wins normally. Prints
`{"answer":"adopted","lane":"…","number":n,"session":"<adopted>","token":"…"}`.

- That release reaches this marker EVEN WHEN NO LANE-CLAIM MARKER STANDS, so adopt → release → claim
  terminates from every state, including the one where the claim was already released.
- It fences and confers only over a claim marker POSTED AFTER IT, since a succession adopts a claim
  that already stands.
- UNLIKE `build adopt`, it ADMITS this run's own session. What dies here is a SEAT, and its successor
  boots under the same `CLAUDE_CODE_SESSION_ID` with only a fresh nonce; plain release reads that
  same-session-other-nonce marker as foreign.
- It proves no seat dead, exactly as the build namespace's succession proves no session dead. The
  guards are the poster's repository permission, read at release time, and the marker sitting on the
  issue with its reason for anyone to read. An adopt from an account below write is counted,
  reported, and never a succession. Deleting the comment reverses it.
- A `chore:<name>` lane, or any key that is not a board number, was never claimable. It answers
  `{"answer":"inert","lane":"…","why":"…"}` at exit `0` with nothing written.

### Exit status

- `1` — `CLAUDE_CODE_SESSION_ID` unset, an empty `--session` or `--reason`, a `--session` carrying
  whitespace or `·`, or a multi-line `--reason`.
- `8` — the marker write failed. UNKNOWN.
- `9` — the marker landed and does not read back.
- `21` — the key is not a lane key.

## `lane scratch`

### Output

The DRIVER's per-lane scratch path, allocated fail-closed:
`<temp root>/fabrika-lane/<session-id>/<issue>-<lane-claim-nonce>/<slug>`. One absolute path on
stdout; the directory is created if absent.

Every script, wrapper or helper file a driver writes goes here. The session scratchpad is shared by
every lane of the session, so a helper written there is rewritten by a sibling driver, and every verb
run through it lands in that sibling's tree.

- `--token`'s nonce keys the namespace per LANE, so two drivers of one session print different paths.
  The `fabrika-lane` segment keeps it apart from the builders' `build scratch` namespace.
- The token must be a live lane claim of this session on this lane's issue, proven off the board and
  never trusted.
- A `chore:<name>` lane holds no claim and so has no namespace.
- The printed path is machine-local and must never reach a posted artifact. Every posting verb's leak
  scan reds on it.

### Exit status

- `1` — the directory could not be created, no session id is set (`FABRIKA_SESSION_ID`,
  `CLAUDE_CODE_SESSION_ID` and `PI_SUBAGENT_PARENT_SESSION` consulted), `--token` is not a lane-claim
  token of this session, or the key is a chore lane.
- `10` — `--slug` carries a path separator or is not kebab-case.
- `11` — the lane-claim markers could not be read. UNKNOWN.
- `21` — the key is not a lane key.
- `31` — proven: no live lane claim of this token stands on the issue. Another driver holds it, or
  none does.
