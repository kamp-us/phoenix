# Plan-format enrichment proposals

Three **proposed** additions to the sub-issue task format the pipeline already uses —
salvaged from the closed [`writing-plans` import survey (#3371)](https://github.com/kamp-us/phoenix/issues/3371),
which **skipped** [joshuadavidthomas/agent-skills](https://github.com/joshuadavidthomas/agent-skills)'
`writing-plans` skill (it stands up a rival file-based plan substrate under `docs/plans/`
beside the GitHub issue-ledger the whole pipeline already reads) and named exactly this
salvage: **per-step verify commands**, **out-of-scope lists**, and **STOP conditions** as
enrichments to the *existing* plan format.

This is a **proposal doc, not an active convention.** It does not change the plan format
or any gate. The canonical task format is owned by two §CP (control-plane) surfaces —
`plan-epic`'s Step 3 sub-issue template and the shared **§2 Sub-issue body format** in
`gh-issue-intake-formats.md` — which flip a touching PR to human-merge. Landing these
enrichments there is a deliberate control-plane change; this doc captures the shape they'd
take so that decision can be made against a concrete proposal rather than re-derived from
the closed #3371 thread. Out of scope: rewriting the whole plan format.

## Where they fit in today's format

A sub-issue body today carries `**Stories:**` / `**TDD:**` / `**Containment:**` fields, a
`### What to build` prose spec, and a `### Acceptance criteria` checklist. The `write-code`
executor reads *What to build* as the scope and *Acceptance criteria* as the contract
`review-code` verifies. Two gaps the #3371 salvage targets:

- The AC checklist says **whether** a task is done, but not **how a headless agent proves
  each box** — the executor invents a verification per criterion, and the reviewer re-invents
  it. A per-step verify command makes the proof executable and shared.
- *What to build* says "state what's out of scope if there's a tempting adjacent thing" as a
  prose aside — easy to omit, and buried mid-paragraph where a skimming executor misses it. A
  first-class list makes the boundary loud.
- Nothing tells an autonomous executor **when to stop and escalate** rather than push through
  a wrong assumption. A STOP condition is the halt-and-ask tripwire the no-eyeball drain lacks.

## Proposal 1 — Per-step verify commands

Attach a concrete, runnable verification to each acceptance criterion (or to the task as a
whole): the exact command a headless executor or reviewer runs to prove the box is checked,
without reading the implementer's mind. This complements the AC checklist — the criterion
states the observable outcome, the verify command is the shared proof of it.

The verify command must be **copy-pasteable and repo-root-relative** — a `pnpm`/`node`/`gh`
invocation, never a local path, a hand-wave ("check the UI"), or an interactive step. When a
criterion genuinely can't be machine-verified (a visual/design judgment), say so explicitly
rather than fabricate a command.

Proposed shape — a trailing note on the AC line, or a paired `### Verify` block:

```markdown
### Acceptance criteria
- [ ] The `foo-guard check` fails closed on an unclassified entry.
- [ ] Every workspace package carries a README.

### Verify
- `pnpm --filter @kampus/foo test` — the fail-closed case is green.
- `node packages/pipeline-cli/src/bin.ts readme-guard check` — exits 0.
```

Why per-step and not one plan-wide command: a tracer-bullet child spans layers (storage →
service → fate → UI → tests); a single end-to-end command hides *which* layer regressed. One
verify per criterion localizes the failure to the box it proves.

## Proposal 2 — Out-of-scope lists

Promote the "what's out of scope" aside from a buried sentence in *What to build* to a
first-class `### Out of scope` list on the child. It names the tempting-adjacent work this
task deliberately does **not** do — the refactor next door, the extra case, the polish — so
the executor doesn't scope-creep and the reviewer doesn't fail the PR for an omission that
was never in scope.

This is the child-level complement of the epic plan's `### Goal / non-goals` (Step 2): the
epic states the campaign's non-goals; the child states *this slice's* boundary against its
siblings. It also feeds `review-code` a shared boundary — an appended AC (ADR 0079) should
not name work the child explicitly scoped out.

```markdown
### Out of scope
- Migrating the other three callers — this task wires only the first (tracer bullet).
- Backfilling historical rows — a separate chore if wanted.
```

Keep it to genuine tempting-adjacent items. An empty or ceremonial list is noise; omit the
section when the `### What to build` boundary is already unambiguous.

## Proposal 3 — STOP conditions

A `### Stop conditions` list names the situations in which the executing agent must **halt
and escalate** (via `report` → triage, or a progress comment surfacing the blocker) instead
of guessing forward. It is the autonomous-drain tripwire: the no-eyeball loop ships product
PRs on green with no human in the loop, so the plan itself must encode the "this needs a
human/decision" boundary the executor would otherwise plow past.

STOP conditions are distinct from a blocked dependency (that's the `## Dependencies`
topology, resolved *before* pickup). A STOP condition fires **mid-task**, on a discovery the
plan couldn't predict: a hidden product decision, a required migration the plan didn't
budget, an assumption proven false by the live code.

```markdown
### Stop conditions
- The entity needs a schema migration not named in this task → STOP, file a report, do not
  hand-author a migration off-plan.
- A user-facing copy string has no Turkish source → STOP, route the decision (the copy is
  product, not the implementer's to invent).
- The fate view this depends on doesn't exist yet → STOP, the dependency was mis-derived.
```

Each condition pairs a **trigger** (the discovery) with an **action** (halt + how to
escalate). A STOP without an escalation route is just a warning; the action is what makes it
load-bearing.

## If adopted — the §CP landing

Adopting any of these edits the two control-plane surfaces named above, so a PR that lands
them is human-merge (§CP), re-checked with `pipeline-cli control-plane-paths`. Suggested
minimal-surface adoption: add the three sections to the `plan-epic` Step 3 child template and
the `gh-issue-intake-formats.md` §2 shape as **optional** fields (a missing section reads as
"none", exactly like `**Containment:**` today), teach `write-code` to run a child's verify
commands as a self-check before opening its PR, and leave `review-code` free to append a
verify command alongside an appended AC (ADR 0079). None of that is done here — this doc only
proposes the shape.
