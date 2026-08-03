# Issue #4902 — `status:needs-triage`, open

**Title:** Proposal: hoist a one-line §CP pre-flight into the EM crew def's lane-open step

**Author:** usirin

**Body:**

## Summary
A proposal to add one line to the engineering-manager crew agent definition. Nothing in the file is
wrong — I want the §CP question asked earlier in the loop than it is asked today.

## What I was doing
Reading the crew defs while chasing an unrelated dispatch bug, and noticing where in the loop the
control-plane question first comes up.

## What I observed
`claude-plugins/pipeline-crew/agents/crew-engineering-manager.md` handles the control plane in its
"§CP discipline — bank a control-plane PR until it is approved, then spawn the approval-aware
shipper" section, i.e. at ship/bank time. The earlier "Claim the resource before you open a lane"
section says nothing about it. The file does name the §CP path set once, earlier still, in its
spawn/tier paragraph ("cite it, never re-hard-code the list here"), but nothing at lane-open prompts
the engine to ask the question — the first step that acts on the answer is the banking one, after a
coder has already produced a PR.

## Why it matters
A §CP lane ends parked at a human either way, but if the engine knows at lane-open it can say so on
the issue and set expectations instead of surfacing the gate at the end.

## Pointers
- `claude-plugins/pipeline-crew/agents/crew-engineering-manager.md`
- `pipeline-cli control-plane-paths --paths` (registered in `packages/pipeline-cli/src/registry.ts`)

## Suggested next step (non-binding)
One sentence at the lane-open step pointing at the §CP path list, and a pointer down to the existing
banking section rather than a second copy of the rules.

<sub>Filed by an agent · session 4d18 · claude-opus-5</sub>
