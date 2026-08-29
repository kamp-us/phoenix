# Why fabrika is shaped this way

fabrika turns an issue into a merged pull request through a chain of agents. Almost every design
question people ask about it comes down to the same worry: *why is this so many moving parts when
one agent could just do the work?* This page answers that. It argues the shape and points at the
[ADR](../../../.decisions/) carrying each full argument; none of it is a procedure, and no page
here is where you look up a flag.

## Stages are separate actors because a judgement needs someone who did not do the work

The chain is `report` → `triage` → `plan-epic` → `build` → `review` → `ship`, with `heal-ci` off to
the side for a pull request that has stopped moving. Each is its own skill, run by its own agent
shell.

The obvious alternative is one long-running agent that does all six. It fails on judgement. An agent
that just wrote a diff and then reviews it is answering "is this right?" holding every reason it
believed the diff was right — the reasons are in its context, and the argument for the work is the
argument for passing it. A separate reviewer starts from the issue and the diff, and nothing else.
The same split is why the reviewing agent reads its instructions from the base branch rather than
from the head it is judging: a gate that loads its own operating instructions out of the thing under
test is not a gate ([ADR 0052](../../../.decisions/0052-review-code-config-isolation.md)).

The separation also buys context. Each stage carries only its own question's material, so a long
epic never accumulates one enormous transcript where the early decisions have fallen off the end.

And it fixes authority. One stage owns each question and no other stage recomputes it: `ship` is the
only merge authority, `review` is the only thing that issues a verdict, `triage` is the only thing
that types and prioritizes an issue. Two answers to one question is the failure mode the whole
design is arranged against. The actors are named for the thing that acts rather than the act — a
`builder` runs `build` ([ADR 0281](../../../.decisions/0281-agent-names-are-nouns.md)) — precisely
so "who is answering this" stays a question with a name in it.

Human capacity, not agent throughput, is what sizes the chain: batches are shaped to what a reviewer
can actually check, and the founder keeps one recurring seat rather than one per stage
([ADR 0278](../../../.decisions/0278-pipeline-sized-by-human-capacity.md)).

## A lane is a run, and its state is on disk because a session is not a place to keep state

A **lane** is one unit of work being driven — an issue, or a standing chore — with a state machine
over the stages it passes through. `operate` walks that machine, spawning the shell each state
names and folding the outcome back in.

The lane's state lives in `.fabrika/` on disk as an append-only log, and its ledger is folded fresh
each run. That is a deliberate rejection of the natural place to put it, which is the driving
agent's own context. A session ends, gets compacted, or crashes; a run whose state lived only there
cannot be resumed, cannot be inspected while it is happening, and cannot tell you afterwards what it
did. Anything a fresh process can fold off disk survives all three.

What may live there is bounded, and the boundary is the point:
[ADR 0283](../../../.decisions/0283-local-ledger-holds-ownable-orderings.md) admits only orderings
this tree can own — drive-loop mechanics — and keeps shared truth on GitHub. A review verdict, a
claim, a label and a merge-queue position are facts other people and other machines read, so they
live where those readers already look. A local file asserting a verdict is a second source of truth,
and the two will disagree.

The claim is the same argument from the other side. It says "this issue is mine", and it does not
lapse when a run ends, because a run finishing is not the work finishing
([ADR 0272](../../../.decisions/0272-lane-owns-the-claim.md)). The cost accepted there is real: a
claim can outlive the lane holding it, so reaping dead claims has to actually work.

## The planner does not gate its own plan, and a human sees it before the gate runs

`plan-epic` writes an epic's plan; `check-epic-plan` decides whether that plan is clean enough for
its children to become buildable. They are two skills for the same reason build and review are: the
author of a plan is the worst judge of whether it is complete
([ADR 0047](../../../.decisions/0047-review-plan-gate.md)). The gate is deterministic and
structural, and it enforces itself through state rather than advice — a child that has not passed is
labelled in a way that makes it unpickable, so "an unverified child got built" is not a thing that
can happen rather than a thing discouraged.

The human checkpoint sits between them, and it is not redundant with the gate. The gate is fourteen
structural defect classes; not one of them reads product intent. So an agent could write the user
stories, satisfy every structural rule, and produce a clean plan for the wrong product. The founder
approves the plan before the gate runs, and every epic is grilled while it is being planned rather
than after ([ADR 0289](../../../.decisions/0289-founder-approves-every-epic-plan.md)) — asking after
the plan is written turns an answer into a re-plan.

## An epic run produces one pull request, because the repair loop is what costs money

An epic has many children. The shape that looks obvious is one pull request per child: each is
independently reviewable and independently mergeable. fabrika ran that shape and moved off it.

Two things broke. Nothing ever looked at the epic as a whole — two children could each pass their
own gate and contradict each other — and every failed review round cost a push, a CI run and a
board write, on work that had not been accepted yet.

Now an epic run is one branch and one pull request. Children land as commits on it, each child's
review judges its own commit range locally, and the machine ends in one review of the whole pull
request before the single merge. The inner loop is the cheap one and it never leaves the machine;
the outer review looks for coherence rather than re-running correctness that already has a verdict.
[ADR 0285](../../../.decisions/0285-epic-machine-ends-in-review.md) rules the shape and
[ADR 0290](../../../.decisions/0290-retire-epic-conduction-onto-lane-machines.md) records the engine
it replaced, with the founder's rationale on
[#5800](https://github.com/kamp-us/phoenix/issues/5800). Single-issue lanes are untouched: one issue,
one pull request.

The guarantee is a state in the machine rather than a step a skill is trusted to perform. A
convention written in prose gets skipped by an agent that forgot, and does not show up in the lane's
status.

## fabrika calls nothing outside fabrika, and the old pipeline stays frozen beside it

No fabrika skill and no fabrika verb runs any code from the v1 pipeline it replaced
([ADR 0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Where v1 already
solved part of a problem, a fabrika session reads that code to learn how it behaves and what it got
wrong, then writes fabrika's own version. That is duplicated work, knowingly paid for: a dependency
edge into v1 is the thing that makes deleting v1 impossible later, and the whole point of the
rewrite was to be able to delete it.

The rule is about **calls**, and the distinction matters more than it sounds.
[ADR 0251](../../../.decisions/0251-shared-formats-are-pinned-not-reimplemented.md) carves out
byte-level formats: when two programs meet on a GitHub artifact, that format is not a call, it is a
contract, and fabrika owns it. The other side conforms by pinning fabrika's golden fixture in its
own test — a file read, not an import — so the dependency direction points *away* from fabrika and
a v1 that goes away takes its own conformance test with it. Two hand-copied copies of a format drift
silently; one fixture reds on whichever side reworded it.

The one deferral that stays sanctioned is a CI gate. Where a gate is already the authority on its
own question, fabrika expects that gate's answer and computes no second verdict.

Beside all of it, v1 stays frozen rather than cleaned up. Its retirement keeps the plugin
suppression in place ([ADR 0277](../../../.decisions/0277-v1-retirement-keeps-the-plugin-suppression.md)),
and the two skill rosters keep separate namespaces so nothing resolves ambiguously
([ADR 0255](../../../.decisions/0255-skill-namespaces-keep-v1-and-fabrika-apart.md)). Tidying a dead
system is work that buys nothing and risks reviving a dependency the cut exists to prevent.
