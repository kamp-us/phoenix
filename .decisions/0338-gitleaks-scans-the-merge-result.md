---
id: 0338
title: The secret gate scans the merge result, never the branch's commits
status: accepted
date: 2026-08-29
tags: [ci, gates, security, pipeline]
---

# 0338 — The secret gate scans the merge result, never the branch's commits

**What this decides:** the gitleaks CI gate reads the files a pull request adds or edits as they
stand at HEAD, so deleting a secret in a later commit clears the gate and no history rewrite is ever
required.

## Context

`.github/workflows/gitleaks.yml` scanned `gitleaks git . --log-opts="${mergebase}..HEAD"` — a walk
over the branch's commits. Once a commit carried a literal gitleaks dislikes, that commit stayed in
scope for the life of the pull request, so removing the literal at head changed nothing. The only
repair that cleared the gate was rewriting history, and the harness classifier denies an agent the
force-push that publishes one. A lane in that state spends its whole retry budget and then parks on
a person for a push that changes no content.

That is not hypothetical. PR #7229 on lane #7051 hit it: a made-up 32-character test constant, no
live credential, nothing to rotate, and the repair builder produced a squashed head whose tree was
byte-identical to the graded one and could not publish it. The cost was entirely process.

Two fixes were open, with different blast radii — narrow the scan, or open a sanctioned rewrite path
for the agent — and both loosen a security control, so the choice went to the founder rather than to
a builder's guess. The ruling is
[issue #7253, comment 5460774866](https://github.com/kamp-us/phoenix/issues/7253#issuecomment-5460774866):
scan the merge result, and open no rewrite path.

## Decision

**The gate scans the merge result's tree — the files `git diff --diff-filter=ACMR base...HEAD`
reports, read at HEAD — and never the branch's commit history.**

- The scan basis is the sibling gate's. `.github/workflows/leak-guard.yml` already resolves its base
  the same way on both triggers, and this gate now shares that shape: `github.base_ref` on
  `pull_request`, `github.event.merge_group.base_sha` on the merge queue's batched ref (ADR
  [0132](0132-merge-queue-for-base-freshness.md)), `fetch-depth: 0`, and a fail-closed refusal when
  the base or the merge-base will not resolve.
- **No agent history-rewrite path is opened.** `packages/fabrika-cli/src/build/push-verb.ts` keeps
  `--drop-remote-commits` and its exit-23 refusal exactly as they are, and no harness classifier
  policy changes. Whether an agent should ever reach a published-history rewrite stays unanswered,
  because this ruling makes the question moot for this gate.
- Full history stays out of scope, as before: the repo's history carries triaged findings from the
  issue #2325 baseline, and a real secret already in history is a rotation and remediation incident,
  never something this gate suppresses.

**Binding constraints.**

- The job's name stays the literal `scan PR commits for secrets`. It is the branch-protection
  required check the merge queue awaits (ADR 0132), so renaming it hangs every queued merge. The
  name no longer describes the scope and is kept for that wiring alone.
- Only exit `0` passes. A finding (`3`), a fatal scan (`1`), a panic (`2`), a bad invocation (`126`)
  and any other code each fail with their own `::error::` line. No finding is allowlisted to make
  the new scope work.
- A change set with no files surviving the diff filter is an explicit skip that prints its empty
  scope, not a silent pass — the not-applicable arm ADR
  [0092](0092-gates-fail-closed-on-zero-scope.md) requires, and the step emits the file list it
  scanned on every other run.

## Consequences

**The accepted coverage loss.** A secret that is committed and then reverted inside one pull request
is no longer caught. The scan stops seeing that the value was ever committed, and the value remains
in the branch's history after the merge. This is a real reduction on a security gate, taken
knowingly in exchange for making the ordinary repair — delete it and push — sufficient.

**The compensating control, if one is later wanted, is a periodic full-history sweep**, run on a
schedule rather than per pull request so it cannot red every run against the triaged baseline. It is
not in scope here and nothing in this ADR obliges it; it is named so a future reader knows the shape
the answer takes rather than re-deriving it.

What this buys: a lane that hits a finding fixes it at head and moves, instead of burning its retry
budget and parking on a person. The force-push path stays unreachable to agents, so the wider
question of an agent rewriting published history is not opened by a secret-scanning fix.

## Records

no vocabulary impact
