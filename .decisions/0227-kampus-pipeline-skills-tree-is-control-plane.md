---
id: 0227
title: the whole kampus-pipeline skills tree is §CP — the directory is the unit of coverage, not the file type
status: accepted
date: 2026-07-29
tags: [pipeline, control-plane, ship-it, skills, codeowners, classifier]
---

# 0227 — the kampus-pipeline skills tree is control-plane, whole

## Context

The §CP boundary (ADR [0053](0053-control-plane-boundary.md), enforced at GitHub per ADR
[0071](0071-enforce-control-plane-at-github.md), hard-gated per ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)) is a single-source
path regex in
[`control-plane-re.ts`](../packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts),
byte-synced to the `CONTROL_PLANE_RE=` line in
`gh-issue-intake-formats.md`
and to `.github/CODEOWNERS`.

Its coverage of the `kampus-pipeline` skills tree was, until now, **three narrow clauses**: an
**enumerated** list of eleven gate-skill directories, an any-depth `.sh` clause (ADR
[0174](0174-bare-sh-guards-control-plane-gate.md), #2576/#2950), and an exact-file clause for
`gh-issue-intake-formats.md`. Everything else under `skills/**` was outside the boundary.

That is not merely "unprotected"; under this repo's live configuration it is **auto-mergeable with
zero human approvals**. `.github/CODEOWNERS` has **no `*` catch-all**, and the `main` ruleset pairs
`required_approving_review_count: 0` with `require_code_owner_review: true` — so a path matching no
CODEOWNERS row requires **zero** approvals, with every machine gate green. Verified one path at a
time against the live boundary with `pipeline-cli cp-classify`:

| path | verdict | exit |
|---|---|---|
| `claude-plugins/kampus-pipeline/skills/shared/lib/common.sh` | control-plane | 0 |
| `claude-plugins/kampus-pipeline/skills/shared/lib/common.env` | **not-control-plane** | **3** |
| `claude-plugins/kampus-pipeline/skills/shared/lib/common` (extensionless) | **not-control-plane** | **3** |
| `claude-plugins/kampus-pipeline/skills/shared/lib/README.md` | **not-control-plane** | **3** |

`exit 3` is the **proven-ordinary** answer, not the undetermined one: a `README.md` beside a gate
guard script merges unapproved on `main` today. The hazard surfaced when #4440 moved a gate
**markdown** file into exactly that tree, but it is a live hole, not one the relocation introduces.
Every seat had independently leaned "the existing coverage probably suffices"; the **negative** case
flipped it.

## Decision

**`claude-plugins/kampus-pipeline/skills/**` is control-plane in its entirety** — every file, at any
depth, regardless of extension — matched by one branch,
`^claude-plugins/kampus-pipeline/skills/`, and owned by one `.github/CODEOWNERS` directory row.
**The directory is the unit of coverage, not the file type.** Founder ruling on
[#4446](https://github.com/kamp-us/phoenix/issues/4446), 2026-07-29: *"kampus-pipeline's skill
folder should be cp, regardless of what they are."* The narrow alternative (cover `skills/shared/**`
only) was put to him alongside it, with the approval-load cost stated; he chose the wide row
knowingly.

The single branch **supersedes** all three narrow clauses, which it strictly contains.

## Consequences

- **The boundary cannot rot.** An enumeration goes stale every time a skill is added — that is
  exactly how `release` and `review-trivial` were missing until #2679, a live fail-open. A directory
  prefix has nothing to keep up to date.
- **No naming convention has to hold.** The `.sh` clause implicitly relied on gate content living in
  `.sh` files, enforced by a header comment. Under a directory row a new file is §CP whatever it is
  called, so no separate naming guard is needed to keep the tree safe.
- **ADR 0174's four per-dir exclusions are superseded.** `heal-ci`, `what-shipped`, `doctor` and
  `wayfinder` are now §CP. Their containment argument (operational skills gate nothing) survives as
  a **routing** fact — they still ride `review-skill` for the verdict — but it no longer decides
  *who merges*. This is the accepted approval-load cost, stated plainly to the founder before the
  ruling, not an oversight.
- **The regex and the CODEOWNERS row must land together.** They assert the same fact from two
  sides; split across PRs, CI enforces one against the other. `codeowners-cp` detects
  **under**-protection only, so a lagging CODEOWNERS is caught but a lagging regex is not — the
  atomicity is an author obligation as much as a gate one.
- **`claude-plugins/pipeline-crew/**` is untouched.** The crew corpus stays out of §CP on the live
  founder ruling re-affirmed 2026-07-24 (#3765); this widening is scoped to the `kampus-pipeline`
  plugin's skills tree and to nothing else. Asserted as a negative test, not assumed.
- **Anti-self-authorization still holds.** The merge-deciding gates re-resolve `CONTROL_PLANE_RE`
  from `origin/main` at run time, so this PR is classified against the **old** boundary — a
  boundary-widening PR cannot classify itself out of §CP.

## Alternatives rejected

- **Cover `skills/shared/**` only.** Closes the one proven hole and leaves the same shape everywhere
  else: the next non-`.sh` file under any unenumerated skill dir is ungated again. Ruled against.
- **A naming-convention guard (`skills/**` may contain only `.sh` + enumerated dirs).** Adds a gate
  to protect a gate, and a convention violated by a file that is §CP-invisible until someone notices.
  The directory row makes the convention unnecessary.
- **A `*` catch-all in CODEOWNERS.** Would make *every* path require control-plane approval,
  collapsing the autonomous pipeline the boundary exists to keep safe. The hole is real, but the fix
  is scoped ownership, not global ownership.
