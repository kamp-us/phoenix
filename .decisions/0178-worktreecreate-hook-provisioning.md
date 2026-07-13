---
id: 0178
title: A WorktreeCreate Hook Provisions isolation:worktree, Giving the Deps Install a 600s Budget Instead of Racing the Default-Path Timeout
status: accepted
date: 2026-07-12
tags: [pipeline, worktree, tooling, harness]
---

# 0178 — A `WorktreeCreate` Hook Provisions `isolation:worktree`, Giving the Deps Install a 600s Budget Instead of Racing the Default-Path Timeout

## Context

This extends ADR [0109](0109-worktree-deps-provision-not-share.md). 0109 fixed *what* a
worktree's deps are (a real `pnpm install`, never a filesystem share) and made the lefthook
`post-checkout` `bootstrap-deps` hook the correct, version-pinned install that fires on
`git worktree add`. What 0109 left harness-owned was the *when*: it recommended the harness
invoke provisioning "once, post-`git worktree add`, with a full PATH." The harness did wire a
default worktree provisioning path — but that path has an **undocumented readiness timeout**,
and `isolation:worktree` spawns began non-deterministically **falling back to the primary
checkout** (a coder/reviewer/shipper that expected a linked worktree lands on primary and
fail-closes at the Step-4 preflight — the #2924/#2923 lane-down class).

**Measured root cause (grounded, not intuition — per CLAUDE.md's falsifiable-claims rule).**
The fall-back is a **race**, not disk pressure:

- The `bootstrap-deps` `pnpm install` the default provisioning fires measures **13.4–13.7s**
  (disk-independent — reproduced across volumes; a warm-store install of the full workspace).
- The harness default-worktree-path has an **undocumented ~13s readiness limit**. When the
  install runs long (essentially every time, since 13.4s > ~13s), the default path times out
  and the harness abandons the worktree, dropping the agent onto primary.

So the two numbers straddle the timeout: a **correct** install (0109's, which we must keep)
is *just over* the budget the default path allows. #2923 was resolved operationally (a pool
prune bought margin), but pruning only moves install cost around the ~13s line — it does not
remove the race. The durable fix is to stop running the install under the racy budget.

## Decision

**Provision `isolation:worktree` via a Claude Code `WorktreeCreate` hook** —
`claude-plugins/kampus-pipeline/hooks/create-worktree.sh`, registered in `.claude/settings.json`
(mirrored in the plugin's `hooks.json`) under a `WorktreeCreate` array with `"timeout": 600`.
The hook **replaces** the harness's default worktree provisioning: it reads the payload's
`worktree_path` + `base_ref` from stdin, runs `git worktree add --detach "$worktree_path"
"$base_ref"` itself, and prints only the resulting path to stdout on success. Because the hook
carries a **600s timeout**, the same 0109 `post-checkout` install (which `git worktree add`
still fires — we **reuse** it, never reimplement it) now runs inside a generous budget instead
of racing the ~13s default-path limit. The 13.4s install against a 600s budget has ~44x margin.

**Why this over decoupling the lefthook `post-checkout` install.** The alternative — move the
install off `post-checkout` so `git worktree add` returns fast, then install separately — would
change 0109's install contract (the single choke point where a worktree's deps are provisioned
correctly, `--ignore-scripts` and all) and risk re-opening the shared-`.git/hooks` and
provision-not-share subtleties 0109 closed. The `WorktreeCreate` hook is **less invasive**: it
changes *who triggers provisioning and with what timeout*, not *how deps are installed*. 0109's
`post-checkout` install is preserved verbatim.

**`--detach` deliberately.** A linked worktree cannot check out a `base_ref` that is a *local*
branch already checked out in the primary (`git worktree add <p> main` fatals with `'main' is
already checked out`). The coder re-branches off `origin/main` in its Step-4 preflight
regardless, so the base HEAD is throwaway — a detached checkout at `base_ref`'s commit sidesteps
the collision and still fires `post-checkout`.

### Documented vs undocumented platform facts

Grounding the mechanism honestly (which parts are contract, which are defended-against guesses):

- **Documented** (Claude Code `WorktreeCreate` mechanism): the hook **replaces** default git
  provisioning; honors a per-hook `timeout` (here 600s); a **non-zero exit blocks** worktree
  creation; stdin carries the JSON payload with `worktree_path` + `base_ref`; stdout's path is
  adopted as the worktree.
- **Undocumented** (handled defensively, never relied on):
  - **The hook exec env's PATH.** The sibling harness `git worktree add` strips PATH to
    `/usr/bin` (#787/ADR 0109); whether the `WorktreeCreate` hook env is stripped too is
    undocumented. If it were, `bootstrap-deps` would find no pnpm/corepack and clean-SKIP,
    leaving a **dep-less, useless** worktree. The script therefore **parses first under the
    inherited PATH**, then prepends the standard toolchain dirs (Homebrew, `/usr/local`,
    system, `~/.local`) while preserving the inherited PATH — OS/standard dirs only, never a
    per-machine volta/fnm shim (0109's prohibition).
  - **The default-path fallback trigger** — the ~13s readiness limit itself is undocumented;
    it was measured empirically (#2924). The 600s budget is sized to dominate it by a wide
    margin rather than to a documented number.

### Fail-closed safety

Every failure path in the script exits **non-zero**, and a non-zero `WorktreeCreate` **blocks
creation** — so the coder lands on the Step-4 worktree preflight and fail-closes there (ADR
0092). That is **no worse than today's** fall-back-to-primary, and strictly better than the
silent alternative: the script never emits a path for a worktree it couldn't fully create, so
there is never a dep-less worktree presented as ready. An absent `worktree_path`, a failed
`git worktree add`, all refuse loudly.

## Consequences

- **The provisioning race is removed by construction** — the correct 0109 install runs under a
  600s budget, not the racy ~13s default-path limit, so `isolation:worktree` spawns stop
  non-deterministically dropping to primary.
- **0109 is preserved unchanged** — `git worktree add` still fires the same `post-checkout`
  `bootstrap-deps`; this ADR changes only the trigger + timeout, not the install.
- **Validation happens on settings reload, post-merge (the one honest caveat).** A
  `WorktreeCreate` hook takes effect only when Claude Code loads the updated `.claude/settings.json`
  — i.e. the **live crew sessions must reload/restart after this merges** for the hook to fire.
  It **cannot be end-to-end validated in a unit test** (that needs a real harness spawn against
  the reloaded settings); the committed unit test
  (`packages/pipeline-cli/src/tools/worktree-sweep/create-worktree.hook.test.ts`) covers the
  script's pure logic — stdin parse (jq and jq-less fallback) → the `git worktree add` it runs →
  the stdout-path contract → the fail-closed exits — against a real throwaway repo, and the live
  firing is verified on reload.
- **§CP / control-plane.** This touches `.claude/settings.json` and `packages/pipeline-cli/`,
  so it is human-merged (cansirin), never auto-shipped.
- Sibling context: ADR 0109 (the install this reuses), #2924 (this durable fix), #2923 (the
  acute incident + empirical 13s measurement), #787/#788/#789 (the PATH-strip class defended
  against here).
