---
id: 0342
title: An unclaimed lane's worktree is retired on proof it carries nothing
status: accepted
date: 2026-08-31
tags: [fabrika, pipeline-hardening, worktree, isolation]
---

# 0342 — An unclaimed lane's worktree is retired on proof it carries nothing

**What this decides:** `fabrika build retire <n>` gains a third license, `lane-unclaimed`, for the
one case ADR [0323](0323-board-licensed-worktree-retirement.md)'s two leave stuck: no authorized
claim marker on `#n` carries the branch's lane nonce, so **no lane holds it**. With no board
statement to lean on, that arm alone reads the tree, and it reads it the way
`build reap` does — a tree goes only on positive proof that it carries nothing (clean, and its branch
level with `origin/main`), and every other case holds and names the count that blocked it.

## Context

A builder runner dies mid-build. Stale-run reconciliation marks the run failed, and the operator
does what [`operate`'s dead-spawn section](../claude-plugins/fabrika/skills/operate/SKILL.md) says:
`build release` retracts the claim the dead spawn stranded, then `build retire` takes back the
worktree it left. The second step could not run, because the first one made it impossible.

`build release` **deletes** the claim marker comments (`runRelease` in
`packages/fabrika-cli/src/build/claim-verb.ts`). ADR 0323's `session-adopted` license is the only
link from a branch name back to a session, and it runs through that marker's lane nonce — so once the
marker is gone, `classify` fell to its "no authorized claim marker carries this branch's lane nonce"
hold and `build retire` refused on exit `33`. On lane 6760 that left an inert worktree — clean tree,
branch carrying only base commits — that no sanctioned route could remove
([#7027](https://github.com/kamp-us/phoenix/issues/7027), with instances on 6760, 6767 and 6490 in a
single night). The two documented steps were ordered so that taking the first one closed the second,
and the residue then refuses the next repair round's `build branch --resume-lane` on exit `11`.

Waiting for the ticket to close is not an answer: the issue is open precisely because the build did
not finish. Adopting is not one either — `build adopt` records a succession for a claim, and there is
no claim left to succeed.

## Decision

### 1. A third license: `lane-unclaimed`

`classify` gains a fourth verdict, `Unclaimed`, for a subject whose lane nonce **no authorized claim
marker on the number carries**. That is not an inference from silence: a claim marker is what mints a
lane nonce in the first place, so its absence at a full read of the markers is the positive fact that
this lane was released. `readClaimants` answering `Unknown` still refuses on `11`, as everywhere
else — a read that failed proves nothing, and least of all that a lane is unheld.

The order matters and the type carries it: a nonce a live claim marker **does** carry holds on that
alone, ahead of anything about the tree. A lane that holds its claim owns its tree however empty the
tree looks, which is the eviction-by-inference ADR
[0215](0215-claim-identity-continuity-proof.md) §5 bans, and this ordering makes it unreachable
rather than merely unchosen.

### 2. That arm — and only that arm — reads what the tree carries

`seatResidue` releases an unclaimed subject on two positive proofs together: the tree holds nothing
uncommitted, and its branch carries no commit `origin/main` does not. Anything short of both holds,
and the refusal names each count, because the operator's next move differs per count — uncommitted
paths are committed or discarded in that tree, commits past the base are pushed or folded by whoever
owns them.

**This is `build reap`'s polarity, borrowed for the case that has `reap`'s evidence problem.**
`reap.ts` already states the split: a retirement is a targeted act against a number the board has
spoken about, so ADR 0323 rules the tree's contents out of it; a reap is a bulk act over trees nobody
named, so it has no board statement to lean on and reads the tree instead. An unclaimed lane is the
targeted act that turns out to have no board statement either, so it takes the evidence rule that
fits the evidence it has.

### 3. This does not weaken ADR 0323, and does not read dirtiness as a license

ADR 0323 bans "reading dirtiness, staleness, mtime, or any property of the tree itself **as a
license**". Nothing here licenses on a tree property: the license is the board read — no lane holds
this branch — and the tree read can only ever **withhold** it. The new arm therefore removes a strict
subset of what a license that ignored the tree would remove, and it reaches no tree either of ADR
0323's licenses reaches.

The founder's ruling against refusing on dirtiness stands untouched where it was made. It was about
the two board licenses, and its reason was specific: agents routinely leave a worktree dirty long
after its ticket merged, so on a **merged ticket** dirtiness is a false negative for work in progress
and refusing keeps the deadlock where it hurts. Neither half of that holds here — the ticket is open
and the build did not finish, so uncommitted work in the tree may well be exactly what it looks like.
A closed issue's dirty tree is still retired, unread, on the `ticket-terminal` license.

### 4. `build release` still deletes its markers

The alternative fix was to have `release` leave a "released" record behind, which would give the
retirement a written positive statement to read. It is rejected: a marker that outlives the claim is
a second spelling of ownership that can disagree with the first, which is the objection ADR 0323
raised against minting a new attestation format, and every claim reader in the group would have to
learn to skip it. The absence a full marker read establishes is enough, because the arm it opens can
remove nothing that carries anything.

**Banned.**

- Licensing a removal on a tree property. Both proofs in §2 are floors under a board-read license,
  never the license.
- Reaching the tree-read arm for a lane a live authorized claim marker still holds.
- Resolving an unreadable marker list, status, or commit count to the permissive answer. Each is
  `11`, and nothing is removed.
- Everything ADR 0321 and ADR 0323 already ban, unchanged: salvage before remove, no `--force` on any
  path, no removal reported without a read-back, no removal of the tree the run stands in.

## Consequences

- The operator's documented dead-spawn sequence composes: `build release` then `build retire <n>`
  clears both halves of the residue, in the order
  [`operate`'s SKILL](../claude-plugins/fabrika/skills/operate/SKILL.md) already gives them.
- `recipe unpark` clears more `worktree-holds-branch` parks without a human, since its remedy is this
  same verb and the park's commonest shape is a released claim over an inert tree.
- No new exit code. A tree the new arm holds is still `33`, and the refusal line names the counts.
- `build retire` runs one `git rev-list --count` per unclaimed subject and none for a subject either
  board license covers, so the two existing licenses gain no new way to fail.
- A branch cut from an epic assembly branch reads as carrying commits past `origin/main` and holds.
  That is the conservative direction and the right one: those commits are the child's only copy, and
  the epic driver owns folding them.

## Alternatives considered

- **Leave a "released" claim record for the retirement to read.** §3's answer: a second spelling of
  ownership that can disagree with the first.
- **Auto-release a claim when stale-run reconciliation marks its run failed.** That is eviction from
  a runner's absence, which ADR 0215 §5 bans outright, and it would evict a claim rather than a
  registration — the very distinction ADR 0323 §3 rests on.
- **Widen `build reap` to cover branch-holding trees instead.** `reap` sweeps by path prefix and
  answers about a population nobody named; #7027 asks about one number, which is `retire`'s subject
  and nobody else's.
- **Retire on the released claim alone, without reading the tree.** It would remove a tree whose
  uncommitted work is the only copy of a dying spawn's last round, on a ticket that is still open.
  ADR 0321's salvage would preserve it as a `wip:` commit, but on an open ticket the conservative
  floor is cheap and the deadlock it leaves is exactly the one an operator can clear by hand.

## Records

no vocabulary impact
