---
id: 0180
title: Capture the real runtime artifact before coding — golden real-payload fixtures are a blocking gate
status: accepted
date: 2026-07-12
tags: [pipeline, testing, hooks, harness]
---

# 0180 — Capture the real runtime artifact before coding — golden real-payload fixtures are a blocking gate

## Context

A whole class of changes — Claude Code hooks, harness integrations, anything whose
contract is **defined by the runtime and only observable at execution** — had no
pre-merge validation seam. All three gates (`review-code`, `review-doc`, control-plane
approval) validate *code against an assumed spec*; none executes the real harness, so
none can catch "the documented contract is wrong." Green + PASS + approved shipped a
non-working change.

The motivating incident: [#2925](https://github.com/kamp-us/phoenix/pull/2925) shipped a
`WorktreeCreate` hook (`claude-plugins/kampus-pipeline/hooks/create-worktree.sh`) built to
an **inferred** payload contract — it required a `worktree_path` field and read a
`base_ref`, neither of which the harness emits. The real payload, captured live from a
running spawn, is `{ session_id, transcript_path, cwd, prompt_id, agent_type,
hook_event_name, name }`: it carries `name` + `cwd` and expects the hook to *construct*
the path as `<cwd>/.claude/worktrees/<name>`. The unit test passed because it asserted the
*assumed* (fabricated) shape. The hook fail-closed on **every** worktree spawn crew-wide.
The hook was built from a documented contract (via `claude-code-guide/docs`), and the docs
were incomplete on the payload shape — so "ground the claim in the docs" was not enough.
ADR [0178](0178-worktreecreate-hook-provisioning.md) codified the wrong assumption.

This is the founder ruling on issue [#2935](https://github.com/kamp-us/phoenix/issues/2935)
(conversation-authored per ADR [0075](0075-issueless-doc-pr-merge-seam.md); exempt from
report→triage). CLAUDE.md already requires "ground falsifiable claims about
platform/runtime/dependency behavior in source, not intuition." This ADR **sharpens** that
rule for runtime-*emitted* artifacts: for anything the runtime emits, "source" means a
**captured real sample**, because the docs themselves can be wrong or incomplete — as they
were for the `WorktreeCreate` payload.

## Decision

For anything **runtime-defined** — a harness hook payload, a platform event schema, any
contract the runtime emits and that is only observable at execution — the **captured real
artifact is the only ground truth**. Not the docs, not an agent's summary, not a
plausible-looking or inferred contract.

1. **Capture before coding.** You capture the real runtime artifact from an actual live
   spawn *before* writing code to any doc-defined contract. The captured artifact is
   committed as a **golden real-payload fixture**.
2. **Golden-fixture tests are blocking.** A hook/harness handler's test MUST run against
   its committed golden real-payload fixture, and that test **gates merge**. A handler with
   no captured-payload fixture test does not merge. Blocking, not advisory — an advisory
   warning would not have stopped #2925.
3. **Rejected alternatives.** A CI smoke-spawn (candidate (b)) is infeasible — CI runners
   don't run the harness that emits `WorktreeCreate`. A manual pre-merge probe (candidate
   (c)) doesn't scale. The golden real-payload fixture is the mechanism.
4. **Repo-vs-harness line.** The **in-repo seam** is the handler's fixture-backed test
   (`create-worktree.hook.test.ts` and its peers): it asserts the handler against the
   committed real payload — this is §CP (`claude-plugins/kampus-pipeline/hooks/**`,
   human-merge-only at the control-plane bank). The **one-time payload capture** is a
   harness step: observing the real payload requires a live spawn against a harness the
   founder owns, out of repo (the #2440-class boundary). The repo asserts the captured
   shape; capturing it depends on the harness.

The implementing §CP build is [#2936](https://github.com/kamp-us/phoenix/issues/2936)
(the golden real-payload fixture seam + retrofitting `create-worktree.hook.test.ts` to the
real payload so it would have caught #2925). This ADR is the law it implements.

## Consequences

- **New blocking bar.** Any hook/harness handler change now requires a committed golden
  real-payload fixture and a test asserting the handler against it before it can merge. No
  runtime-contract-defined change ships validated only against a doc-assumed or inferred
  spec.
- **Extends, doesn't replace, the CLAUDE.md ground-in-source rule.** For runtime-emitted
  artifacts specifically, "source" is now a captured real sample, not the docs — because
  the docs can be wrong (they were for `WorktreeCreate`).
- **A capture step precedes coding.** Building a handler now has an ordering constraint:
  capture the real artifact first, code second. This adds a one-time capture cost per new
  runtime event, paid by whoever owns the harness spawn.
- **Closes the false-confidence gap.** The three existing gates keep validating code
  against a spec; the golden fixture makes the spec *real*, so green + PASS + approved no
  longer means "spec might be fabricated." This ADR declares a **blocking** gate, so it is
  §CP-by-content and merges only with control-plane approval.
- `create-worktree.hook.test.ts` currently asserts a fabricated `worktree_path` payload;
  #2936 retrofits it to the real `{ cwd, name, agent_type, hook_event_name, session_id,
  transcript_path, prompt_id }` shape.
