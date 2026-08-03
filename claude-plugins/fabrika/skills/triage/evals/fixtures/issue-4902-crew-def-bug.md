# Issue #4902 — `status:needs-triage`, open

**Title:** engineering-manager crew def tells the EM to spawn a planner, which contradicts the tiering ruling

**Author:** usirin

**Body:**

## Summary
The engineering-manager crew agent definition still instructs the EM to spawn a planner subagent for
epics. Epic planning was moved to the triage seat, so this line sends the EM down a path that was
ruled out.

## What I was doing
Reading the crew defs while chasing an unrelated dispatch bug.

## What I observed
`claude-plugins/pipeline-crew/agents/crew-engineering-manager.md` carries a line telling the EM to
spawn a planner for a `type:epic`. The tiering ruling puts planning on the triage seat instead. The
two disagree, and the crew def is the one an EM actually reads at dispatch time.

## Why it matters
An EM following the def spawns a planner that should not exist, and the epic gets planned twice or
in the wrong seat. Cheap to fix, but it is a live contradiction in a file that drives behaviour.

## Pointers
- `claude-plugins/pipeline-crew/agents/crew-engineering-manager.md`

## Suggested next step (non-binding)
Delete the planner-spawn line and point at the triage seat instead.

<sub>Filed by an agent · session 4d18 · claude-opus-5</sub>
