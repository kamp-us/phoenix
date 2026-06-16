---
id: 0046
title: plan-epic emits PRD-grade epic plans — product layer + user stories, enforced story coverage, tracer-bullet children, autonomous (harness stays out)
status: accepted
date: 2026-06-13
tags: [pipeline, skills, plan-epic, prd, process]
---

# 0046 — plan-epic Emits PRD-Grade Epic Plans — Product Layer, Story-Driven, Autonomous

## Context

The issue-intake pipeline (`report` → `triage` → `plan-epic` → `write-code` →
`review-code`) turns GitHub issues into agent-executable work. `plan-epic` already writes
a plan into the epic body, but in practice its output is **engineering-first**: Goal,
Non-goals, Resolved questions, Approach, Task-split rationale, and the `## Dependencies`
topology. It is thorough about *architecture* and silent about the *product*. A
representative backlog epic ([#41](https://github.com/kamp-us/phoenix/issues/41), künye,
~1,300 words) carries zero user stories and no testing strategy — which is exactly why
backlog epics read as "less detailed than a PRD."

The repo author maintains a separate, battle-tested PRD toolchain (a two-skill flow: PRD
authoring + PRD-to-tasks slicing), proven driving automated delivery at work. That
toolchain leads with the **product layer** — problem and solution from the user's
perspective, an extensive user-story list, testing decisions — and slices work as
**tracer-bullet vertical slices** mapped to those stories. But it is (a) **interactive**
(it interviews the human and iterates to approval) and (b) **coupled to a personal
harness** (an Obsidian vault, a project glossary, and an XState `workflow.json` consumed
by a standalone operator). None of that harness belongs in this repo, and the pipeline
must run **unattended**.

The gap is specific: plan-epic's plans skip the product layer (problem/solution from the
user's view, **user stories**, testing strategy) and slice by capability/layer rather than
by story.

## Decision

`plan-epic` produces **PRD-grade epic plans**: the plan it writes below the (untouched)
brief leads with a product layer, then the engineering layer.

1. **The epic-body plan carries these sections, product layer first:** Problem & who has
   it · What changes (the solution, user's POV) · **User stories** · Goal / non-goals ·
   Resolved questions · Approach · Testing strategy · Task-split rationale — then the
   `## Dependencies` topology. The product sections are adapted from the author's PRD
   template; the engineering sections plan-epic already had are kept.

2. **User stories live in the epic body and are the slicing input.** Numbered, extensive,
   covering happy-path, edge, error, and admin/moderation flows; actors include automated
   agents (kamp.us is a human-and-agent surface). Every sub-issue traces to ≥ 1 story via a
   **required** `**Stories:**` line.

3. **Story coverage is an enforced invariant.** Every user story is covered by ≥ 1
   sub-issue, and every sub-issue names the story numbers it implements or unblocks. An
   uncovered story is an unfinished plan; a child that traces to no story is scope creep —
   cut it, or justify it as pure enabling infra. This is the analogue of the PRD-to-tasks
   story-mapping discipline.

4. **Children are tracer-bullet vertical slices.** An implementation child cuts a thin path
   through the layers it touches (storage → service → fate → UI → tests), demoable on its
   own; prefer many thin slices over few thick ones. `type:decision` / `type:investigation`
   children are the exception — they produce a record (an ADR / a diagnosis), not a vertical
   slice, and map to the stories or forks they unblock. The ≥ 1-acceptance-criterion
   invariant per child is unchanged.

5. **plan-epic stays autonomous — no interview.** Unlike the author's interactive PRD
   skill, plan-epic does not interview a human or gate on approval. It authors the product
   layer from the brief + the existing product + codebase exploration + product judgment. A
   story that hinges on a genuine product decision it cannot ground becomes a
   `type:decision` child, **not** a handwave. The epic body is reviewable and re-plan
   reconciles it; the autonomous fleet is never blocked on a human.

6. **The personal harness is explicitly out of the repo.** plan-epic does **not** import
   the vault (`resolve-feature`, vault paths, grill logs), the project glossary
   (`terms.md` / `conventions.md` — phoenix uses `.decisions/`, `.patterns/`, `CLAUDE.md`),
   or the orchestration layer (`workflow.json`, the XState machine, the operator,
   per-task `maxRetries`, the `code` flag, `/do-work`, `/qa`). The `## Dependencies`
   Phase / `requires:` topology remains phoenix's dependency-graph equivalent; orchestration
   stays in the author's harness, per the established boundary that the workflow machine is
   not this repo's concern.

## Consequences

- **Easier:** epics carry the product context (who / why / stories) that makes the work
  legible and demoable; story coverage gives a checkable completeness bar; tracer-bullet
  children land end-to-end value per PR; the testing-strategy section sets honest per-child
  `TDD` flags grounded in the testing taxonomy.
- **Harder / new cost:** plan-epic does more product-judgment work up front, and authoring
  extensive stories without an interview leans on the planner's reading of the brief + the
  existing product. A thin or ambiguous brief surfaces as carved `type:decision` children
  rather than a quick plan — which is the honest outcome, not a regression.
- **Contract change:** the shared formats doc's sub-issue `**Stories:**` field flips from
  optional to **required**, and the epic-body plan gains a `### User stories` section that
  `**Stories:**` refs index into. `write-code` and `review-code` read stories as context;
  the acceptance-criteria checklist remains the verification spine.
- **Banned:** an epic plan with no user stories; a sub-issue with no `**Stories:**` trace
  (barring a justified pure-infra child); importing the vault / glossary / orchestrator
  harness into the repo skill; adding an interview or approval gate to plan-epic (it is
  autonomous).
- **Relationship:** extends the issue-intake pipeline convention; the testing-strategy
  section sits on ADR [0040](0040-testing-taxonomy-and-seam-graduation.md) (the T0–T3
  taxonomy and which tier a behavior is tested at). Supersedes nothing.
