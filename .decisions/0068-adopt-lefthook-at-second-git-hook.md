---
id: 0068
title: Adopt lefthook as the git-hook manager **when a 2nd git hook lands** (not now) and migrate the leak-guard pre-commit (#317) into it — lefthook over husky on monorepo fit (single Go binary, per-glob/parallel run groups, language-agnostic, idempotent + no-git-tolerant install that subsumes the #330/#332 hand-handling); promote-at-2nd-usage keeps the DIY `.githooks`/`core.hooksPath` wiring proportionate until then; CI stays the unbypassable authority (#312); impl tracked by #387
status: accepted
date: 2026-06-15
tags: [git-hooks, tooling, leak-guard, monorepo, deferred]
---

# 0068 — Adopt lefthook as the git-hook manager when a 2nd hook appears

## Context

The leak-guard pre-commit (#317) wires git hooks **by hand**: a DIY
`.githooks/pre-commit` bash script plus a guarded root `package.json` `prepare`
script that runs `git config core.hooksPath .githooks`. It works, and for a
*single* hook it is the proportionate choice — no dependency, the logic is one
readable script that reuses the `leak-guard` `scan` CLI so the deny-list lives in
exactly one place.

But the DIY wiring has already paid for its own edge cases by hand:

- **#330** — the `prepare` script ran `git config` outside a git work tree (a
  non-git sandbox / a tarball install) and exited 128, breaking `pnpm install`.
  Fixed by guarding it with `git rev-parse --git-dir … || true`.
- **#332** — when the `scan` CLI *can't run* (e.g. deps not installed yet) the
  hook must degrade to warn-and-allow, since CI is the unbypassable authority.
  Fixed by branching on the scan's exit code (2 = leak/block, other non-zero =
  can't-run/allow, 0 = clean) by hand inside the script.

A real hook manager handles both of these as **defaults**: install/uninstall
idempotency, no-git tolerance, per-hook config, parallel execution, skip/run
filters, and a documented config surface. Doing all of that by hand is fine for
one hook and a maintenance/edge-case burden the moment a second one lands.

This is the same **promote-at-2nd-usage** discipline the repo already applies to
pattern docs ([.patterns/index.md](../.patterns/index.md) — "when to add a new
pattern doc"): keep the bespoke thing while it's a one-off, formalize when it
recurs. One hook does not justify a dependency; two do.

The trigger is concrete and near: format (`biome check --write` on staged files),
[`/deslop-comments`](../skills/deslop-comments/SKILL.md), or a typecheck-changed
hook are all plausible second hooks, and `core.hooksPath` points at a single
directory — a second hook means a second hand-rolled script sharing the same
fragile `prepare`/degradation scaffolding.

## Decision

**When a 2nd git hook lands, adopt [lefthook](https://github.com/evilmartians/lefthook)
as the hook manager and migrate the leak-guard pre-commit (#317) into it.** Until
then this ADR is a tracker: **no action while leak-guard is the only hook** — the
DIY wiring stays.

Concretely, at the trigger:

1. Add `lefthook` as a root dev dependency and a `lefthook.yml` at the repo root.
2. Move the leak-guard pre-commit into a `pre-commit` command in `lefthook.yml`
   that invokes the existing `node packages/leak-guard/src/bin.ts scan` over
   staged files (keep the single-source-of-truth deny-list; no re-grep).
3. Replace the `prepare` `git config core.hooksPath .githooks` line with
   lefthook's own install step (`lefthook install`), and retire
   `.githooks/pre-commit`.
4. Keep the invariants intact: bypassable locally with `--no-verify`, **CI is the
   unbypassable authority** ([.github/workflows/leak-guard.yml](../.github/workflows/leak-guard.yml),
   #312), and the can't-run case degrades to warn-and-allow.

### Options considered

**Option A — keep DIY `.githooks` + `core.hooksPath` (status quo).** Zero deps,
one readable script. But every new hook re-pays the #330/#332 edge cases by hand
and grows a second bespoke script under one `hooksPath` directory with no
per-hook config, no parallelism, no install/uninstall story. Right for one hook,
wrong for many. **Rejected at the trigger; this *is* the current state until then.**

**Option B — husky.** The most widely used manager, but it is the **wrong fit for
this repo**: husky is Node/JS-shell-centric (a `.husky/` directory of shell
scripts it manages), shines for single-package JS repos, and has weaker
first-class monorepo ergonomics (no built-in per-glob filtering / parallel run
groups — you script that yourself, which is exactly the DIY burden we're escaping).
**Rejected.**

**Option C — lefthook (chosen at the trigger).** A single self-contained Go
binary, config-driven by one declarative `lefthook.yml`, with **first-class
monorepo support**: per-command `glob`/`root` filters, `parallel: true` run
groups, `{staged_files}` templating, and `skip`/`run` conditions — exactly the
features a pnpm monorepo with multiple independent hooks needs. The install step
is idempotent and no-git tolerant out of the box (subsumes the #330/#332
hand-handling). It is also language-agnostic, so a future non-Node hook
(`/deslop-comments`, a shell check) is a config entry, not another bespoke
script. **Chosen.**

**Option D — adopt a manager now (before the 2nd hook).** Premature: it adds a
dependency and a config surface to manage exactly one hook that the current 25-line
script already covers, violating the repo's promote-at-2nd-usage discipline.
**Rejected** — the trigger gate exists precisely to keep this proportionate.

The decision is **lefthook over husky** because the deciding axis is monorepo fit
(per-glob/parallel groups, single binary, language-agnostic), and the **trigger is
the 2nd hook** because that is the point where the DIY scaffolding stops being
proportionate.

## Consequences

- **No work now.** While leak-guard is the only hook, the DIY `.githooks` wiring
  stands unchanged. This ADR records the choice and its trigger so the next agent
  doesn't re-litigate husky-vs-lefthook or re-debate "manager vs DIY" from scratch.
- **The migration is pre-decided.** When the trigger fires, the implementer adopts
  lefthook per the steps above — the *choice* is settled here; only the mechanical
  migration remains. That implementation work is tracked as a milestone-1
  follow-up: **#387** (labelled `status:needs-triage`).
- **Invariants preserved at migration.** leak-guard stays bypassable locally
  (`--no-verify`) with **CI as the unbypassable authority** (ADR-adjacent #312),
  and the can't-run degradation (#332) is retained — lefthook makes both of these
  defaults rather than hand-rolled branches.
- **Relationship:** this extends the leak-guard defense-in-depth line
  (#158/#312/#317) and applies the same promote-at-2nd-usage discipline the
  repo uses for [.patterns/](../.patterns/index.md). It does not supersede any ADR.
- **Tracker semantics.** Until the 2nd hook lands, issue #333 stays open as the
  trigger tracker; this ADR is its recorded resolution-in-waiting.
