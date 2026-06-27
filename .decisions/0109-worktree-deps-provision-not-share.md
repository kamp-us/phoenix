---
id: 0109
title: Worktree Deps Are Provisioned by a Real pnpm install, Never a Filesystem Share; the Correct Install Is Deferred to a Full-PATH Context
status: accepted
date: 2026-06-27
tags: [pipeline, worktree, tooling, harness]
---

# 0109 — Worktree Deps Are Provisioned by a Real `pnpm install`, Never a Filesystem Share; the Correct Install Is Deferred to a Full-PATH Context

## Context

`isolation:worktree` agents (`write-code` / `review-*` / `ship-it`) run in a linked
git worktree the harness creates with `git worktree add`. `node_modules` is gitignored
and lives per-checkout (#504), so a fresh worktree is dead-on-arrival for
`pnpm typecheck` / `lint` / `build` until its deps are provisioned.

The `bootstrap-deps` post-checkout hook (`lefthook.yml`) was meant to provision them,
but #789 had to make it **clean-skip** whenever `pnpm` is unresolvable — because the
harness runs `git worktree add` under a **PATH-stripped exec env** (`#787`/`#788`/`#789`:
only `/usr/bin`; `.lefthookrc` restores `/bin:/usr/bin`; **no node, no pnpm, no
corepack**, and lefthook itself is not even resolvable, so the hook body never runs).
#789 punted the install to "the spawning agent installs its own deps (it runs with a
full PATH)" — but that was never wired up, so every worktree coder paid a manual
`corepack pnpm@10.27.0 install` bootstrap tax (#1256). Two questions had to be answered
from the real layout, not intuition:

**1. Can the toolchain be provisioned filesystem-only at spawn (the only thing the
stripped env permits)?** The tempting fix — symlink the primary checkout's
`node_modules` into the worktree — is **silently incorrect**, and the reason is grounded
in the on-disk layout, not assumed:

- The pnpm **virtual store** holds **relative symlinks into workspace source**:
  `node_modules/.pnpm/node_modules/@kampus/db-schema -> ../../../../packages/db-schema`.
  Every consumer of a workspace package resolves its `@kampus/*` dependency *through*
  this virtual-store link.
- Verified empirically: with the primary's `node_modules` symlinked into a throwaway
  worktree, `node_modules/.pnpm/node_modules/@kampus/db-schema` resolves to the
  **primary** checkout's `packages/db-schema` — so a worktree editing `packages/db-schema`
  would have its edits **invisible** to any consumer, and `typecheck`/`build` would
  silently check the *primary's* source. That is a correctness trap worse than the
  bootstrap tax it was meant to remove.

(Root `node_modules` itself carries no workspace-source links — those live only in the
per-package `node_modules` and the virtual store — but the virtual store is exactly what
a whole-`node_modules` share drags along, which is what makes the share wrong.)

**2. What install is correct, and what does it cost?** A real `pnpm install` rebuilds
the virtual-store `@kampus/*` links **worktree-local** (verified: post-install,
`.pnpm/node_modules/@kampus/db-schema` resolves under the worktree, so worktree edits are
what gets checked). With a warm machine-global store it costs **~3.7 s**
(`pnpm install --prefer-offline --ignore-scripts`, pnpm v10.27.0). But it needs
node + pnpm — exactly what the PATH-stripped spawn env lacks.

## Decision

1. **Worktree deps are provisioned only by a real `pnpm install`, never a filesystem
   share of the primary's `node_modules`.** A share cannot preserve workspace-edit
   correctness (the virtual-store relative-source-link trap above), so it is rejected
   outright — not as a perf trade-off but as a correctness one.

2. **`bootstrap-deps` does the correct, version-pinned install whenever it CAN run with a
   toolchain on PATH** (a normal full-PATH `git worktree add`): it pins `pnpm@10.27.0`
   (via corepack when present, honoring `packageManager`), **refuses to install under a
   non-10 major** (the stale per-machine pnpm 8 the lockfile rejects), and runs
   `pnpm install --prefer-offline --ignore-scripts`. `--ignore-scripts` is deliberate: a
   worktree shares `.git/hooks` (the common dir), so firing `prepare` (`lefthook install`)
   from a worktree install would rewrite the **shared** hooks.

3. **When no toolchain is on PATH, `bootstrap-deps` is a clean SKIP (exit 0)** — no
   regression to the #787/#788/#789 creation-path fixes — and prints the one command to
   provision later under a full PATH.

4. **The harness-spawn case is therefore deferred-by-construction, and closing it
   fully is a harness change, not a repo one.** Because the correct install needs a
   toolchain the stripped spawn env does not have, the repo cannot run it *at spawn*. The
   repo provides the correct, idempotent, version-pinned entrypoint; the harness should
   invoke it **once, post-`git worktree add`, with a full PATH** (it already runs the
   agent with a full PATH — it just needs to run the provision step before first use), or
   equivalently stop stripping PATH for the worktree-add exec so the post-checkout hook
   itself can install. Until then, a worktree-spawned agent runs `pnpm install` once on
   first use — the documented one-time step, not the version-guessing manual bootstrap.

## Consequences

- **Correctness is preserved by construction.** No share is ever attempted, so the
  silent "checks ran against the primary's source" failure mode cannot occur.
- **Normal `git worktree add` is now fully self-provisioning at the correct version** —
  no manual `corepack pnpm@10.27.0 install` step, and never an install under the stale
  pnpm 8.
- **The harness-spawn AC is honestly split:** version-safety and the correct mechanism are
  repo-owned and met; *automatic* provisioning at the stripped spawn is harness-owned and
  recommended here. This ADR is the durable record so the next agent does not re-attempt
  the naive `node_modules` symlink that the virtual-store trap defeats.
- Sibling context: #787/#788/#789 (creation-side PATH-strip fixes, closed), #1243
  (remove-side, open), #504 (the original auto-install-on-create intent this restores).
