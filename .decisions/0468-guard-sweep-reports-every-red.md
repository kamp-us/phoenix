---
id: 0468
title: build check's guard sweep runs every local-tree guard and shows every red one, never stopping at the first
status: accepted
date: 2026-10-04
tags: [fabrika, cli, pipeline, gates, build]
---

# 0468 — build check's guard sweep runs every local-tree guard and shows every red one, never stopping at the first

**What this decides:** one `fabrika build check` run shows every guard that is red, so a builder
does not fix one guard only to meet the next red on the following run.

## Context

ADR [0381](0381-local-tree-guards-run-in-build-check.md) has `fabrika build check` run every
local-tree guard on every surface and name each one in its answer. It does not say what the sweep
does after a guard reds. The code stops there: `sweepLocalTreeGuards` in
[`packages/fabrika-cli/src/build/check-verb.ts`](../packages/fabrika-cli/src/build/check-verb.ts)
returns on the first red, and the guards after it never run.

[#9639](https://github.com/kamp-us/phoenix/issues/9639) shows the cost. In an adopter repo
`catalog-guard` reds on dependencies the lane never touched, and every guard sorted after it reports
nothing either way. The builder cannot tell whether the tree has one red guard or five.

ADR [0465](0465-catalog-guard-is-config-gated.md) recorded the first ruling on that issue and listed
this question as not ruled. The founder answered it on the rulings desk on 2026-10-04
([ruling comment](https://github.com/kamp-us/phoenix/issues/9639#issuecomment-5983099465)). The
question, as the desk asked it:

> `fabrika build check` runs several guard checks and stops at the first red one today (#9639).
> Should it keep going and show every red guard in one run?

He picked "Yes, keep going". This record transcribes that answer, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). It fills a gap ADR 0381 left and
reverses nothing in it.

## Decision

**The guard sweep in `fabrika build check` runs every local-tree guard, and one run shows every
guard that is red.**

- **A red guard does not end the sweep.** Every member ADR 0381 puts in the local-tree set runs,
  whether or not an earlier one was red.
- **Every red guard is shown in that one run.** Each is named, as ADR 0381 already requires of a
  single red.

**Not ruled.** The ruling answers the one question above. These stay open, and the build settles
the first two:

- Whether the repo's own declared validators also run after a guard has gone red.
- How several red guards are laid out in the answer and on stderr.
- Whether `readme-guard` is covered by the `catalog-guard` config key
  ([#9639](https://github.com/kamp-us/phoenix/issues/9639)'s third criterion). Nobody asked the
  founder, and no ruling answers it. ADR 0465 says where that guard stands today.

**Binding constraints.**

- A red guard never hides the guards after it.
- A skip is still not a pass. ADR 0381's rule for a guard that refused holds for every guard the
  sweep now reaches.

## Consequences

An adopter repo with one whole-tree red sees its other guards in the same run. A builder with three
red guards fixes them in one round, not three.

A red run takes longer, because the sweep no longer stops early. A green run costs what it did.

The answer has to carry more than one red guard. That is a change to what the verb prints, so the
build updates the verb's help and contract with it.

## Records

The build work is [#10500](https://github.com/kamp-us/phoenix/issues/10500).

Sources: the ruling at
[#9639, comment 5983099465](https://github.com/kamp-us/phoenix/issues/9639#issuecomment-5983099465);
ADRs [0381](0381-local-tree-guards-run-in-build-check.md),
[0465](0465-catalog-guard-is-config-gated.md) and
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md);
[`packages/fabrika-cli/src/build/check-verb.ts`](../packages/fabrika-cli/src/build/check-verb.ts).
