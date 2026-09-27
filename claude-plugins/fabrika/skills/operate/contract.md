# `lane` verbs — derived CLI contract

**Skill:** [`operate`](SKILL.md) · **Date:** 2026-09-27

These verbs live in `packages/fabrika-cli/src/lane/`, grouped under `fabrika lane`. Each verb's
`--help` owns the caller facts: invocation, flags, answer bytes, a one-line meaning per exit and a
runnable example. This file owns what help leaves out, per the
[leaf help size and shape](../../docs/interface-convention.md#leaf-help-size-and-shape) rule: how a
value is derived, why a check exists, the order mutations run in, and the conditions behind each
exit. A verb's help ends on a pointer to its section here. Read one section by heading:

```bash
fabrika wire doc-section --heading "lane transition" < claude-plugins/fabrika/skills/operate/contract.md
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

`lane transition` and `lane report` are the two verbs that can append a `BLOCKED`, and both take
`--cause` and `--class` with the meanings on those flags.

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
