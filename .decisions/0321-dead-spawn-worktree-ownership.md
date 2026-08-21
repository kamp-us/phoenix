---
id: 0321
title: The driver retires a dead spawn's worktree, salvaging its dirty work onto the branch first
status: accepted
date: 2026-08-21
tags: [fabrika, pipeline-hardening, worktree, isolation]
---

# 0321 — The driver retires a dead spawn's worktree, salvaging its dirty work onto the branch first

**What this decides:** when a spawned shell dies, the session holding the primary checkout owns the
worktree it left behind — commit anything dirty in that tree to the dead spawn's branch as a WIP
commit, then `git worktree remove` without `--force`. A remove that still refuses is an incident to
file, never a force.

## Context

The dead-spawn residue obligations in
[`operate`](../claude-plugins/fabrika/skills/operate/SKILL.md) step 3 named three things — read the
dead spawn's final message, file the incident it could not file, release the claim it stranded — and
none of them named the tree. ADR [0215](0215-claim-identity-continuity-proof.md) governs claim
identity, and ADR [0295](0295-board-attested-claim-succession.md) governs who inherits a claim; a
worktree is neither.

That gap is not inert. A registered worktree still holding a lane's build branch checked out is
enough to refuse the next repair round's `build branch --resume-lane`, which proves the branch is
held before it re-keys and stops on exit `11`
([#6674](https://github.com/kamp-us/phoenix/issues/6674),
[#6679](https://github.com/kamp-us/phoenix/issues/6679)). So the lane parks on a tree nobody owns.

The actor charged with clearing the residue is also the one least able to touch it. `operate` step 3
mandates `isolation: worktree` for every spawn, and a worktree-isolated agent could not reach into
another worktree when this was tried live on
[#6614](https://github.com/kamp-us/phoenix/issues/6614). **That is a harness behaviour observed once,
not a rule this repository enforces — no code here implements it**, and ADR
[0199](0199-worktree-isolation-identity-is-derived-not-inherited.md) decides how a worktree-isolated
agent derives its own identity, not what it may reach. The observation is why the obligation lands on
the primary-shell driver rather than the operator shell.

[#6681](https://github.com/kamp-us/phoenix/issues/6681) put three options to the founder: this one, an
isolation exception letting a worktree agent read the other tree, and a read-only verb reporting the
tree's state. The founder ruled the first, with salvage:
[the ruling comment](https://github.com/kamp-us/phoenix/issues/6681#issuecomment-5361617276).

## Decision

**A dead spawn's worktree is the driver's to retire — the driver being the session holding the
primary checkout — as a fourth residue obligation, taken after the stranded claim is released.**

The obligation is two steps in this order:

1. **Salvage.** If the tree is dirty, commit its contents to the dead spawn's own branch as a WIP
   commit. The uncommitted work in that tree is the only copy of what the dying spawn was doing, and
   a removal that drops it destroys the record the successor lane needs.
2. **Remove.** `git worktree remove` on the salvaged tree, **without `--force`**. A remove that still
   refuses after salvage means something in that tree is unaccounted for, which is an incident to
   file through [`report`](../claude-plugins/fabrika/skills/report/SKILL.md) — never a `--force`
   that spends the answer.

The order is load-bearing on both ends: the release comes first because the claim, not the tree, is
what strands the next lane's claim; the salvage comes before the remove because after the remove
there is nothing left to salvage.

**Binding constraints.**

- Only the primary-checkout session takes this obligation. An operator shell running under
  `isolation: worktree` does not, on the #6614 observation above.
- No `git worktree remove --force`, on any path, for any tree.
- No eviction of a *claim* follows from a removed tree. ADR 0215 §5's ban on inferring a claim's end
  from absence stands unchanged: the claim ends through `build release` (or through 0295's adopt-then-release),
  and retiring the tree afterwards says nothing about it.

## Consequences

- `operate` step 3 carries four obligations, and its lead-in states four.
- A parked lane whose branch a dead tree held is unblockable by a driver acting alone, which is what
  [#6674](https://github.com/kamp-us/phoenix/issues/6674)'s routable refusal was missing.
- Salvage costs one WIP commit on a lane branch that a repair round will rebuild over anyway. That
  commit is cheap and reversible; the work it preserves is not.
- The isolation premise this rests on is one live observation, not enforced code. If the harness
  changes and a worktree-isolated agent can reach another tree, the ownership can move to the
  operator shell without disturbing the salvage-then-remove rule, which is the part the ruling was
  actually about.

## Records

no vocabulary impact
