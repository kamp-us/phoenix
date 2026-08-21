---
id: 0330
title: .github/CODEOWNERS is the only source of §CP truth, never a path regex in source
status: accepted
date: 2026-08-21
tags: [control-plane, codeowners, guards, fabrika, security]
---

# 0330 — `.github/CODEOWNERS` is the only source of §CP truth, never a path regex in source

**What this decides:** whether a path needs a human code-owner's approval is answered by reading
`.github/CODEOWNERS`, and by nothing else. The `CONTROL_PLANE_RE` regex stops being a source of
truth and is deleted rather than fenced.

## Context

Founder ruling, 2026-08-20, on
[this comment](https://github.com/kamp-us/phoenix/issues/6248#issuecomment-5362559734). The driver
offered two shapes for [#6248](https://github.com/kamp-us/phoenix/issues/6248) — move the regex into
the already-fenced `packages/fabrika-cli/src/ci/`, or extend the regex to cover its own file — and
the founder ruled neither.

#6248 reports a real gap, open at head. `packages/fabrika-cli/src/guard/control-plane-re.ts` holds
the only copy of `CONTROL_PLANE_RE`. It used to be kept honest by a pin test against a second copy in
`packages/pipeline-cli/`, but that package was deleted by PR #6326 and the pin was written to go with
it (recorded in [0218](0218-pipeline-cli-cp-enforcement-core.md)'s 2026-08-19 amendment). The
surviving file matches no CODEOWNERS row, `.github/CODEOWNERS` carries no `*` catch-all, and the
`main` ruleset pairs `required_approving_review_count: 0` with `require_code_owner_review: true`. So
the file that says which paths need a human merge needs none itself: a PR narrowing the boundary
there merges at zero approvals with nothing red.

The regex is also the last holdout of a model that was already ruled. On 2026-08-08 the founder ruled
CODEOWNERS the single source of §CP truth, recorded in
[`claude-plugins/fabrika/docs/control-plane-classification.md`](../claude-plugins/fabrika/docs/control-plane-classification.md),
which states in as many words that there is no second source and no content regex. Every fabrika verb
that classifies §CP already implements it. `guard codeowners-cp check` is the one surface that does
not — it expands the regex into paths and checks each has a covering CODEOWNERS row, which only makes
sense while two sources exist.

## Decision

**A path is control-plane iff the last matching `.github/CODEOWNERS` row for it, read at the
repository's default branch, names a control-plane owner. No path regex is a source of truth in
source.**

**The derivation rule.** Last match wins, and an owner-less row unsets ownership — GitHub's own
documented rule. That is the reading already implemented by `ownersOf`, `controlPlaneOwnersOf` and
`classify` in [`packages/fabrika-cli/src/ship/codeowners.ts`](../packages/fabrika-cli/src/ship/codeowners.ts),
wrapped for the roster by `controlPlaneRoster` in
[`packages/fabrika-cli/src/ship/roster.ts`](../packages/fabrika-cli/src/ship/roster.ts). Those two
modules are the boundary's readers; a third reading of "who is on the control plane" would drift from
the one the merge gate enforces, and drift there is an approval nobody with authority gave.

**Where the control-plane owners come from: the CODEOWNERS rows themselves.** `controlPlaneOwnersOf`
parses them off the file — an `@org/team` or an individual `@login`, both counting the same — so a
repo with a different team, or with no org at all, is answered rather than mis-answered. Naming the
team a second time in configuration would be the second source this ADR bans, so `.fabrika.jsonc`
declares no control-plane team and must not gain one. It carries adjacent, distinct ACLs
(`capClearAuthors`, `campaignAuthors`) and a dead `unreadableCodeowners` key nothing reads; none of
them bounds §CP.

**The source of truth guards itself.** `.github/CODEOWNERS` is covered by the
`/.github/ @kamp-us/control-plane` row inside `.github/CODEOWNERS`, so every edit to the boundary is
itself a §CP change reviewed by the people accountable for it. That is the property the regex copy
never had, and it is why the fix is deleting the copy rather than fencing it.

**Disposition of `packages/fabrika-cli/src/guard/control-plane-re.ts`: deleted, not fenced.** These
consumers are re-based onto the CODEOWNERS-derived boundary or retire with it:

- `packages/fabrika-cli/src/guard/codeowners-cp-verb.ts` — imports the const
- `packages/fabrika-cli/src/guard/codeowners-cp.ts` — the pure rule that expands it into paths
- `packages/fabrika-cli/src/guard/codeowners-cp-verb.unit.test.ts` and
  `packages/fabrika-cli/src/guard/codeowners-cp.unit.test.ts`
- the `.github/workflows/codeowners-cp.yml` job that runs the verb

**This weakens no fail-closed behaviour, and the two arms below are not droppable.** An unreadable or
absent `.github/CODEOWNERS` stays the refusal it is today — the `Unknown` arm of `controlPlaneRoster`,
never a collapse to `not-control-plane`, which [0220](0220-cp-surface-declared-at-standup.md) §4 names
this repo's recurring fail-open defect. A boundary resolving to zero owned paths stays a red, the
zero-scope refusal in `codeowners-cp-verb.ts` per
[0092](0092-gates-fail-closed-on-zero-scope.md). Removing a regex removes a second *source*, not a
guard.

**Interim rule, in force from this record until the migration lands.** No PR may edit
`packages/fabrika-cli/src/guard/control-plane-re.ts` without control-plane review. Reviewers treat
that path as §CP by this ruling even though no CODEOWNERS row matches it. This is a human convention
with no mechanical backing, which is the whole reason the migration is tracked rather than deferred.

**Binding constraints.**

- No second source of §CP truth in source — no path regex, no path list, no config key naming the
  team. A surface that needs the boundary reads it through `ship/codeowners.ts`.
- A surface that becomes governance-bearing gains its `.github/CODEOWNERS` row in the change that
  creates it. Path-set completeness is the whole protection, and it is an obligation the
  `@kamp-us/control-plane` team owns, not a property that holds by itself.
- Neither fail-closed arm above may be relaxed by the migration.

## Consequences

The code half is [#6942](https://github.com/kamp-us/phoenix/issues/6942): delete the const, re-base or
retire `guard codeowners-cp` and its workflow job. It is tracked, not assumed. Until it lands the
interim rule is the only thing holding that file, so the gap #6248 reports stays open in the
mechanical sense.

`guard codeowners-cp` loses its subject rather than its rigour. It exists to catch drift between two
sources; with one source there is nothing to compare. What, if anything, replaces the green check is
#6942's to answer.

This supersedes the **regex framing** of [0299](0299-cp-fence-covers-fabrika-ci-core.md) and
[0100](0100-control-plane-covers-enforcement-guard-packages.md), and nothing else in either. Both rest
on §CP being a regex that CODEOWNERS mirrors, and their lockstep clauses have no referent once the
regex is gone. What each of them actually ruled about *coverage* stands unchanged and stands as
CODEOWNERS rows: `packages/fabrika-cli/src/ci/` is control-plane and no wider slice of that package
is (0299), and the enforcement-guard packages are control-plane wherever they live (0100). Both are
amended in part rather than superseded outright for that reason.

## Records

No vocabulary impact. §CP, control plane, boundary and roster are all defined already; this record
changes where the boundary is read from, not what any of them means.
