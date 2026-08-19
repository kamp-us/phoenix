---
id: 0299
title: §CP covers packages/fabrika-cli/src/ci/, the ci-required verdict core, and nothing wider
status: accepted
date: 2026-08-18
tags: [fabrika, pipeline, control-plane, codeowners, ci, guards]
---

# 0299 — §CP covers `packages/fabrika-cli/src/ci/`, the `ci-required` verdict core, and nothing wider

**What this decides:** the code that decides whether `main`'s one required check passes needs a
human code-owner's approval to merge, wherever that code lives. It is moving into
`packages/fabrika-cli/src/ci/`, so the fence goes there first — that one directory, and no more of
fabrika-cli.

## Context

The `ci-required` verdict core is the pass/fail logic behind the single always-on required status
context on `main`. Today it lives in `packages/pipeline-cli/src/tools/ci-required/`, which ADR
[0218](0218-pipeline-cli-cp-enforcement-core.md) retains inside the §CP enforcement core. Child
[#6099](https://github.com/kamp-us/phoenix/issues/6099) of epic
[#5720](https://github.com/kamp-us/phoenix/issues/5720) moves it to
`packages/fabrika-cli/src/ci/required.ts` + `required-bin.ts` and rewires `ci.yml`'s `ci-required`
job onto the new bin.

**That move has not landed.** #6099 is open; the new files exist only on the `epic/5720` range
`9e671156..f8d6c4c2`, and on `main` today `.github/workflows/ci.yml` still runs
`node packages/pipeline-cli/src/tools/ci-required/bin.ts`. When #6099 does land, the pipeline-cli
copy stays behind as the frozen v1 baseline nothing runs (ADR
[0238](0238-fabrika-reimplements-v1-never-calls-it.md)).

`CONTROL_PLANE_RE` names only the pipeline-cli home, and #6099 does not move it. So the day that
migration lands, the covered path goes dead and the live path goes uncovered — which is not a
cosmetic mismatch: `.github/CODEOWNERS` carries no `*` catch-all, and the `main` ruleset pairs
`required_approving_review_count: 0` with `require_code_owner_review: true` (ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)). A path matching no
row merges at **zero** approvals. From that day on, a pull request touching only
`packages/fabrika-cli/src/ci/` would land the merge-deciding verdict logic unreviewed.

**So this fence lands ahead of the core, by design.** That is the founder's own landing note on
[#6164](https://github.com/kamp-us/phoenix/issues/6164): "The addition itself can land first,
independently." Covering the directory before the code arrives means there is never an uncovered
window; landing the fence after #6099 would open exactly the gap this record exists to close.

Epic #5720 planned its whole migration on the contrary premise, verbatim in its body:
"`packages/fabrika-cli/` is not §CP under CODEOWNERS, so the CLI half of every child needs no §CP
approval." Extending the fence into that package for the first time contradicts that premise and
adds approval load, so the direction was the control-plane owner's to rule, not a builder's to
assume.

**The founder ruled it on #6164, 2026-08-18** — extend the fence, scoped to the CI checks. Verbatim:
"i'm ok with it as long as it's scoped to the ci checks, if not i trust fabrika enough to self drive
itself."

This ADR does not amend 0218. That ADR's ruling — §CP on a CLI package is an enforcement core, never
the whole package — holds unchanged, and its pipeline-cli branches are untouched. This applies the
same shape to the package the core is moving into. The test it applies is ADR
[0187](0187-crew-mcp-is-not-control-plane.md)'s: a path is control-plane when merging it unreviewed
could weaken the pipeline's enforcement of its own rules.

**ADR [0274](0274-fabrika-tree-is-not-control-plane.md) is untouched, and does not conflict.** It is
the record a reader hits first when asking "is fabrika §CP?": it rules `claude-plugins/fabrika/**` —
the *plugin tree* — out of §CP, and binds against adding CODEOWNERS rows or widening
`CONTROL_PLANE_RE` for that path set. This record governs one directory of `packages/fabrika-cli/` —
the *CLI package*. The two path sets are disjoint, so nothing here reverses 0274, and 0274's
plugin-tree veto still stands. The founder's #6164 ruling reconciles the two in its own words: the
fence is scoped to the CI checks, and the rest of fabrika self-drives.

## Decision

**`packages/fabrika-cli/src/ci/` is §CP; the rest of `packages/fabrika-cli/` is ordinary.**

The boundary gains one branch, `^packages/fabrika-cli/src/ci/`, in the single-source
`CONTROL_PLANE_RE` const, and it lands in lockstep with the two surfaces that cannot import it —
the byte-synced `CONTROL_PLANE_RE=` line in
[`boundaries.md`](../packages/pipeline-cli/src/tools/control-plane-paths/boundaries.md)
(the prose copy's home since the v1 plugin's retirement, ADR 0303), and a literal `.github/CODEOWNERS` row owned by `@kamp-us/control-plane`. That is the ADR-0218
lockstep, unchanged; `codeowners-cp` fails closed on the CODEOWNERS half of it.

The unit of coverage is the **directory**, not the file. The core arrives as `required.ts` (which
decides the verdict) plus `required-bin.ts` (what the job runs), and a test that pins either one is
as gate-critical as the logic it pins — an unreviewed edit that guts the test guts the guard. A
file-level enumeration would also rot as the core grows, which is the failure ADR 0218's
non-recursive `src/[^/]+$` pattern was written to avoid. Naming the directory before the files exist
is the same property: whatever #6099 puts there is covered on arrival.

**Binding constraints.**

- The branch stays anchored to that one directory. Widening it to `packages/fabrika-cli/src/` or to
  the package needs a fresh control-plane ruling — the narrowness is the ruling, not an artifact.
- Any future relocation of the `ci-required` verdict core moves this branch, its formats-doc copy
  and its CODEOWNERS row **in the same commit** as the move. The #4462 discipline: a core that
  relocates without its fence is uncovered for the length of the gap.
- Epic #5720 Phase 3 ([#6100](https://github.com/kamp-us/phoenix/issues/6100)) may delete the
  pipeline-cli `ci-required` CODEOWNERS rows only once **both** landings are in: #6099 has merged,
  so `ci.yml` runs the fabrika bin and `packages/fabrika-cli/src/ci/` exists, **and** this branch is
  in. Never on this branch alone — until #6099 lands, the pipeline-cli rows are the only coverage
  over the live verdict core, and deleting them strips it outright.

## Consequences

- **One more approval-banking surface.** Every pull request touching
  `packages/fabrika-cli/src/ci/` now waits on a `@kamp-us/control-plane` member's approval at head.
  That cost was stated to the founder and accepted; it is the whole point of the ruling.
- **Epic #5720 Phase 3 gets its precondition, not its clearance.** The fabrika-cli directory is
  fenced ahead of the core's arrival, so #6099 lands into coverage with no gap. Dropping the
  pipeline-cli rows still waits on #6099 itself — see the binding constraint above.
- **`codeowners-cp` cannot catch the stale-narrowing direction.** It detects under-protection only,
  so if the core ever leaves `src/ci/` and this branch is left behind, no gate reds. The
  same-commit constraint above is an author obligation, and the classification tests in
  `control-plane-paths.unit.test.ts` are what red on a quiet widening.
- **This says nothing about fabrika as an installed plugin.** §CP is phoenix's own CODEOWNERS
  policy over paths in this repo; a consuming repo installs fabrika without inheriting any of it,
  and ADR [0273](0273-fabrika-ships-as-an-installed-plugin.md)'s portability rule is untouched.
- **The #981 anti-self-authorization property holds.** The live merge-deciding gates still re-resolve
  `CONTROL_PLANE_RE` from `gh-issue-intake-formats.md` on `origin/main`, so the pull request that
  widens the fence is classified against main's pre-widening boundary. The widening cannot authorize
  itself.

## Records

no vocabulary impact
