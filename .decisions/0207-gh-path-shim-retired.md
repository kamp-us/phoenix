---
id: 0207
title: The gh PATH-shadowing shim is formally retired
status: accepted
date: 2026-07-24
tags: [pipeline, tooling]
---

# 0207 — The gh PATH-shadowing shim is formally retired

**What this decides:** We stop trying to intercept `gh` commands with a wrapper script placed
ahead of the real `gh` on PATH — the skills' `gh api` REST discipline plus the grep-lint is the
whole guard against GraphQL-breaking calls.

## Context

The kamp-us org's legacy Projects-classic integration breaks GraphQL issue/PR queries, so the
pipeline mandates `gh api` REST everywhere. As defense-in-depth, #743 added the `gh-phoenix`
shim: a `gh` wrapper installed first-on-PATH to shadow the real binary, routing reflexive
GraphQL-breaking verbs (`gh pr edit`, `gh project`, GraphQL-only `--json` fields) to REST, with
consumers rewired in #1003.

While fixing #2495 (PR #2507) it was grounded — docs plus empirical test on both the desktop
and web harnesses — that Claude Code applies `.claude/settings.json` `env` values **verbatim**,
never expanding `${VAR}`. The shim's delivery was an `env` PATH prepend of
`${CLAUDE_PROJECT_DIR}/packages/gh-phoenix/shim:…`, so the literal never resolved: the shim was
**inert from the day it was wired** (`command -v gh` always hit the system `gh`), and the entry
actively clobbered the inherited PATH with a partial literal. #2507 removed the broken `env`
block and added `settings-env-guard` to fail closed on any re-introduced unexpanded `${…}`;
#2508 then asked for either a harness-verified re-delivery mechanism or a grounded retirement.

Meanwhile the p0 packaging inline (#3802, commit 0f9a66b4 / PR #3805) deleted
`packages/gh-phoenix/` and folded its lint/router/resolve cores, bin, and `gh` shim into
`pipeline-cli` as the `gh-phoenix` tool — the PATH-shadowing install surface no longer exists
as a package.

## Decision

**The founder rules #2508 released: the gh PATH-shadowing shim is formally retired — no
re-delivery mechanism will be built.**

The grounding: the shim was inert for its entire wired lifetime, and the pipeline never missed
it — `gh api` REST discipline is mandated in every pipeline skill, and the `skill-gh-lint`
grep-lint (now `pipeline-cli gh-phoenix`) catches GraphQL-breaking usage in skill text. An
interception layer that was never actually intercepting, whose absence produced zero incidents,
is coverage theater; the discipline-plus-lint pair is deemed sufficient on the evidence.

**Binding constraints.**
- No first-on-PATH `gh` shadowing is rebuilt — not via `settings.json` `env` (impossible under
  verbatim semantics, and `settings-env-guard` reds it), not via hooks or any other delivery.
- `gh api` REST discipline in the skills + the `gh-phoenix` lint remain the guard; keep both.
- Reopen only on new evidence: a consumer repo demonstrably bleeding GraphQL errors despite the
  REST discipline (Pipeline Anywhere-era evidence, not this era's).

## Consequences

- One less delivery surface to maintain or debug — the #2508 investigation's open harness
  questions (operator-loop PATH injection, whether a `SessionStart` hook can persist PATH) are
  moot and stay unanswered by design.
- The GraphQL guard is now discipline-shaped, not mechanism-shaped: a subagent that ignores the
  skills' REST mandate is caught by the lint at authoring time or by the failing call at
  runtime, not silently rerouted. That trade is accepted — it is the state the pipeline has in
  fact always operated in.
- The `gh-phoenix` router core lives on inside `pipeline-cli` as an explicit opt-in tool, not a
  PATH ambush.

## Records

- Ruling: the founder, 2026-07-24 record-or-release grill, on #2508 (issue closed; this ADR is
  the durable record its acceptance criteria route the retire fork to).
- References #2508; grounding in #2495 / PR #2507; origin #743 / #1003; source inline #3802 /
  PR #3805.
- No vocabulary impact — this retires a mechanism over already-named concepts; nothing is
  coined or redefined.
