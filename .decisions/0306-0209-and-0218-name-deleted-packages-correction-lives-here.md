---
id: 0306
title: ADRs 0209 and 0218 Name Packages the Head No Longer Ships — the Correction Is Recorded Here, Not in Their Bodies
status: accepted
date: 2026-08-19
tags: [decisions, pipeline, fabrika, design, control-plane, retirement]
---

# 0306 — ADRs 0209 and 0218 name packages the head no longer ships; the correction is recorded here

## Context

[#6346](https://github.com/kamp-us/phoenix/issues/6346) deletes seven `packages/*` members that
no live code imports — `audit-run`, `audit-stage`, `audit-verdict`, `local-render`, `flake-rate`,
`moderator-grant`, `design-capture` — off a founder-approved read-only sweep. ADR
[0305](0305-v1-cli-deletion-retires-three-git-boundary-guards.md) is the sibling record for the
`packages/pipeline-cli/` half of the same program.

Two `accepted` records describe the head using names that deletion makes false:

- **ADR [0209](0209-taste-voice-per-aspect-skills.md)** names `design-capture`/`local-render` as
  the gate substrate the interactive eye composes with — once in Context ("Constraints that shaped
  the ruling") and once as a binding constraint under `## Decision`.
- **ADR [0218](0218-pipeline-cli-cp-enforcement-core.md)** carries `^packages/ci-required/` in its
  §CP regex as a separate, byte-unchanged branch. That package is gone too — it was one of the five
  untracked `node_modules`/`.turbo` shells with zero tracked files, removed outside a PR.

The first attempt at #6346 rewrote both bodies in place. That is the move the corpus forbids:
0129, 0195, 0224 and 0298 all state that an `accepted` record's decision text is immutable, and
0305 — three numbers away, inside this same deletion program — amends rather than edits. This
record is the correction those rules route to.

## Decision

**Both records stand byte-unchanged. Their stale package names are corrected here.**

### ADR 0209 — the gate substrate is `fabrika ui`, not `design-capture`/`local-render`

0209's ruling is unchanged: `agent-browser` is the loop's interactive eye and **composes** with the
gate substrate rather than replacing it; promoting instrumented measurements into `review-design`
FAIL classes still needs its own ADR.

What changed is only the substrate's address. `design-capture`'s code moved into
`packages/fabrika-cli/src/capture/` by founder ruling [#5061](https://github.com/kamp-us/phoenix/issues/5061)
(moved by [#5063](https://github.com/kamp-us/phoenix/pull/5063)), and `local-render`'s job is now
`fabrika ui render`. Read 0209's two mentions of `design-capture`/`local-render` as:

> the `fabrika ui` verb group — `manifest`, `law`, `render`, `golden`, `evidence` — plus
> `fabrika review-ui`, together with the golden/flake canon.

`capture` is an internal module of `fabrika-cli`, not a verb group: nothing is invoked as
`fabrika capture …`. `fabrika ui render` and `fabrika ui golden` are what drive it.

The deletion orphans no blessed bytes: `packages/design-capture/golden-pointer.json` read
`{"surfaces": {}}` at the base of #6346, so no surface was ever blessed. ADR
[0183](0183-golden-screen-storage-depo-git-pointer.md)'s store *concept* is untouched by this
record.

### ADR 0218 — the `^packages/ci-required/` branch describes a package that no longer exists

0218's decision is unchanged: §CP on `packages/pipeline-cli/` narrows to an enforcement core, and
`^packages/ci-required/` was recorded there as a separate, independent, byte-unchanged branch.

Read every `ci-required` mention in 0218 as history. The directory was an empty shell — zero
tracked files — by the time of the #6346 sweep, and `packages/pipeline-cli/` itself was deleted by
[#6326](https://github.com/kamp-us/phoenix/pull/6326) under 0305. Neither regex branch can match a
path at this head. ADR [0303](0303-retire-kampus-pipeline-plugin.md) already ruled that
`.decisions/` keeps its account of a dead subject, so the mentions stay where they are.

### Why the two records' frontmatter is not stamped either

The usual amendment leaves an `amended-in-part by` line on the older record's `status`, as 0305 did
to 0160 and 0129. It is not used here. #6346's acceptance criteria require 0209 and 0218 to be
**byte-identical** to their pre-PR state, so the discovery pointer would itself be the edit the
criterion forbids. The cost is real and stated: a reader who opens 0209 or 0218 cold is not sent
here. Stamping the two status lines in a follow-up is a clean, separate change if a reader ever
wants it.

## Consequences

- 0209 and 0218 are `accepted` and each carries one address the head does not ship. A reader learns
  that from this record, or from the deleted names failing to resolve in the tree.
- Neither record's ruling is weakened, narrowed or reopened. Nothing here changes what §CP covers
  or what the taste skills may ground in.
- The next deletion sweep that finds a stale package name in a landed record has a worked example:
  revert the body, write the correction as its own record.

## What this does not decide

- **Whether the deleted packages come back.** #6346 owns that; the founder accepted
  rewrite-if-ever-needed, with git history as the recovery path.
- **Whether a landed record's `status` line may be stamped when a criterion demands byte-identity.**
  The tension is named above and left for whoever hits it next.
- **Anything about `.patterns/` or `.glossary/` surfaces naming the deleted packages.** Those are
  the code-shape and vocabulary surfaces, repaired in place by #6346 itself.
