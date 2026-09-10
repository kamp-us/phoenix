---
id: 0384
title: A retired lane does not re-open over its own work, and a spent budget returns only through a recorded grant
status: accepted
date: 2026-09-10
tags: [fabrika, lane, pipeline, governance]
---

# 0384 — A retired lane does not re-open over its own work, and a spent budget returns only through a recorded grant

**What this decides:** `lane open` refuses an issue-keyed boot when the board shows that issue was
already driven, the wrong-template retire stays the one retire a driver may take, and a spent repair
budget comes back only through a clearance recorded on the board.

## Context

Lane 7981 sat `frozen` at `retries: 2/2`. Instead of the one sanctioned exit, the live driver removed
`.fabrika/lanes/7981` and re-opened the lane. The rebuilt ledger came back at `retries: 0/2` holding
one `ISSUE.WIP` event: the spent budget was restored, nothing on the board recorded a granted round,
and a successor driver cannot tell that lane from a legitimate boot
([#8047](https://github.com/kamp-us/phoenix/issues/8047)).

The rule it walked around is written in three places and enforced in none of them at the boot end.
ADR [0297](0297-frozen-is-a-park-not-an-end.md) makes `frozen` a park whose door is a clearance;
`lane/clearance.ts` records a grant as an appended `<TASK>.CLEARED` event, so the budget is a fold
over recorded events and deleting the log deletes the spend with no counter-record of a grant; `lane
open` refuses exactly four things and never asked whether the issue it was booting had had a lane
before.

It had nowhere to ask, either. `.gitignore` line 65 is `/.fabrika/`, so once the directory is gone
there is no surviving record of the lane in the worktree or in git. `lane archive` is the one
sanctioned mover (ADR [0352](0352-an-unreplayable-lane-is-archived-not-sealed.md)) and
`.fabrika/lanes-archived/` held no 7981.

A blanket "never remove a live lane directory" would have broken a path the pipeline actively
instructs: `operate` step 1 tells a driver to retire a lane directory and re-run the boot when the
lane was booted on the wrong template, citing ADR
[0313](0313-a-queue-dwell-is-a-wait-not-a-park.md)'s 2026-08-20 amendment. So the direction had to be
picked before anything was built.

## Decision

The founder picked it on 2026-09-05
([the ruling comment](https://github.com/kamp-us/phoenix/issues/8047#issuecomment-5555101065)):
**shapes 2 and 1 together.**

1. **`lane open` refuses an issue-keyed boot when the board says that issue already had a lane**, on
   its own code — `63` `PRIOR_LANE` in `packages/fabrika-cli/src/lane/codes.ts`. It fires before
   anything is written and its message ends saying so, like every other refusal in that verb.
2. **The wrong-template retire stays sanctioned, and it is the only one.** `operate` step 1 now says
   that in so many words, so the instruction a driver reads is no longer general permission to retire
   a directory, and its exit table carries `63` as a `STOPPED`.
3. **A `frozen` lane's spent budget comes back only through a granted round recorded on the board** —
   `build clear` on the lane's pull request, or `lane clear` on a lane that has none (ADR
   [0378](0378-driver-seat-on-a-spent-repair-budget.md)). Never through retire-then-re-open.
4. **No durable trace of a retired lane is built.** Shape 3 — a committed record a boot could consult
   — is not rejected; it rides the ledger-provider decision parked elsewhere, and this record is not
   held for it.

### Why the fact is a pull request

Point 4 is what fixes the shape. With no durable on-disk trace, the prior-lane fact has to come off
the board, and the two markers a lane posts on its own issue cannot carry it: `lane claim` and `build
claim` each **delete** their comment on release, so a released claim proves nothing, and a standing
one is as likely to belong to the very drive that is booting. What survives a lane is what its builder
published — a pull request declaring it closes the issue, read off GitHub's own closing-issue edge.

That draws the line exactly where the ruling wants it. A wrong-template retire happens at the boot
step, before any builder is spawned, so the issue carries no such pull request and the boot passes. A
lane that reached `frozen` spent two repair rounds on a pull request, so it carries one and the
re-boot refuses.

The read is a **caller-passed reader** in the shape of `lane/expectation.ts`
(`lane/prior-lane.ts`), so `lane open` still boots provably offline when handed `null`, and a chore
lane — which drives no issue — is never asked. A read that cannot establish the fact answers
`Unknown` and the verb refuses `11` `LANE_UNREADABLE`; a failed read is never resolved to "no prior
lane", for the same reason `expectation.ts` refuses to read a failed read as "not an epic".

The reader is asked only when the lane directory is **absent**. A directory that is there is the
resume `14` `LANE_EXISTS` already names and `operate` step 1 already tolerates, and answering `63`
over it would stop a driver mid-drive on a fact that is not the one it needs.

## Consequences

- A first boot over an issue that already carries a closing pull request — work done outside a lane,
  or a lane whose directory is legitimately gone — is refused. That is fail-closed by design: the
  refusal names the pull request to drive and the door out of a spent budget, and a human decides.
  There is no override flag, because an override on the boot end is the bypass this record closes.
- A pull request that closed without landing is outside `pullsClosing`'s widest scope, so a lane whose
  only pull request was abandoned still reads fresh and still boots. Under-reading leaves that boot
  where it stands today rather than refusing on a fact nothing proved.
- The refusal costs one GraphQL read per issue-keyed boot over an absent directory, and none at all
  on a chore lane, a resume, or an offline boot.
