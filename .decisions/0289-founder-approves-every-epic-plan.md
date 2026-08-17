---
id: 0289
title: Every epic plan is grilled and founder-approved before the gate runs
status: accepted
date: 2026-08-16
tags: [fabrika, pipeline, epics, plan-epic, check-epic-plan, governance]
---

# 0289 — Every epic plan is grilled and founder-approved before the gate runs

**What this decides:** an epic's plan stops for a human between `plan-epic` ending `PLANNED` and
`check-epic-plan` running. The stop is a digest-bound approval marker on the epic, written through a
verb by a human on `@kamp-us/control-plane`. Without it the gate refuses to run on a named exit. And
every epic gets a grilling session while it is being planned — even a one-question one.

## Context

The epic path is triage → `plan-epic` → `check-epic-plan` → build, and every step is agent-run. The
founder raised on 2026-08-16 that he loses track of what is being built in his own product
([#5836](https://github.com/kamp-us/phoenix/issues/5836)).

The gap is real in source, not just in feel.
[`plan-epic`](../claude-plugins/fabrika/skills/plan-epic/SKILL.md) ends `PLANNED` with the plan in
the epic body and children minted `status:planned`; its `PLANNER-NEVER-FLIPS` anchor says it writes
no `status:triaged`. [`check-epic-plan`](../claude-plugins/fabrika/skills/check-epic-plan/SKILL.md)
then runs `plan check` and, on a clean floor, runs `plan flip`, which is "unconditional over every
`status:planned` child and not yours to narrow" (§3). There is no human precondition anywhere
between the two.

The floor is entirely structural.
[`packages/fabrika-cli/src/plan/defects.ts`](../packages/fabrika-cli/src/plan/defects.ts) is thirteen
classes — sections, story grammar, topology, labels, assignee slots. Not one of them reads product
intent, and not one reads a human signal. So `plan-epic`'s "the product layer leads" rule is
satisfied by an *agent* writing the user stories. That is the whole defect: the rule names a layer,
not an author, and [0078](0078-product-driven-decisions-by-default.md) says product decisions are
the founder's by default.

The founder's ruling on #5836 settled the two open halves. The checkpoint exists. And grilling is
**not** opt-in for big or fuzzy epics — every epic gets one, even if it is one or two questions.

## Decision

**No epic plan reaches the gate without a grilling session and a founder approval marker.**

### The grilling happens during planning

`plan-epic` runs its grill before it writes the plan into the epic body — while the plan is still
cheap to change. Minimum one to two questions; there is no size or fog threshold and no opt-out. The
questions and the answers are posted as comments on the epic issue, which is where anyone reading
the epic later already looks. A grill that lives only in a session transcript did not happen.

Grilling before the write is the point. Asking after the body is written turns an answer into a
re-plan.

### The approval is a digest-bound marker, written by a verb

The approval is a marker comment on the epic, emitted by a `fabrika` verb, carrying the plan's
**scope digest**. That is the same discipline the gate already runs on: `plan check` prints a digest
over the ledger scope, and `plan flip` / `plan verdict` take it as `--digest` and recompute from a
fresh read, so "the gap between deciding and writing is closed by re-deciding, not by trusting a
cached decision"
([`packages/fabrika-cli/src/plan/digest.ts`](../packages/fabrika-cli/src/plan/digest.ts)).

The approval verb derives the digest itself from the epic as it then stands — it never takes one
from its caller. The gate then compares its own freshly derived digest against the marker's. Equal
is approved. Different means the plan moved after the founder read it, and that is **not** approved:
a re-plan does not inherit the old approval.

Honest limit, stated so nobody over-reads the binding: the digest covers the ledger scope — the
epic's stories, the topology, and each child's labels, acceptance-criteria count, stories and
containment. It does not cover the plan's prose summary. It binds exactly what the floor judges,
which is the right scope for a gate precondition, and it is not a signature over every word.

### Who may write it

A human on `@kamp-us/control-plane`, resolved from the ACL at write time, the same authority set
that already hard-gates control-plane merges
([0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)). No new authority
noun is coined here. An agent-authored marker is never an approval, for the same reason
agent-authored is not self-approval under 0135 — the verb refuses when the actor is not a human team
member.

### What the gate does without it

`check-epic-plan` **refuses to run** — fail-closed, before the floor, on its own named exit code,
ending at a new terminal `PLAN-UNAPPROVED`. Not a warning, not a caveat (caveats are advisory by
construction and no verb reads one back), and never folded into an existing code, so nothing reads
it as "defective plan" or "absent epic". A missing approval is a different fact from a bad plan and
gets its own answer.

Fail-closed matches [0092](0092-gates-fail-closed-on-zero-scope.md): a gate that cannot prove its
precondition refuses rather than guessing the permissive reading.

## Relationship to the stranding tickets

[#5440](https://github.com/kamp-us/phoenix/issues/5440) says `status:planned` is a dead-end state
with no scheduled exit, and [#5040](https://github.com/kamp-us/phoenix/issues/5040) is the live
instance — epic #4195's eleven children stuck there. A new hard block in front of the gate would add
a second way to strand an epic, so this record names its exits rather than leaving them implied.

**Three exits, all of them written on the epic:**

1. **Approve.** The marker lands, the gate runs, children flip. The normal path.
2. **Reject.** The founder says no in the grill thread and the epic goes back to `plan-epic` for a
   re-plan. The next plan gets its own approval; the old digest no longer matches, so a stale
   approval cannot carry a rewritten plan through.
3. **Park or close.** An epic nobody intends to approve is parked or closed explicitly, on the epic,
   with a reason.

**This is why it does not add an invisible strand.** #5440's actual complaint is not that work
waits — it is that `status:planned` conflates "awaiting gate" with "deliberately parked", so nobody
can count either honestly. The refusal here is the opposite: a machine-visible marker whose absence
is checkable on any epic, so "waiting on founder approval" becomes a state you can list, not an
inference from a label that means three things. What this record does **not** do is fix #5440 or
#5040 — they are the older, wider question of who owns the `status:planned` exit when the planning
seat is gone, and they stay open on their own terms.

## Relationship to the machine

[#5739](https://github.com/kamp-us/phoenix/issues/5739) would make the plan→gate hop lane-driven
instead of hand-sequenced. When it lands, **this checkpoint is a state in that machine** — an
approval state between the `plan` and `gate` states, with the missing-approval refusal as a named
park the operator routes, exactly like a plan or gate refusal. It is never an out-of-band pause a
lane cannot see. That is also why the artifact is a marker and not "the founder said yes somewhere":
a state machine can read a marker.

The two do not block each other. The marker is verb-written and verb-read, so the same artifact works
whether a driver hand-sequences the two skills today or a lane routes them tomorrow. #5739 changes
who calls the gate, not what the gate requires.

## Rejected alternatives

**A plain label on the epic.** Closest fit to the existing floor shape — `NEEDS_TRIAGE_LABEL` and
`HELD_CHILD_UNASSIGNED` prove a label check is a first-class floor input — and rejected anyway,
because a label carries no digest. An approval that survives an arbitrary rewrite of the plan is not
an approval of that plan, and a label is exactly that.

**A claim purpose.** Claims in `packages/fabrika-cli/src/build/` are lane locks with a nonce, held
for the length of a run. An approval that expires when a lane releases is not a governance artifact.

**Parsing a free-text founder comment.** Weakest of the three. It gives the gate a parser over
English, has no scope binding, and makes "did the founder approve" a question about phrasing.

**A size or fog threshold — only big epics stop.** Ruled out by the founder directly. A threshold
needs someone to judge size before the plan is read, which is the same inference problem one layer
up, and the cheap case is one question, so the exemption buys nothing.

**Blocking the flip instead of the gate.** Letting the floor run and refusing only at `plan flip`
would report a clean verdict on a plan no human approved. Refuse before the floor.

## Consequences

Easier: the founder sees every epic plan before anything becomes pickable, and he sees it while it is
still shapeable rather than after children exist. "Was this approved, and of what?" becomes a
checkable question with a digest attached. And the checkpoint gives #5739's machine a real state
where today there is a hand-off nobody records.

Harder: every epic now waits on a human, and the founder is the bottleneck by design — an epic
planned while he is asleep sits until he reads it. `plan-epic` grows a grilling step and gets slower.
`check-epic-plan` grows a precondition ahead of a floor that used to be the first thing it ran, plus
a new exit code and terminal. And a re-plan now costs a second approval, which is correct and is
still a cost.

The build is a separate issue — [#5843](https://github.com/kamp-us/phoenix/issues/5843) — naming the
surfaces this touches: `plan/defects.ts` and `plan/digest.ts` in `packages/fabrika-cli`, and both
skills. This record decides the shape and nothing else.

## Records

no vocabulary impact — checkpoint, scope digest, floor, gate and grilling session are all existing
fabrika vocabulary; nothing is coined here.

Sources: [#5836](https://github.com/kamp-us/phoenix/issues/5836) (the question and the founder's
[ruling](https://github.com/kamp-us/phoenix/issues/5836#issuecomment-5311415942)),
[#5440](https://github.com/kamp-us/phoenix/issues/5440) and
[#5040](https://github.com/kamp-us/phoenix/issues/5040) (the stranding tickets),
[#5739](https://github.com/kamp-us/phoenix/issues/5739) (the lane machine that will own the hop),
[`claude-plugins/fabrika/skills/plan-epic/SKILL.md`](../claude-plugins/fabrika/skills/plan-epic/SKILL.md),
[`claude-plugins/fabrika/skills/check-epic-plan/SKILL.md`](../claude-plugins/fabrika/skills/check-epic-plan/SKILL.md),
[`packages/fabrika-cli/src/plan/defects.ts`](../packages/fabrika-cli/src/plan/defects.ts),
[`packages/fabrika-cli/src/plan/digest.ts`](../packages/fabrika-cli/src/plan/digest.ts).
