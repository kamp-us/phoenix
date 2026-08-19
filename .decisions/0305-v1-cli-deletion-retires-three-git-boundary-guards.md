---
id: 0305
title: Deleting the v1 CLI Retires Three Git-Boundary Guards and the ADR-Map Renderer — What Stands, What Does Not
status: accepted
date: 2026-08-19
tags: [pipeline, fabrika, git, gates, control-plane, decisions, retirement]
---

# Deleting the v1 CLI Retires Three Git-Boundary Guards and the ADR-Map Renderer — What Stands, What Does Not

## Context

ADR [0303](0303-retire-kampus-pipeline-plugin.md) retired the `kampus-pipeline` plugin and
[#6100](https://github.com/kamp-us/phoenix/issues/6100) deletes `packages/pipeline-cli/`, the CLI
that plugin drove. Four live mechanisms lived only in that tree, each named by a record that is
still `accepted`:

- **`ref-guard reference-transaction`** — ADR [0160](0160-ref-transaction-guard-refuses-diverging-primary-main.md)'s
  caller-agnostic refusal of a `refs/heads/main` update on the shared primary checkout that would
  make local `main` a non-fast-forward of `origin/main` (#2143). `lefthook.yml` was its
  installation seam.
- **`primary-index-tripwire`** — the record-only attribution leg for the #2778 primary-index
  mass-staged-deletion, diagnosed in
  [`ops/incidents/2778-primary-index-mass-staged-deletion.md`](../ops/incidents/2778-primary-index-mass-staged-deletion.md).
- **`primary-index-guard`** — #2784's blocking containment, the prevention half that diagnosis
  named.
- **`decisions-index compact`** — ADR [0129](0129-adr-discovery-is-the-claude-md-contract.md)
  §Decision's third leg, the on-demand `id · title · status` map.

Deleting the tree deletes all four. A deletion that leaves an `accepted` record naming a mechanism
the head does not ship is worse than the mechanism's absence on its own: the corpus keeps asserting
a protection nobody has, and the next reader cannot tell an oversight from a decision.

## Decision

**All four are retired now, with no successor in this repo today.** This record is the authorizing
half of that deletion. It amends three live records rather than editing them, per the standing rule
that an accepted record's decision text is immutable.

### The three git-boundary guards — retired, tracked, and not replaced

ADR 0160 stands as a decision and stops standing as a description of the head. Its `reference-transaction`
guard, the `primary-index-tripwire` recorder and the blocking `primary-index-guard` are all gone from
`lefthook.yml`, and `packages/fabrika-cli/src/guard/` ships no ref guard and no index guard.

**Nothing replaces them.** The port is tracked as
[#6341](https://github.com/kamp-us/phoenix/issues/6341), which carries the contract a port must keep —
fail-closed on the guard's own deliberate refuse under a dedicated exit code, fail-open on any
inability to run, so a stripped-PATH or half-installed checkout never aborts every ref transaction
repo-wide (the #1050 invariant) — and the three known defects worth folding in rather than
re-porting around (#5648, #5892, #3595).

Saying "nothing replaces them" out loud is the point. The two incident classes are un-covered
between this merge and that port: a diverged local `main` is one `git push -f` from clobbering
`origin/main`, and a mass control-plane staged deletion on the primary is one commit plus a
fast-forward from landing on it. Neither is reachable by CI, because both happen before a PR
exists.

The #2778 diagnosis document is **not** retired. It is the mechanism trace, and it stays as history
per ADR 0303's ruling that `.decisions/` and dated reports keep their account of a dead subject.

### The ADR-map renderer — retired, and the discovery contract shrinks to two legs

ADR 0129 §Decision's third leg — `pipeline-cli decisions-index compact` renders the full
`id · title · status` map on demand — is retired. The first two legs stand unchanged: filenames are
the map, frontmatter is the row, and no `SessionStart` hook injects anything.

`CLAUDE.md`'s `## Decisions` section, which ADR 0129 makes *the* statement of the contract, says
plainly that no on-demand map ships and points at
[#6332](https://github.com/kamp-us/phoenix/issues/6332). `.glossary/TERMS.md`'s `ambient ADR
discovery` row says the same. **Those two surfaces and this record must agree**; a contract naming
a command nobody ships sends its reader nowhere, which is the failure this amendment exists to stop.

ADR 0126 §Decision's `validate` backstop is untouched and still runs: `fabrika guard decisions-index
validate` reds on a duplicate id or a filename/frontmatter mismatch, wired through
`.github/workflows/decisions-index.yml`.

### A link-only edit to a landed accepted record is permitted

When a link target in an `accepted` record dies, dropping the link wrapper while leaving the visible
prose byte-identical is **permitted, and is the preferred repair**. Keep the full path as inline
code rather than collapsing it to a basename — the locator is the part history needs.

This is not a softening of immutability. The rule protects *decision text*, not bytes: every
statement of it in this corpus is about a later ruling rewriting an earlier one's substance. A dead
hyperlink carries no substance. ADR 0303 already ruled the adjacent question — references to a
deleted tree stay as history — and unlinking keeps the reference while a dead link merely rots.

It is also forced. [`.github/workflows/doc-links.yml`](../.github/workflows/doc-links.yml) walks
every git-tracked `.md`, `.decisions/` included, fail-closed on zero scope per ADR 0092, and runs on
pushes to `main` as well as pull requests (#5085). The alternative to unlinking was the repo's first
`lychee` exclude — buying the same green by blinding a live gate over a whole path prefix. Unlinking
satisfies a guard; excluding relaxes one.

**The limit is exact: the link wrapper and nothing else.** Change a word of decision text, a
consequence or a status line and you are amending, which needs its own record.

## Consequences

- ADR 0160 is `accepted` and describes no running guard. A reader must reach this record and #6341
  to learn that; both are linked from here, and #6341 carries the port's contract.
- The #2143 and #2778 classes are unguarded until #6341 lands. That is a known, recorded exposure,
  not an oversight.
- ADR 0129's contract is two legs, not three, until #6332 lands. `ls .decisions/` plus frontmatter
  remains a working map, so the cost is one command, not a lost capability.
- The next tree deletion does not re-litigate whether it may unlink dead targets in landed records.
  It may, under the stated limit.

## What this does not decide

- **Whether the guards come back, and in what shape.** #6341 owns that. This record says only that
  they are gone and that their absence is deliberate and dated, not that a port is optional.
- **Whether an on-demand ADR map is worth building.** #6332 owns that.
- **Anything about `.patterns/` docs still teaching the deleted tree.** #6336 owns that; a pattern
  doc is the code-shape surface, not the why surface, and its repair is not an amendment.
