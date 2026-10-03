---
id: 0448
title: The worktree-create hook only provisions a worktree, never sweeps the others
status: accepted
date: 2026-10-03
tags: [fabrika, pipeline-hardening, worktree, isolation]
---

# 0448 — The worktree-create hook only provisions a worktree, never sweeps the others

**What this decides:** `hook worktree-create` no longer runs `build reap` before it creates a
worktree. `build reap` stays, as a verb someone runs on purpose.

## Context

ADR [0386](0386-worktree-accumulation-is-bounded-at-provisioning.md) section 2 ruled that whatever
creates a worktree reaps first. `hook worktree-create` ran `fabrika build reap --execute --limit 4`
as a child, before its fetch and its add, on every spawn.

That put a scan of every registered worktree in front of every spawn. On the operator clone on
2026-10-03, with about 520 trees registered and a load average of 13 to 17, one spawn took about four
minutes. The sweep's own 120-second bound covered the sweep child only; the fetch, the add and the
dependency install followed it. The sweep was working as built: `.fabrika/reap.jsonl` showed 3 or 4
removals on each run that day. The cost was the scan, paid by a spawn that asked for one tree.

The founder ruled on it the same day, recorded in
[this comment on #10342](https://github.com/kamp-us/phoenix/issues/10342#issuecomment-5973963206):

> "Why is worktreecreate hook taking 2+ minutes"

> "yes, nuke them but also we should not be running reap in worktreecreate, why are we doing that????"

Under ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md), this record writes that ruling
down.

## Decision

**`hook worktree-create` provisions the worktree its envelope names and runs no sweep of any other
worktree.**

The sweep call is deleted from the hook, with the limit, the timeout and the re-entry arguments that
only it used. It is not skipped behind a flag or an early return.

`build reap` is unchanged by this record. It keeps its arms, its proofs and its `--execute` and
`--limit` flags, and it runs when someone invokes it.

**What this amends in ADR 0386.** Section 2, "Reap before provision, not a schedule and not a cap",
no longer describes the hook: nothing sweeps at provisioning. Section 1 (both namings) and section 3
(pruning lives inside `build reap`) stand as written, and so does "What does not change".

ADR [0420](0420-worktree-creation-locks-installs-outside.md) mentions the sweep running before the
creation lock. Its ruling is the lock's scope, the fetch and the add, and that holds unchanged; there
is now simply no sweep before it.

**What this does not decide.** Where a sweep runs instead is not ruled. The end-of-lane cleanup in
[#10340](https://github.com/kamp-us/phoenix/issues/10340) is the obvious first home, and it is that
issue's to settle. ADR 0386 refused a scheduled chore lane and a hard cap on live trees; this record
does not reopen either refusal. The keep rule `build reap` applies is the rest of #10342 and gets its
own record.

**Binding constraints.**

- `hook worktree-create` starts no `build reap` child and calls no sweep in process.
- A spawn's wait in the hook does not grow with the number of worktrees a sweep would have to scan.

## Consequences

A spawn pays for its own fetch, add and install, and nothing else.

Until a new trigger lands, nothing automatic bounds how many worktrees accumulate. That is the state
ADR 0386 was written to end, so the disk can fill again if nobody runs `build reap`. The backlog on
the operator clone is being cleared by hand, and #10340 carries the forward fix.

The hook's stderr no longer carries a `reaped before provisioning` line.
