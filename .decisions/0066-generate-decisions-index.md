---
id: 0066
title: "Generate `.decisions/index.md` from the ADR files instead of hand-appending rows — concurrent doc PRs collide on the tail of `index.md` (4× hand-resolved in one session: #334/#337/#372/#377+#380) and `ship-it` has no rebase; a generator + CI `--check` (fails on stale index or duplicate ADR `id`) removes the shared textual anchor entirely, also closing the sibling ADR-number-collision (0059/#325, 0064/#370). `merge=union` via `.gitattributes` REJECTED — GitHub's server-side merge button ignores user `.gitattributes` ([community #9288](https://github.com/orgs/community/discussions/9288)), so it never fixes the `ship-it` path; ship-it auto-rebase rejected as merge-actor complexity. Implementation tracked as a follow-up"
status: accepted
date: 2026-06-15
tags: [pipeline, docs, ship-it, decisions, autonomy]
---

# 0066 — Generate `.decisions/index.md` from the ADR files instead of hand-appending rows

## Context

Every ADR / doc PR hand-appends one row to the **tail** of `.decisions/index.md`
(after the last ADR; see the `/adr` skill's "Append one row … newest at the bottom").
Two concurrent doc PRs therefore both add a different line at the same anchor — the
end of the table — and git cannot auto-merge two distinct insertions at one anchor.
The second PR to reach the merge button conflicts on `index.md`, and `ship-it` has
**no rebase step** (ADR [0048](0048-ship-it-merge-actor.md): it asserts the gate
verdict + CI-green, then squash-merges; it does not rebase a behind/conflicting
branch). So it dead-ends and a human hand-resolves the conflict.

The pipeline is explicitly built to go autonomous and multi-agent (ADR
[0053](0053-control-plane-boundary.md)), where multiple in-flight doc PRs is the
**normal** case — so `index.md` is a guaranteed serialization point on every doc PR.

**Fresh evidence (issue #204):** this exact collision was hand-resolved **4× in one
session** — PRs #334, #337, #372, and the #377/#380 pair. It is the dominant
merge-friction in the autonomous doc pipeline.

A **sibling** problem rides along: two PRs grab the **same ADR number** (each reads
the highest number on `main`, neither sees the other's open PR). Hit **2× this
session** — 0059 (#325) and 0064 (#370). Whatever fixes the index collision should be
weighed against this too.

### Options considered

1. **`merge=union` git driver for `index.md`** via a root `.gitattributes`
   (`.decisions/index.md merge=union`). One line; git would take both sides' appended
   rows with no conflict. **Rejected — does not fix the actual failure.** The observed
   stall is at `ship-it`, which squash-merges through **GitHub's server-side merge**,
   and GitHub does **not** honor user-defined `.gitattributes` merge drivers in the web
   UI / API merge — it uses its own internal attributes you can't override; the only
   sanctioned workaround is to merge locally
   ([community discussion #9288](https://github.com/orgs/community/discussions/9288),
   GitHub Support; still unchanged as of 2026). So `merge=union` would help a *local*
   `git merge`/rebase but never the autonomous `ship-it` merge — the one path that
   matters. It also can't dedupe identical ADR numbers (it would happily keep two
   `0064` rows), so it doesn't touch the sibling problem either.
2. **Generate `index.md` from the ADR files** — a small generator reads every
   `.decisions/NNNN-*.md` front-matter and emits the table; the file is build output,
   not a hand-edited shared target. **Chosen.** No shared anchor means no textual
   collision — two PRs adding two different ADR files don't conflict (different files),
   and the index is regenerated deterministically. It is also the natural home for an
   **ADR-number-collision check** (the generator/CI fails on a duplicate `id`), folding
   the sibling problem into the same mechanism.
3. **`ship-it` auto-rebases a doc PR on an index-only conflict** (the issue's "(a)").
   **Rejected** as the primary fix — it adds merge-actor complexity and a
   surgical-conflict-resolution path to the single most safety-sensitive skill, to paper
   over a self-inflicted shared-file design rather than remove it. Generation removes the
   conflict class entirely; a rebase only resolves one instance of it.

## Decision

**`.decisions/index.md` becomes generated output, not a hand-maintained file.** The
source of truth is the set of `.decisions/NNNN-*.md` files; a small generator derives
the table (number → linked title → status → date) from each file's front-matter, and
CI verifies the committed `index.md` matches the generated one (and fails on a
**duplicate ADR `id`**, killing the number-collision class in the same step).

Concretely, per the repo's tooling idiom (CLAUDE.md "Node over Python … Effect CLI
package under `packages/`"):

- A pure core that takes the parsed front-matter of every ADR file and returns the
  index markdown — unit-tested, deterministic ordering (by `id`).
- A thin Effect-CLI bin (`node src/bin.ts`) with a `--check` mode for CI and a default
  write mode for authors / the `/adr` skill.
- A CI step that runs `--check`; a duplicate `id` or a stale `index.md` fails the build.
- The `/adr` skill stops hand-appending a row and instead runs the generator.

Until the generator lands, the `/adr` skill's hand-append remains the interim
procedure; this ADR records the target design and the rationale for **not** taking the
cheap `.gitattributes` route.

**This is not a trivial one-liner** (it is a generator + CI gate + `/adr` change),
so the implementation is tracked as a follow-up: **issue #384**
(`status:needs-triage`, milestone *Pipeline hardening*). The `.gitattributes`
`merge=union` shortcut was evaluated and deliberately **not** shipped in this PR,
because it would not fix the `ship-it` path it appears to target.

## Consequences

- **The index-collision class is removed**, not merely mitigated: two doc PRs touch two
  different ADR files, so there is no shared textual anchor and nothing for `ship-it` to
  dead-end on — autonomous, multi-agent doc merging stops serializing on `index.md`.
- **The ADR-number collision is closed in the same mechanism** — CI fails on a duplicate
  `id`, so two PRs claiming the same number can't both merge green. (Authors still pick a
  number when creating the file; the gate catches the race instead of preventing it,
  which is enough to stop a silent double-merge.)
- **`ship-it` stays simple** — no rebase/conflict-resolution logic added to the merge
  actor (keeps ADR [0048](0048-ship-it-merge-actor.md)'s "assert + squash-merge, nothing
  clever" shape).
- **Cost:** a new generator package + CI step + a `/adr` skill change, and `index.md`
  becomes regenerated output (don't hand-edit it; edit the ADR file and regenerate). The
  generator is control-plane-adjacent only if it lands under `.github/` workflows — the
  ADR file itself (this one) is non-control-plane.
- **`merge=union` is on record as rejected** for this specific friction, so a future
  reader doesn't re-propose the one-line `.gitattributes` fix without re-discovering that
  GitHub ignores it server-side.

## Update (2026-06-29, issue [#1492](https://github.com/kamp-us/phoenix/issues/1492)) — the index is no longer committed in PRs

The original design generated the index but still **committed it in each ADR PR** and
gated PRs on its freshness (`decisions-index check`). That re-introduced the same
serialization the generator was meant to remove, one level up: the index is a single
regenerated file, so two concurrent ADR PRs collide on it at merge, and each collision
moves the head and forces a fresh `review-code` + `review-doc` of the loser (PR #1488
bounced twice in ~20 minutes against 0114–0118, all in flight the same day). Generating
a shared file but still committing it per-PR keeps the shared textual anchor.

The fix completes the "index is derived output" intent: **ADR PRs stop carrying the
index entirely.** It is regenerated and committed **on merge to main** by the
`regenerate` job of `.github/workflows/decisions-index.yml` (the changelog-on-release
commit-back pattern, ADR [0069](0069-derived-changelog-from-shipped-work.md)), so adding an ADR
is purely additive (`.decisions/NNNN-*.md` only) and conflict-free.

- The PR gate is now `decisions-index validate` — it parses every ADR file and fails on
  a **duplicate `id`** or a **filename/front-matter number mismatch** (the #1471
  number-collision guard, preserved) but does **not** check index freshness. `check`
  (the old freshness gate) survives as a local "did I regenerate?" helper, no longer
  wired into the PR build.
- `.decisions/index.md` stays a **committed file on `main`** (the README and glossary
  link to it), but it is maintained by CI-on-merge, not by PRs — never hand-edited, never
  staged in an ADR PR.
- The ADR-**number** race (#1471 / #1452) is untouched and remains independent: the
  `/adr` number-claim lock reads ADR **filenames** in open PRs, and `validate` still
  reddens a duplicate `id` once two same-numbered files land on `main`.
