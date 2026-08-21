---
id: 0323
title: A verb retires an orphaned build worktree on a board-attested license, and a lane frees its own branch at its terminal
status: accepted
date: 2026-08-21
tags: [fabrika, pipeline-hardening, worktree, isolation]
---

# 0323 — A verb retires an orphaned build worktree on a board-attested license, and a lane frees its own branch at its terminal

**What this decides:** `fabrika build retire <n>` takes back the checkout a registered worktree is
holding on `#n`'s lane branch, licensed by a written positive board state and never by a tree looking
idle. The two licenses are the ticket reaching a terminal state, and an ADR
[0295](0295-board-attested-claim-succession.md) adopt marker naming the session whose claim carries
that branch's lane nonce. **Dirtiness is not a refusal condition**, and it costs nobody their only
copy: ADR [0321](0321-dead-spawn-worktree-ownership.md)'s salvage runs first. As a complement,
`build release` detaches its own tree's HEAD when that tree is standing on the released lane's
branch, so a lane that ends normally never forms the pin at all.

## Context

A build lane's worktree outlives the session that registered it. While it stays registered it holds
that lane's branch checked out, and `build branch --resume-lane` refuses on exit `11` rather than
re-key the branch out from under a live checkout — a refusal that is correct, because `git branch -m`
does not refuse there, it renames and silently retargets that worktree's `HEAD`
(`packages/fabrika-cli/src/build/git.ts`, measured against git 2.40.1 on #6386).

No actor inside the loop could clear the residue, so every such round ended as a human park on a
cleanup carrying no judgment. Both phase-1 children of epic #5843 (#6566, #6567) parked on it in a
single drive, and #6684, #6687 and #6651 then showed it is not only a killed session's leak: those
builders reported `BUILT-NO-PR` and released their claims, and still left the tree holding the
branch. The park's routing half already existed — `recipe/parks.ts` carries the `blocked` +
`worktree-holds-branch` row — but its clearance only *read* whether a tree still held the branch, so
`recipe unpark` sat at exit `13` until a human ran `git worktree remove`.

The founder ruled on
[#6610](https://github.com/kamp-us/phoenix/issues/6610#issuecomment-5360396072): option 2 (a verb
retires), with option 1 (a lane releases its own at its terminal) as a cheap complement, and the
release proof is the worktree's ticket state rather than dirtiness — because agents routinely leave a
worktree dirty *after* its ticket merged, so "dirty" is a false negative for "work in progress" and
reading it keeps the deadlock in the case that most needs clearing.

## Decision

### 1. Two licenses, both written positive board states

`build retire <n>` releases a worktree holding `#n`'s lane branch when either holds:

- **`ticket-terminal`** — the number is terminal on the board: a closed issue, or a **merged** pull
  request. A PR closed unmerged is not terminal, because it can be reopened onto the same head.
- **`session-adopted`** — an authorized ADR 0295 `build-adopt` marker on `#n` names the session that
  took the claim whose token carries this branch's lane nonce. That is the only link from a branch
  name back to a session, and it is read through `readClaimants`, so the ACL answers authority
  (ADR [0055](0055-acl-sourced-review-authz.md)) exactly as it does for a claim.

No new attestation format is minted. The adopt marker already proves succession, and the ticket's
state is the board's own.

### 2. Dirtiness is not an input, and ADR 0321's salvage is why that is safe

The predicate takes no dirtiness argument at all, which makes reading one unrepresentable rather than
merely unused. What keeps that from destroying a dying spawn's only copy is that ADR 0321's order
runs first on every released tree: commit whatever the tree holds uncommitted onto its own branch,
**then** `git worktree remove` — **without `--force`**, which 0321 bans on every path for every tree.
A removal that still refuses is reported as an incident to file, never overridden. The recurring
instance is a *locked* tree, which refuses however clean it is; the agent harness locks the trees it
registers, so that refusal is named in full and left to a human
([#6881](https://github.com/kamp-us/phoenix/issues/6881)).

The two rulings are therefore one act, not a conflict: #6610 says a dirty tree is still retired, and
0321 says its work is preserved first. A detached-HEAD tree, whose salvage arm 0321 leaves undefined
(#6868), never reaches this verb at all: it holds no branch name, so it is no lane's pin and appears
in no subject list.

### 3. Releasing a git registration is outside ADR 0215 §5

**It does not fall inside §5's ban on eviction by inference, because it evicts no claim.** §5
enumerates how a *claim* ends and bans inferring that ending from absence. A worktree registration is
not a claim: it confers no ownership of a number, no verb resolves ownership against it, and removing
one changes nothing about who holds `#n`. ADR 0321 already states the converse — no eviction of a
claim follows from a removed tree — and this record states the direction it left open: no eviction of
a *tree* is an eviction of a claim either.

So no widening of §5 is taken and none is needed, and the adversarial read 0295 earned is not owed
here. What §5's *posture* does bind, and what this decision keeps, is the evidentiary rule: both
licenses are written positive statements on the board. A tree that merely looks idle, a session that
has not been heard from, an old registration — none of those license anything. That is the whole
reason the predicate reads the ticket and the adopt marker rather than the tree.

### 4. The verb belongs to the `build` group

`build retire`, beside `adopt` and `release`. It reads that group's claim markers, that group's lane
branch grammar, and clears that group's residue; a `lane` verb would have to import all three to ask
a question about a build lane.

### 5. The falsifiable question, answered by running it

**A worktree-isolated caller can invoke this verb, and the verb's own git reaches the other tree.**
Measured on #6610 from inside `.claude/worktrees/agent-a91911776626b3a79`, against git 2.40.1:

- A **typed** `git -C <another worktree> …` is refused by the harness before it runs.
- A typed `git worktree remove <another worktree>` is **not** refused — it runs, and git's own
  answer comes back (dirty refused; `--force` overrode; a locked tree needed `-f -f`; the branch
  survived every removal).
- A **node child process** running `git -C <another worktree> status` succeeds.

The harness rule reads the typed command, so it binds a shell and not a verb's child process. That
retires the premise ADR 0321 rested its actor choice on, and 0321 named this exact case: "if the
harness changes and a worktree-isolated agent can reach another tree, the ownership can move …
without disturbing the salvage-then-remove rule, which is the part the ruling was actually about."
**This record therefore amends ADR 0321's first binding constraint in part** — the obligation is a
verb's, invocable from any shell, primary or isolated — and leaves the rest of 0321 untouched:
salvage before remove, no `--force` on any path, no claim eviction inferred from a removed tree.

### 6. The complement, and the routing

- `build release` detaches its own tree's HEAD when that tree stands on the released lane's branch.
  The commit is unchanged and uncommitted work carries over, so a lane may do it at any terminal —
  `BUILT-NO-PR` included — without deciding anything about what is still in the tree. A failed
  detach is reported and never fatal: the claim is already retracted by then.
- The `blocked` + `worktree-holds-branch` recipe row now names its remedy, and `recipe unpark` runs
  it before re-reading. A park whose only cause is a stale registration clears without a human.

**Banned.**

- Reading dirtiness, staleness, mtime, or any property of the tree itself as a license.
- Removing the tree the run is standing in.
- Reporting a removal that was not read back off a second `git worktree list`.
- `git worktree remove --force`, on any path, for any tree (ADR 0321, unchanged).

## Consequences

- The `build` group grows one verb and one exit code, `33` (`WORKTREE_HELD`): a tree holds the branch
  and the board licenses no release. It is proven, never `11`.
- `build release`'s answer gains a `freed` field, so a caller can tell a lane that let go of its
  branch from one that never held it.
- A locked worktree still needs a human, because 0321's `--force` ban outranks the convenience.
  [#6881](https://github.com/kamp-us/phoenix/issues/6881) carries that gap to the founder rather than
  this ADR resolving it by widening a constraint a day-old ruling wrote.
- ADR 0321's actor constraint is amended in part, on 0321's own stated terms; its status line records
  it, per the accepted-ADR immutability rule.

## Alternatives considered

- **Refuse on a dirty tree.** The founder's ruling rejects it by name: dirty is a false negative for
  work in progress, and refusing keeps the deadlock exactly where it hurts.
- **A TTL, an mtime, or "the session has not been heard from".** Banned by ADR 0215 §5's posture and
  by 0295's restatement of it. Every one of them is an inference from absence.
- **A new attestation format for "this session is gone".** The adopt marker already is one, and a
  second would give the same fact two spellings that can disagree.
- **Leave the obligation with the primary-checkout driver (ADR 0321 as written).** Its premise was one
  live observation, and the observation does not hold for a verb. Keeping it would price every
  stale registration at a human hop the tooling can now take.

## Records

no vocabulary impact
