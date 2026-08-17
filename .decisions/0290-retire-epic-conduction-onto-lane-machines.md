---
id: 0290
title: the epic conductor is retired; an epic's children drive through operate on a lane machine
status: accepted
date: 2026-08-17
tags: [fabrika, pipeline, epic, lane]
---

# 0290 — the epic conductor is retired; an epic's children drive through operate on a lane machine

**What this decides:** fabrika has one epic engine, not two — the `build-epic` skill and the `epic`
verb group are deleted, and an epic is now driven by `operate` over the machine `lane emit` writes
from the epic's `## Dependencies` topology, with each child landing its own pull request.

## Context

`build-epic` conducted an epic into **one** pull request. One conductor held the plan and one
branch, forked a fresh subagent per commit, and trusted artifacts over any subagent's self-report.
It was backed by `packages/fabrika-cli/src/epic/` — twenty-seven files, eight verbs, its own
nonce-keyed `ledger.jsonl`, its own fold, and its own two circuit-breaker axes. ADR
[0242](0242-fabrika-skill-nouns-redefine-build-and-review.md) put the noun in the glossary.

Epic [#5680](https://github.com/kamp-us/phoenix/issues/5680) then rebuilt fabrika's engine as an
operator-driven state ledger on `@demlik/tea`: a stateless driver folding an append-only
`.fabrika/events.jsonl`, machines carrying control flow only, skills carrying all judgment. Phase 3
of that epic built `lane emit`, which reads an epic's dependency topology and writes a
phase-sequenced machine with one region per child. That gave fabrika a second way to run an epic,
and running two is worse than running either: two ledgers, two folds, two retry budgets, and a
planner that has to know which engine a reader means when it says "ledger".

The epic's own no-go decides the order: nothing is deleted before its replacement has carried real
work. So the retirement was gated on a proving run rather than on the argument above. Issue
[#5729](https://github.com/kamp-us/phoenix/issues/5729) drove epic
[#5492](https://github.com/kamp-us/phoenix/issues/5492) end to end on an emitted machine — six
spawns, all worktree-isolated, every route read off a leaf-state name and never off a label or a
type. One child went the whole distance, build → review → ship → merged. The run's gap list is the
evidence this decision rests on.

## Decision

**`build-epic` and the `epic` verb group are deleted; `operate` on a `lane emit` machine is
fabrika's only epic engine, and an epic's children land as their own pull requests.**

Removed: `claude-plugins/fabrika/skills/build-epic/`, `packages/fabrika-cli/src/epic/`, the group's
row in `src/registry.ts` and its seats in `src/exit-code-alignment.ts`, and the `slice-handoff` wire
format (`src/wire/slice-handoff.ts` and its registry entry) — the dispatch brief only a conductor
had anyone to hand.

Every surface that pointed a reader at the conductor now points at `operate` / `lane emit`, and a
surface that described conducting an epic into one PR says plainly that children land as their own
PRs. `packages/fabrika-cli/CHANGELOG.md` is release history and is left alone.

What replaces each capability, from the proving run's gap list:

| `build-epic` capability | Replacement |
|---|---|
| `epic open` refuses an unplanned epic | `lane emit`, over the same `build/dependencies.ts` parser and cycle walk — no second grammar |
| `epic next` — ask, never infer, the next action | `lane status`'s fold plus `operate`'s routing table; an unrecognised leaf name parks, never guesses |
| `epic record` — append-only run ledger | `lane transition` → `events.jsonl`, an invalid event refused unappended |
| `epic slice-diff` — judge the unpushed local commit | each child gets a full `review` at its pushed head, with CI |
| `epic verdict` — verdict bound to a commit SHA | `review`'s SHA-bound markers plus `build verdicts --pr`'s current-head fold |

Four capabilities have no replacement and are tracked rather than forgotten: the spawn brief
([#5751](https://github.com/kamp-us/phoenix/issues/5751)), commit proof from the git graph over a
spawn's self-report ([#5747](https://github.com/kamp-us/phoenix/issues/5747)), the second
circuit-breaker axis that separated a dead dispatch from a failing implementation
([#5750](https://github.com/kamp-us/phoenix/issues/5750)), and a status fold that reads the live
board as well as the ledger ([#5746](https://github.com/kamp-us/phoenix/issues/5746)). A fifth,
one reviewable unit per epic, is lost by design and filed at
[#5784](https://github.com/kamp-us/phoenix/issues/5784).

This amends ADR [0242](0242-fabrika-skill-nouns-redefine-build-and-review.md) in part: its list of
eight canonical skill nouns loses `build-epic`, and that glossary row is removed. Nothing else in
0242 changes — the `build` and `review` redefinitions and the `review-ui` disambiguation stand.

## Consequences

Easier: one engine, one ledger, one retry budget. A driver reads `lane status` and routes on a leaf
name whatever the work is, so a single issue and an epic drive identically and neither path can
drift from the other. A child's PR is reviewed against the child's own acceptance criteria at its
pushed head with CI, which the conductor's pre-push slice judgement could not do.

Harder: an epic no longer has one diff anybody can read end to end, and nothing above the children
judges the epic's coherence — that is #5784's question, open. The four tracked gaps above are real
today, not theoretical: the run that produced them parked, and one of its parks
([#5750](https://github.com/kamp-us/phoenix/issues/5750)) is exactly the missing dead-dispatch axis.
Retiring the conductor is a bet that fixing them on the lane layer is cheaper than keeping a second
engine alive to hold them, and it is reversible only by rebuilding, since the code is gone rather
than frozen.

No migration cost in flight: `.fabrika/` is gitignored and every conductor run is finished.
