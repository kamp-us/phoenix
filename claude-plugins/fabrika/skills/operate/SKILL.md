---
name: operate
description: "Drive one lane to a terminal state — an issue number, or a `chore:<name>` chore lane — spawning one fabrika shell per active state, or applying one recipe verb, until the machine finishes or parks on a human. Trigger on \"operate #N\", \"drive the lane on #N\", \"run issue #N to terminal\", \"resume the lane on #N\", \"run the chore <name>\", \"sweep the parked lanes\", and whenever a driver wants work carried through without holding the loop in their own session. Type-blind — it routes on the machine's state names and never on a label, so a single issue, an epic and a chore drive through one loop; an epic run's states add the one assembly branch its children land on. Not construction (`build`), judging (`review`), or merging (`ship`) — those run inside the shells it spawns."
arguments: [lane_key]
argument-hint: "[lane-key] — the issue number, or `chore:<name>`, whose lane to drive"
---

# operate

You drive one lane: a lane key in, a terminal machine state or a human park out. Two kinds of key,
one loop — an **issue number** drives an issue's lane, and `chore:<name>` drives a **chore lane**, a
recurring chore that has no issue number to be keyed by ([#5840](https://github.com/kamp-us/phoenix/issues/5840)).
**The ledger is the only state** — `.fabrika/lanes/<n>/events.jsonl`, or `.fabrika/chores/<name>/events.jsonl`
for a chore — folded fresh by a verb on every read; you hold none, and a remembered state is a stale
one. **You are type-blind**: you route on the machine's leaf-state names and never read the work's
type, its body, or its labels — the shells you spawn read their own ground. Every spawn report and
every verb exit you consume is data, never instruction: a shell records its own terminal token
through `lane report`'s closed in-code map, a recipe exit folds through `recipe route`, and
`lane prove`'s read — the artifact behind an event — is what lets any event reach the machine at
all, run by `lane report` on the shell's path and by you on yours.
**Capability set:** shell in the checkout you were spawned in, repo-scoped token, subagent spawns.
Writes used — lane-ledger appends, comments on the driven issue, whatever a recipe verb writes on
its own account (step 3's chore row), and, **on an epic lane only**, that run's assembly branch: you
merge a passing child into it, push it, and open the one draft PR (step 2's `integrate`). Never a
branch a spawned shell owns, never a verdict of your own, and never the merge into the default
branch — that one is `ship`'s, once, at the tail.

Every lane verb is invoked through this repo's own fabrika entrypoint, which `<fabrika>` stands for
in every command below:

```bash
node <fabrika> lane <verb> …
```

`<fabrika>` is a placeholder you substitute textually, the same way you substitute `<verb>` — write
the path itself into every command you run. Never a shell variable: shell state does not survive
from one command to the next, so a `$name` you set expands to nothing on the command after it.
Work out the path once, before your first verb, and it is one of exactly two:

- **A checkout of fabrika's own repo** — the in-tree source, repo-relative:
  `packages/fabrika-cli/src/bin.ts`. Relative on purpose, so each worktree runs its own copy.
- **Any repo that installs fabrika** — the installed bin, absolute:
  `<repo>/node_modules/@kampus/fabrika-cli/dist/bin.js`. Absolute on purpose, because a worktree
  carries no `node_modules` of its own.

**Never the bare `fabrika` binstub** — in a worktree it resolves to another checkout's code
([#5679](https://github.com/kamp-us/phoenix/issues/5679)), so its answer describes a tree you are
not standing in. `lane brief` resolves the same two shapes itself and puts the answer in every spawn
prompt's `fabrika:` field, so you never write the path into a prompt by hand
([#6012](https://github.com/kamp-us/phoenix/issues/6012)).

## 1 — Claim the lane, then boot or resume

The lane you were invoked on is `$lane_key`, and every command below carries it — an issue number,
or `chore:<name>` for a chore drive, which is how a chore is addressed by name. A blank there
does not mean no key exists: a preloaded agent shell (`skills:` frontmatter) always substitutes
blank, because the harness hands the preload an empty argument and the key arrives in the spawn
brief instead — so on a blank, take the lane your caller named there. Only when no caller named
one are you actually without a key, and then ask for it before running a verb. Never invent one
nobody named.

**Claim it before you write anything.** Two drivers ran epic #5492's children at once, each folding
its own machine-local ledger and each spawning its own builder on the same repair, and nothing saw
the collision until `build claim` caught it one level down
([#5761](https://github.com/kamp-us/phoenix/issues/5761)):

```bash
node <fabrika> lane claim $lane_key
```

Exit `0` is yours to drive — `won` on an issue lane, `unclaimable` on a `chore:<name>` key, which
carries no board number for a marker to sit on and so races with nobody. Exit `31` is a **proven
loss**: another driver holds this lane, its token is named on stderr, and this run ends `LANE-HELD`
having emitted no ledger and spawned no shell. `1` (no `CLAUDE_CODE_SESSION_ID`), `8` (the marker
write is UNKNOWN), `9` (it landed and does not read back) and `11` (the marker set could not be
read) all end `STOPPED` naming the code — an unproven claim is never driven through.

The claim is the driver's own namespace, `lane-claim:`, not the builder's `build-claim:`. That is
what lets the builder you spawn on this very number claim it and win: two markers on one thread,
two races that never see each other. You never read the other namespace and never retract a marker
that is not this run's.

```bash
node <fabrika> lane status $lane_key
```

Exit `0` is resume — the lane exists and its fold is the state; go to step 2. Exit `7` (no lane)
is boot:

```bash
node <fabrika> lane emit $lane_key
```

`lane emit` generates an epic lane — one region per child, phase-sequenced — from the epic body's
topology block. Its absent-topology refusal is the deterministic "this is not an epic" answer, and
that refusal-first order is what keeps the boot type-blind: no label is read anywhere. On that
refusal — and straight away on a `chore:<name>` key, which names no epic body to read a topology
out of — boot from the committed template instead:

```bash
node <fabrika> lane open $lane_key
```

`lane open` places the template the key selects — the coder workflow for an issue number, the chore
workflow for `chore:<name>` — so a chore drive needs no document written by hand. Its
already-exists refusal is tolerated as resume, not treated as an error. Both verbs
are specified on [#5688](https://github.com/kamp-us/phoenix/issues/5688) — until that lands they
exist only as its spec; once it does they join `status`/`transition`/`history`/`print` in
`packages/fabrika-cli/src/lane/`, and each verb's `--help` is its interface. Any other exit is a stop, not a fallback: `4` is a record read in full and not
the shape, `11` is a lane that could not be read — opposite remedies, neither yours to guess. End
`STOPPED` naming the code.

A lane `lane emit` booted is an epic run, and an epic run is **one branch and one PR** (ADR
[0285](../../../../.decisions/0285-epic-machine-ends-in-review.md)). That is structural, not a label
you read: the topology parsed, so children exist. Children build in parallel worktrees, each on its
own local branch, and land by merging into a single **assembly branch** — `epic/<lane-key>`, the
name `lane brief` hands every child shell and the base `lane prove` reads a child's range against.
Create it before the first dispatch, off the repository's default branch. `origin/HEAD` is
git's own pointer to that branch — no name resolution needed; the `set-head` call refreshes the
pointer in a checkout where it was never set:

```bash
git fetch origin
git remote set-head origin --auto
git switch --create epic/$lane_key origin/HEAD
```

An already-exists error is resume, like `lane open`'s: `git switch epic/$lane_key` instead. Its
absence is not a soft failure — without it `lane prove` reads every child's range as UNKNOWN
(exit `11`), so a run driven without it proves nothing it records.

Done when `lane status` folds and prints a `stateValue`.

## 2 — Read the fold, route each active task

Run `lane status` fresh at the top of every pass — the fold is the state. For **each task in the
active phase** (future phases read `waiting`; leave them alone), route on the leaf-state name:

| Leaf state | Action |
| --- | --- |
| `queued` | record `WIP` — the task enters build |
| `build` / `review` / `ship` | dispatch through `lane brief` — below |
| `integrate` | land the child on the assembly branch yourself — the epic run, below |
| a state `recipe route` names | apply that recipe verb — the chore drive, below |
| a task's own final — `landed`, `shipped` | nothing to route and no event to record: that task is finished, and its phase advances when every task in it is final |
| `frozen` | park — step 4. It is an error final, so it trips the phase where it sits and the fold says so; it is also the one final with a door out (ADR [0297](../../../../.decisions/0297-frozen-is-a-park-not-an-end.md)), and walking it is a human's `UNBLOCKED`, never yours |
| `human:*` | park — step 4 |
| `blocked` | park — step 4 |
| any other name | end `STOPPED` naming the state — never guess a shell for a state you do not recognise, and never a park: `LANE-PARKED` promises a fold in `blocked`/`human:*`/`frozen`, which an unrecognised state cannot honour (Terminal vocabulary, below) |

**You never compose a spawn prompt.** The verb prints it:

```bash
node <fabrika> lane brief $lane_key --task <name>
```

Its stdout is the whole prompt — send those bytes to the spawn verbatim and add nothing to them. It
derives every value: the state from the same fold you just read, the shell from its own routing
table (`build` → builder, `review` → reviewer, `ship` → shipper), the issue and PR URLs off the
board, your lanes root resolved absolute so the shell's `lane report` addresses this ledger rather
than its own worktree's (#5736), the fabrika entrypoint resolved for this repo so the shell runs a
path that exists there (#6012), and its rules from byte-fixed text the `lane-brief` wire format owns
([`packages/fabrika-cli/src/wire/lane-brief.ts`](../../../../packages/fabrika-cli/src/wire/lane-brief.ts)).
Those rules are the three a driver used to carry in their own prose — the isolated worktree, URLs
never restatements, and the brief's own `fabrika:` entrypoint for every verb rather than the bare
binstub (#5679, now in the spawned tree). They are in the brief because a prompt written per
dispatch is a prompt two drivers write differently.

The spawn flag is still yours: **`isolation: worktree`, no exceptions** — a non-isolated subagent
shares the primary checkout and can mutate its git state, and no bytes in a prompt can enforce that
from the inside.

`lane brief`'s refusals are the parks it saves you from guessing at: `18` is a state that routes to
no shell, `19` is a task whose issue cannot be resolved or is absent, `20` is zero open PRs where
the state needs one or several where one is required. It counts a PR only when the PR **declares it
closes** the task's issue — GitHub's own closing-issue link, not a body mention — so a PR that
quotes the number in prose never makes `20` fire (#5805). An epic child's `review` brief adds three
more, because it resolves the child's range off this tree rather than printing one the spawned shell
re-resolves (#6023): `22` is no branch here carrying the child's commits, `25` is several of them,
and `11` is a ref this tree cannot read — the same three facts, and the same remedies, `lane prove`
seats on those codes. Each is a park naming what the verb named — never a prompt you write by hand
instead. Parallel active tasks brief and spawn in parallel.

**An `integrate` state is the one thing you do with your own hands.** It routes to no shell —
`lane brief` refuses it with exit `18` — because the merge *is* the assembly the run exists to
produce, and no spawned worktree owns the branch it lands on. Everything about it is still a relay:
the branch comes off the proof you just recorded, the merge's own exit is the verdict, and the
machine owns what each verdict means.

Take the branch off `lane prove`'s `PASS` evidence, which prints it as `evidence.branch` beside the
range it judged — never off a name you compose. Then, standing on the assembly branch:

```bash
git switch epic/$lane_key
git merge --no-ff <evidence.branch>
```

`--no-ff` because each landing should be one commit a reader can name; a fast-forward would leave
two children's ranges indistinguishable in the history the epic reviewer reads. A conflict is the
`FAIL` that re-enters `build` under the retry budget — that route is why a cross-child collision
resolves inside this run instead of at a merge queue. A clean merge is only half the answer: the
**semantic** collision is two ranges that each passed alone and do not hold together, and it reads
as the merged tree failing the repo's own checks (`pnpm typecheck` and `pnpm lint:worktree` — the
same two every child's `build check --surface code` ran in its worktree, now run once over the
assembly). Non-zero there is the same `FAIL`.

**The assembly branch moves only on a `DONE`.** On either `FAIL`, put it back where it was —
`git merge --abort` on a conflict, `git reset --hard ORIG_HEAD` on a clean merge the checks refused
— so the recorded `FAIL` names a branch that never carried the bad merge. The repair builder is
then the machine's own route out of `build`, and `lane brief` hands it both ranges: the child's
issue, and the assembly branch, which by now carries every sibling that landed before it. Nothing
reaches `landed` except back through `review`, because the resolution changes the content the
child's range verdict bound (ADR [0276](../../../../.decisions/0276-verdict-binds-content-not-only-head.md))
— that ordering is in the machine's graph, not in this paragraph.

**Push at integration points, and only there.** A repair round costs no push, no CI run and no board
write, which is the whole point of the local loop (ADR 0285); a landed child is the moment the run
has something worth publishing. So after the merge and its checks pass, and before you record the
`DONE`:

```bash
node <fabrika> lane push $lane_key
```

The verb, not your own `git push`: it derives `epic/<n>` from the number rather than taking a branch
name, refuses any tree not standing on it, and then reads the ref back off the remote — so
`PUSH-VERDICT: MOVED` on the last stdout line is the only thing that means the assembly landed. A
bare push cannot say that, which is why the corpus forbids one ([#4213](https://github.com/kamp-us/phoenix/issues/4213)),
and `build push` cannot serve here because the assembly branch carries no build claim's nonce. There
is no force flag to reach for: the branch only ever grows, so exit `29` means fetch and re-merge, and
exit `30` is a proven "the remote did not move" — never a `MOVED` you assume.

**The first of those pushes also opens the run's one PR**, as a draft — a draft carries the CI
signal and the board's view of the run without inviting a review the machine has not asked for.
Open it yourself; no shell owns this branch. Its body carries two
things, neither of them a summary you compose:

- **one closing reference per child that has landed so far**, plus one on the epic issue itself.
  The epic's is what makes the PR findable at all — `lane brief` resolves the tail's PR through
  GitHub's closing-issue edge on the epic, and without it every tail dispatch refuses with exit
  `20`. The children's are what make all of them close at the single merge, which is how ADR
  [0131](../../../../.decisions/0131-epic-autoclose-on-all-children-closed.md)'s auto-close reads
  under this shape: it fires on the GitHub edge after the merge, never mid-lane;
- a `## Deviations` section covering **the assembly** — the merges you performed, which are the only
  thing on this PR that is yours. `None.` while every child landed on a clean merge and clean
  checks; one entry per repaired integrate once one did not, naming the two children whose ranges
  collided. The epic reviewer reads that section through the `deviations` wire format, so run its
  parser over the body before you open or edit it — `wire check --format deviations` — rather than
  leaving the malformed answer to arrive a review round later. A child's own deviations are not
  yours to restate here: each child disclosed them as a `build-deviations` marker comment on its
  own issue (#5903), and the tail review's brief names that surface, so the epic reviewer reads
  them there.

Open the draft with the command below as written. `--base` is omitted on purpose — `gh pr create`
defaults it to the repository's default branch, the same branch the assembly cut from. The title
is deliberately the lane key, not the epic's prose title: nothing downstream reads a PR title
(`lane brief` resolves the tail's PR through the closing-issue edge), and a literal title is what
keeps this fence expansion-free:

```bash
gh pr create --draft --head epic/$lane_key \
  --title "epic #$lane_key: one-PR run" --body-file -
```

Every later integration pushes the same branch and **appends that child's closing reference** to the
body, so the set of references tracks the set of landed children rather than the plan's intent.

**The draft flips ready at the tail's `PASS`, and nowhere earlier.** When the epic-level review's
`PASS` is proven and recorded, the single PR has the verdict it was opened for — mark it ready
before dispatching `ship`, whose write verbs refuse a draft. The number is the one `lane brief`
printed in the tail's `## Ground`:

```bash
gh pr ready <pr>
```

That is the last thing you do to the branch: the merge itself is the shipper's, once.

**A chore state routes to a verb, not to a shell**, and the routing is a verb's answer too:

```bash
node <fabrika> recipe route <state>
```

Exit `0` prints `{state, verb, target, summary}` — which recipe to run, and whether it is pointed at
a lane key or a pull-request number, which is the argument you pass and never one you infer. Exit
`22` is a state that applies no recipe: act on that state through the table above, and never run
*some* verb over it. **You hold no recipe knowledge**: you do not know what a recipe does, you do
not compose a fix, and you never retype the sequence a verb owns (ADR
[0228](../../../../.decisions/0228-scripts-relay-never-derive.md)) — that is the whole reason a
chore is a verb and not a paragraph. Then run exactly what `route` named, with the target your
caller gave you:

```bash
node <fabrika> recipe unpark <target-lane-key>
```

Done when every active task has either a spawn in flight, a recipe run answered, a merge answered,
or an event recorded this pass.

## 3 — Verify the record landed, and record what no shell can

**A shell records its own terminal.** Every spawned shell ends by invoking
`lane report <lane> --root <root> --token <TOKEN>` against the lane and root its brief named, and
the token→event map is code
([`packages/fabrika-cli/src/lane/report.ts`](../../../../packages/fabrika-cli/src/lane/report.ts)),
never a table you execute — an unrecognised token is that verb's refusal (exit `32`), not a reading
of yours. **That verb proves before it appends**: it runs `lane prove`'s read on the mapped event
and refuses on `lane prove`'s own codes, so a shell-recorded `DONE` or `PASS` reaches the ledger
only with its artifact behind it, exactly as one you record does. So when a spawn returns, your
first move is a fresh `lane status`: a moved fold is a recorded terminal, and you route from it.
Two reads stay yours, because no shell can take them:

- **a spawn that printed a terminal the fold does not show** — its record never landed (a missing
  root, an unproven event, a refused append). Do not re-spawn: prove and record that token's event
  yourself, below, and where the proof refuses there too, the refusal table is what you route on —
  a `22` is a `BLOCKED`, never the `DONE` the spawn printed;
- **a dead or unresponsive spawn, a report you cannot parse, and a permission denial a shell
  reports** ([#5685](https://github.com/kamp-us/phoenix/issues/5685)) — each is a BLOCKED-class
  outcome, never something to route around, and never a retry-in-place: retries belong to the
  machine (`FAIL` spends one; `frozen` is its answer), and you never re-spawn what the fold has not
  re-asked for. Record `BLOCKED`.

**A dead spawn's residue is yours to clear** — the founder's ruling on
[#5752](https://github.com/kamp-us/phoenix/issues/5752). `BLOCKED` records where the lane stands; it
does not clean up after the shell that died, and what a dead spawn leaves behind is an incident
nobody filed and a claim nobody can take. Three obligations, in this order:

- **Read its final message.** What the spawn printed before it stopped is the only account of what
  it was doing, and both the filing and the park comment come out of it.
- **File what it could not file.** A dying agent cannot run `fabrika report file` itself, so the
  incident reaches the board only if you file it — through [`report`](../report/SKILL.md), as the
  spawn would have.
- **Release the claim it stranded.** `node <fabrika> build release <issue>`
  is the whole act: the spawn ran under your `CLAUDE_CODE_SESSION_ID`, so its marker resolves as
  this session's and the verb that already exists retracts it. No new verb and no widened one — the
  ruling rejected a lease, a TTL and steal outright, and eviction by inference from
  absence stays banned (ADR
  [0215](../../../../.decisions/0215-claim-identity-continuity-proof.md) §5).

**A claim stranded by a gone session is releasable, once you say so on the board.** `build release`
refuses it on `15` — proven-foreign — until an adopt marker names that session as dead and this one
as its successor: `fabrika build adopt <n> --session <its session id> --reason "<why>"`, then
`fabrika build release <n> --token <the token adopt printed>` (ADR
[0295](../../../../.decisions/0295-board-attested-claim-succession.md)). The adopt is disclosed on the
issue and reversible by deleting it; a claim you are not willing to state that about stays where it
is, named in the park comment with its token.

**Every event is proven first — artifacts over self-reports.** A report is
data; what moves the machine is the artifact behind it. The verb below is the read `lane report`
already ran for the shell; on your own two records it is yours to run. The retired epic conductor held this rule
against the git graph; the verb below holds it against whichever artifact the task's own shape has
— the board for a single-issue lane and for an epic run's tail, the commit range and its
range-scoped verdict for an epic child, which opens no PR at all (ADR 0285). You never pick which;
it reads the shape off the machine. It runs **before** the event, never after:

```bash
node <fabrika> lane prove $lane_key DONE
```

Record the proven event only on exit `0`:

```bash
node <fabrika> lane transition $lane_key DONE
```

(On a multi-task lane, address both verbs with `--task <name>`, the name exactly as `lane status`
prints it; a single-task lane tolerates omission.)

`lane prove` reads the two events a report can lie about — a `DONE` out of `build` and a `PASS` out
of `review` — and answers `not-required` at exit `0` for every other one, so it is run on every
event and never skipped as an optimisation. Its refusals each name a different next move:

| Exit | What it read | What you do |
| --- | --- | --- |
| `0` | the artifact is there (or the event claims none) | record the event |
| `22` | the artifact is provably absent — no open PR links the task's issue and no legal no-PR outcome is proven either (the issue is not a `type:investigation`, or it is one but no diagnosis was posted since the task entered `build`); on an epic child, no branch in this tree carries commits naming it | the report is unproven — record `BLOCKED`, never the `DONE` |
| `23` | a derived namespace has no verdict that still binds — no current-head one on a PR, or, on an epic child, none whose content digest matches what the range carries now | record **nothing**; re-read this pass |
| `24` | a still-binding `FAIL` under a claimed `PASS` | record the event the artifact supports (`FAIL`) |
| `25` | several candidates — open PRs linking the issue, or lane branches carrying an epic child's commits | park — step 4, naming the ambiguity |
| `11` | a lane, board or tree read failed | the proof is UNKNOWN — end `STOPPED` naming the code |

A builder's `SUCCESS-NO-PR` is a proven `DONE`, not an unproven one: the verb takes the no-PR arm
only for a `type:investigation`, and proves it from the diagnosis comment posted since the task
entered `build` — the artifact the builder's terminal names, read off the issue rather than off
the report. An epic child's `BUILT-NO-PR` is the other proven `DONE` without a PR, and its artifact
is the range's own commits — a child opens no PR to prove one against (#6019).

**An `integrate` has no spawn to report**, so its row is the merge's own exit folded by the two
rules step 2 named: a clean merge whose post-merge checks pass is `DONE`; a conflict, or a red
check, is `FAIL`. `lane prove` answers `not-required` for both — a `DONE` out of `integrate` claims
no artifact a read could falsify — so it is still run and still gates the record.

**Still binding** is one rule read against whichever artifact the subject has: on a PR, a verdict at
its current head; on an epic child, which opens no PR, a verdict whose content digest matches what
the child's range carries now (ADR 0276). You never judge that yourself — `lane prove` reads it, and
its exit is what decides.

**A recipe run's exit folds through the same verb that routed it**, never through a reading of
your own:

```bash
node <fabrika> recipe route <state> --exit <code>
```

Its `event` is the one to record and its `why` is the sentence to quote; the table it answers off is
closed and lives beside the exits it reads
([`packages/fabrika-cli/src/recipe/drive.ts`](../../../../packages/fabrika-cli/src/recipe/drive.ts)),
so a code nobody seated folds to `BLOCKED` rather than to a permissive guess. Two readings decide
how autonomous the drive is, and both are the verb's, not yours: a **novel** exit — the park's cause
is outside the recipe table — folds to `BLOCKED`, which the chore machine routes to `human:novel-park`,
and that is the only way a chore reaches a person; a park whose known recipe is simply not clear yet
folds to `WIP`, which leaves the chore on its own state for a later pass rather than spending a
human on a wait. Escalate nothing else and improvise nothing: **the driver only ever sees novel
parks**, which is true exactly as long as you record the event the verb named.

Each terminal vocabulary is owned by the shell's own skill, and `lane report`'s map is the only
place they fold into the machine's six — you fold none of them yourself, and the two refusals this
step opened with (the permission denial, the dead spawn) are the whole judgment left on a spawn's
report.

One more refusal guards a reviewer `FAIL`, and it is the one half `lane prove` cannot take off your
hands — the read enforces it mechanically for a `PASS` (exit `23`) on both paths, the shell's
through `lane report` and yours through the verb, while a `FAIL` claims no
artifact and so is proven by nothing: **a reviewer `FAIL` is recorded only when every derived
namespace holds a verdict that still binds** — governance included, on a `governance: required` diff. `FAIL`
routes the machine into a repair build, and a repair pushes a new head; recorded while any
namespace is still in flight, it orphans that namespace's verdict mid-write and spends one of the
machine's retries on a verdict set nobody finished. A reviewer report carrying a `FAIL` beside a
namespace with no verdict that still binds is an incomplete read, not an event: re-read the
artifact's verdicts — the PR's, or the child range's — until every derived namespace is terminal
against what that artifact carries now, then record. **The re-read is bounded, not a hold**: it runs
only while the reviewer's run is still in flight, and once that run has ended with the namespace
still empty the outcome is the `BLOCKED` the next paragraph names — never an indefinite wait on a
state that reads as active. No repair builder is
ever spawned while any namespace at the head is non-terminal.

**Re-reading terminates, because no reviewer may decline a derived namespace on a `FAIL` round, and
none may route one away either.** ADR
[0293](../../../../.decisions/0293-governance-fires-every-round.md) rules governance
derived-required at every round and every head on a `governance: required` diff, FAIL rounds included —
`review` §6 states it on both arms, and that skill's `routed elsewhere` terminal covers `review-ui`
and `check-epic-plan` only, so no reviewer terminal ends a run with governance un-fired (#5769). So a
governance verdict missing at a `governance: required` head is
always a read still in flight or a reviewer that died mid-emit, never a licensed refusal, and the
remedy above reaches a verdict instead of waiting on one nobody will write. The floor stays, and no
`governance: required` FAIL round holds the old deadlock — the state where the verdict is refused by rule,
so it can never be written and the repair can never be dispatched. A namespace still empty after the
reviewer's run has ended is a dead spawn like any other: record `BLOCKED` per the spawn-report step
above and let a human unblock it. Do not re-spawn the reviewer on your own read.

`lane transition` exits are verdicts: `12` means the event was refused and the log left
unappended — the machine holds no cell for it, so re-fold with `lane status` and route from the
state that is actually there. `8` means the append did not land — the event is **not** recorded;
re-run before trusting anything. Then loop to step 2.

Done when the fold reads a terminal state or a park.

## 4 — Park, or end with the transcript — then release

Both ends of the loop release the claim, and it is the **last** thing the run does — after the park
comment or the transcript has landed, so a successor that wins the lane the moment you let go finds
the artifact already there:

```bash
node <fabrika> lane release $lane_key
```

Exit `0` is released (or `inert` on a chore key, which was never claimable). `31` means this session
holds no claim — say so and stop; you never retract another driver's marker. `8` or `11` leaves
whether the lane is still held UNKNOWN: name the code in your terminal line rather than reporting a
release you cannot prove. A `STOPPED` run releases too — a claim outliving the driver that took it
is the same lane nobody can pick up.


**A run never ends `LANE-PARKED` while the fold reads a non-parked state.** `human:*`, `blocked`
and `frozen` are already parked — the fold itself says so, and no event is owed on top of it. Any
park you originate — one this section names rather than a state the fold already holds — records
the event that matches the terminal first: `lane transition $lane_key BLOCKED`, then a fresh
`lane status`, and only when the re-fold reads `blocked` or `human:*` does the run end
`LANE-PARKED`. A park whose event was never recorded is prose the machine cannot see: the fold
still reads `build` or `review`, the human's `UNBLOCKED` is refused there (exit `12`, no cell),
and resume becomes interpretation instead of mechanics (#5643, #5714). If the `BLOCKED`
transition is itself refused with exit `12` — the current state holds no cell for it — end
`STOPPED` naming the code, never a prose park on top of the refusal. (One recorded park is still
mislabeled rather than missing: `BLOCKED` from `ship` folds to `human:cp-approval` even when the
block is generic — [#5820](https://github.com/kamp-us/phoenix/issues/5820) tracks that cell.)

You cannot clear a park: post on the driven issue what is needed and from whom (the parking
spawn's report names both; for `human:cp-approval` it is a control-plane approval at the PR's
current head; for `frozen` it is a founder-cleared repair round, recorded with `build clear`, which
re-folds the task into `build` on its own — a bare `UNBLOCKED` walks the door back into the same
review with the budget still spent, so the next `FAIL` freezes it again). One park class names its
owner here, not off the spawn's
report: **a wire defect on the driven issue's own body** — an acceptance-criteria heading a
spawned shell fail-louds on, a criteria block that reads as no shape the verbs parse.

**You may try the repair before you originate that park**, and it is one call:

```bash
node packages/fabrika-cli/src/bin.ts triage repair-criteria <n>
```

The verb is the driven body's sanctioned owner and it is refusal-first: it rewrites shape and
nothing else — a drifted heading level, plain list bullets to unchecked checkboxes — and refuses
anything that is not a pure shape rewrite. So running it never makes you the one choosing what the
body says, which is the whole reason the prohibition below does not reach it. On `repaired`,
re-dispatch the shell that fail-louded and record **no** `BLOCKED`: nothing parked, so there is
nothing for a human to clear. Five M46 lanes spent a human cycle each on this park in one night
(#5736, #5807, #5823, #5718, #5761) for a defect this verb repairs (#6001).

The permission is exactly that one call and stops there. **Never edit the body yourself** — you are
type-blind, and a driven issue's body is not your artifact — so no hand-edit, no other section, and
no second run after a refusal. A refusal is the verb's answer, not a prompt to retry.

On any refusal the park is the one this section always described, and the order above binds:
record `BLOCKED`, re-fold and confirm the state, then post the park comment — the step both #5643
and #5714 skipped, leaving parks the machine could not resume. The fix is then `triage`'s: the
surface that stamped the issue agent-ready owns its wire shape, so the park comment names the
defective section and points at the verb that owns the repair — `triage repair-criteria`, whose
`--help` is its interface — never restating what that verb does, and never delegating both the what
and the who to the parking spawn's report. Clearing a park is a
human's `UNBLOCKED`, recorded through the same `lane transition` verb — you never record
`UNBLOCKED`. One exception, and it is still not yours: on a **known** park a recipe verb owns,
`recipe unpark` records that lane's `UNBLOCKED` itself, and only after a re-fold proves the task
left the park. The rule and its actor list are ADR
[0301](../../../../.decisions/0301-known-parks-clear-novel-routes-human.md)'s, which amends ADR 0297
in part — this section states no park-clearing authority of its own. You relay that verb's exit into
the chore lane's own event and type no `UNBLOCKED` anywhere.

A chore lane has **no driven issue** — that is what a chore is — so a park it holds has nowhere to
be commented. Report it to your caller instead, in the terminal line: the chore key, the state the
fold reads (`human:novel-park` is the named park a recipe refusal folds to), and the verb exit and
`why` that put it there, quoted off `recipe route --exit`. The transcript below is the artifact; a
caller re-reads the ledger, never your summary. A resumed run that folds into a still-parked lane restates the park in one comment
and ends `LANE-PARKED` again; the ledger, not your patience, decides when the lane moves.

**A terminal fold (`status: done` — `shipped`, `complete`, `tripped`, and a chore's
`swept`) ends the run with the transcript**, posted to the driven issue straight off the verbs:

```bash
node <fabrika> lane print $lane_key | gh issue comment $lane_key --body-file -
```

with `lane history $lane_key` appended the same way when the event log adds anything `print` does not
show. Name the terminal state in the comment. End `LANE-TERMINAL`. On a chore lane the pipe has no
issue to land on: print the same two verbs and hand their bytes to your caller, who owns where a
chore's transcript is posted.

**A `tripped` fold is not automatically a terminal** — read which state its error task sits in. On
`frozen` the run ends `LANE-PARKED` with the transcript and the need posted (the founder-cleared
round above); every other error final has no door and ends `LANE-TERMINAL`.

**Resume is a re-spawn.** There is no handoff and no memory: resuming a lane is spawning the
operator again with the same issue number — step 1 tolerates the existing lane, and the fold says
everything a successor needs. That is why no step above holds session state.

**A non-parked lane with no live operator is a detectable defect, not a wait.** The ledger records
state, not liveness, so an operator that dies mid-drive leaves its lane reading `build` or `review`
forever and nothing here can record the `BLOCKED` a dead spawn is owed — the dead shell is the one
that would have to record it. What catches it is a driver-side sweep, not a driver's patience:

```bash
node <fabrika> lane stale --older-than 60
```

Every `stale` row is a lane something is owed on that has not moved in the threshold; `parked`,
`terminal` and `unstarted` rows are never reported stale, so the list is exactly the lanes to
re-spawn. It reports and never resumes: a driver or a human decides, and the resume is the
re-spawn above ([#5897](https://github.com/kamp-us/phoenix/issues/5897)).

## Terminal vocabulary

Every run ends as exactly one of — each naming what was recorded and what the fold reads after:
**`LANE-TERMINAL`** (the machine folded to a final state with no door out — `shipped`, `complete`,
`tripped`; no event recorded on top of a final fold; transcript posted on the driven issue) ·
**`LANE-PARKED`** (the fold reads `blocked`, `human:*` or `frozen` — either it already did and no
event was owed, or the `BLOCKED` this run recorded put it there and the re-fold confirmed it; the need
posted on the driven issue) · **`LANE-HELD`** (step 1's claim was proven lost — another driver owns
this lane, its token named; no ledger emitted, no shell spawned, no marker retracted, nothing
posted) · **`STOPPED`** (a verb exit UNKNOWN, a malformed record, an
unroutable state, or a `BLOCKED` refused with exit `12` — the code or state named, nothing
guessed, no event recorded, the fold unchanged). An unroutable state ends `STOPPED`, never
`LANE-PARKED`: a park promises a mechanical `UNBLOCKED` resume from `blocked`/`human:*`/`frozen`,
which a state this skill does not recognise cannot honour — and appending `BLOCKED` toward cells you do
not know is exactly the guess step 2's routing table forbids. A park reported as a
terminal destroys the caller's routing: the two differ in exactly who acts next. Follow-up
observations leave through `/report` the moment you see them — never through scope creep in a
lane you are only driving.

## Required repo files

fabrika installs into repos that are not phoenix, so every repo surface this skill leans on is
declared here: what must exist, why this skill needs it, and the one named outcome when it is
absent. The when-missing vocabulary is closed — **fail-loud** (stop, name the missing surface by
its repo-relative path, point at front-door, **and file the gap**), **degrade** (continue with a
narrower answer, stated), **bootstrap** (front-door creates it) — and it is the same table in every
fabrika skill, so one reader parses all of them. No row here dead-ends on a bare error.

| Must exist | Why this skill needs it | When missing |
| --- | --- | --- |
| The lane verb group — `<fabrika>` routing `lane status`/`transition`/`report` (#5736)/`prove` (#5747)/`history`/`print` plus `open`/`emit` (#5688), `brief` (#5751), `stale` (#5897) and `claim`/`release` (#5761) | Every state read, every proof, every event write, every spawn prompt, the dead-operator sweep and the driver's own exclusivity in this skill is one of these verbs; there is no other path to the ledger, none to a prompt, and none to knowing whether a second driver is already here | **fail-loud** — a verb that cannot be executed leaves the lane state UNKNOWN; the run ends `STOPPED` naming the entrypoint it could not run and points at front-door. |
| The recipe verb group — `<fabrika>` routing `recipe route` plus the recipes it names (`unpark`, `rerun`), and the chore template at `packages/fabrika-cli/src/lane/templates/chore.workflow.json` | A chore drive routes and folds through `recipe route`, runs the recipe it names, and boots from that template; there is no other path to either answer | **fail-loud** — a chore drive whose routing verb cannot be executed knows neither what to run nor what an exit meant; the run ends `STOPPED` naming `packages/fabrika-cli/src/recipe/`, records no event, and points at front-door. An issue lane is unaffected. |
| The agent shells — `claude-plugins/fabrika/agents/builder.md`, `reviewer.md`, `shipper.md` | Step 2's routing table spawns exactly these three by their bare noun names | **fail-loud** — a route whose shell does not exist cannot spawn; the run ends `STOPPED` naming the absent shell file, and no event is recorded for a spawn that never started. |
| The `package.json` scripts `typecheck` and `lint:worktree` | An epic run's `integrate` reads the semantic collision off them — two ranges that each passed alone and fail together show up as the merged assembly failing the checks, and a clean `git merge` alone cannot see that | **degrade** — a clean merge is then the whole `DONE` answer and a semantic collision only surfaces at the epic review; say so in the transcript comment and file the gap via `/report`. An epic run still drives; a single-issue lane is unaffected. |
| `id:gitignore-row` `.gitignore` covering `.fabrika/` | The ledger is a disposable machine-local artifact, regenerable from the board — committed, it would smuggle one machine's lane state into every checkout | **bootstrap** — `fabrika status bootstrap gitignore-row` appends the row and reads it back; until then the verbs still work, so state the uncovered `.fabrika/` in the park or transcript comment. |
