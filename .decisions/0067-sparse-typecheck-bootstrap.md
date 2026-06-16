---
id: 0067
title: "`review-code`'s review worktree becomes **cone-mode minus a fixed instruction denylist** (`CLAUDE.md`/`.claude/**`/`.decisions/**`/`.patterns/**`), not the ADR-0052 non-cone product-only allowlist — so `biome.jsonc`+`biome-plugins/`, `patches/`, the catalog/lockfile, and `fate generate`'s deps are all present and the in-worktree `pnpm typecheck` is **authoritative again** (reversing 0060's defer-to-CI workaround). Rejects allowlist-expansion (Option A — wrong polarity, perpetual creep) and harness-level relocation (Option C — out of band for a skill edit); the one cost is that cone mode leaks top-level `CLAUDE.md`, so the denylist must be excluded+asserted-absent, not inherited from the pattern set. Refines 0052's mechanism (property preserved), resolves the #236/#336 deeper half; impl tracked in #388 (control-plane, human-merged)"
status: accepted
date: 2026-06-15
tags: [pipeline, skills, review-code, worktree, typecheck, isolation, biome, fate]
---

# 0067 — review-code worktree is cone-mode-minus-instructions, not a product-only allowlist — restoring the in-worktree typecheck

## Context

ADR [0052](0052-review-code-config-isolation.md) made `review-code`'s isolation real
*by construction*: the gate adds a **non-cone** sparse worktree off the PR head whose
allowlist materializes only the head's *product* paths
(`/apps/ /packages/ pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json
tsconfig.json`). Because the head's instruction surfaces (`CLAUDE.md`, `.claude/**`,
`.decisions/**`, `.patterns/**`) are *never in the allowlist*, they never land on disk,
so a head edit to `CLAUDE.md` cannot reach the reviewing agent's instruction path. That
is the load-bearing property — the reviewer reads its config from the trusted base, not
the branch it judges.

ADR [0060](0060-worktree-lint-changed-paths.md) fixed the *lint* half of #236 (lint
explicit paths, never bare `.`) and **deferred** a deeper half it surfaced: that same
product-only allowlist **cannot bootstrap `pnpm typecheck` at all**. Reproduced in #236
against biome 2.4.15, four independent breakages, each rooted in the same cause — a file
`typecheck` needs is outside the allowlist, so it is never checked out:

1. **biome plugins not present.** `biome.jsonc` declares
   `"plugins": ["./biome-plugins/no-type-assertions.grit"]`. Neither `biome.jsonc` nor
   `biome-plugins/` is in the allowlist; adding `biome.jsonc` alone yields
   `Error(s) during loading of plugins: Cannot read file` because the `.grit` file is
   still absent.
2. **`pnpm install` dies hashing a patch.** `pnpm-workspace.yaml` declares
   `patchedDependencies: { alchemy@2.0.0-beta.52: patches/alchemy@2.0.0-beta.52.patch }`
   (ADR [0038](0038-dependency-patches-local-only.md)). `patches/` is outside the allowlist, so
   install fails in `readNormalizedFile` / `createHexHashFromFile` hashing a file that
   isn't on disk.
3. **turbo mis-resolves.** With no `node_modules` (install failed) `turbo` reports
   `turbo_json_parse_error: unknown key 'tasks'` — it resolves against the wrong turbo
   version.
4. **`fate generate` can't run.** `apps/web`'s `typecheck` script is
   `pnpm fate:generate && tsgo …`, and `fate generate` needs the `fate` bin from the
   installed dep tree (`@nkzw/fate` via the catalog). No install → `fate: command not
   found`.

So today `review-code` Step 2 *can* lint (ADR 0060) but **cannot typecheck in-worktree**;
ADR 0060 records the workaround — lean on the PR's CI checks + the SHA-bound run-evidence
bundle (ADR [0054](0054-run-evidence-bundle.md)) as the typecheck signal. That is a
recorded workaround, not a faithful in-worktree verification: the gate's strongest
documented evidence ("typecheck is clean, run *in* the isolated tree") is unavailable, so
the isolation guarantee (0052) and the verify-by-running guarantee cannot both hold for
typecheck. This ADR chooses how to make them both hold again.

The tension is exactly the one 0052 named, surfacing one layer down: the reviewer
**needs more of the head's tree** to run `typecheck` (configs, patches, the full
workspace install), but **must not trust the head's *instructions*** (`CLAUDE.md`,
`.claude/**`, `.decisions/**`, `.patterns/**`). The allowlist conflated "what the
reviewer must not trust" with "what the reviewer must not check out" — but those are not
the same set. The instruction surfaces are a *small, named denylist*; the bootstrap
inputs are most of the rest of the repo.

## Options considered

**Option A — Expand the non-cone allowlist.** Add `biome.jsonc`, `biome-plugins/`,
`patches/`, and whatever `fate generate` transitively needs to the allowlist.
- *Pro:* smallest diff; keeps the non-cone mechanism 0052 specified verbatim.
- *Con:* it is an open-ended chase. `fate generate` needs the installed dep tree (the
  catalog, the lockfile, transitive workspace packages), not one nameable file — so the
  allowlist would grow toward "the whole repo" one breakage at a time. Every new build
  prereq (a new patch, a new codegen step, a new root config) silently re-breaks the gate
  until someone extends the list. The allowlist becomes a second, hand-maintained mirror
  of "everything the build touches," which is precisely the maintenance burden a checkout
  should not carry. It also **inverts the safe default**: a forgotten entry fails *open*
  toward "typecheck silently can't run" (the bug we have), and a careless entry could fail
  *open* toward leaking an instruction surface. The allowlist enumerates *what to include*,
  but the security property is about *what to exclude* — encoding a denylist as the
  complement of an ever-growing allowlist is the wrong polarity. ADR 0060 already rejected
  this for the same reason ("allowlist creep … defeats the isolation the sparse checkout
  buys").

**Option B — Cone-mode minus the instruction surfaces (CHOSEN).** Materialize the head's
*whole* product tree via cone mode, then explicitly *exclude* only the named instruction
surfaces, sourcing those from the base.
- The security set is the small *denylist* it actually is: `CLAUDE.md`, `.claude/**`,
  `.decisions/**`, `.patterns/**` — the ADR 0049 / 0052 harness boundary, named once.
- Everything the build needs (`biome.jsonc`, `biome-plugins/`, `patches/`, the catalog,
  the full workspace) is present *because it is not on the denylist* — no enumeration of
  build inputs, so no creep and no "new prereq silently re-breaks the gate."
- *The catch 0052 §"Non-cone, not cone" raised:* cone mode (`--cone`) always materializes
  **every top-level file** regardless of the pattern set, so a naive cone checkout would
  leak the head's **root `CLAUDE.md`** even if never listed. This ADR's mechanism must
  therefore *force the root `CLAUDE.md` (and `.claude/`, etc.) out of the tree after the
  cone checkout* (or replace it with the base copy), not rely on cone's pattern set to
  keep it out. The isolation property survives only if that exclusion is explicit and
  verified — it does not come for free from cone mode the way it did from the non-cone
  allowlist. This is the one real cost of B over A's polarity, and it is bounded: a fixed,
  named denylist + a post-checkout assertion that those paths are absent.
- *Pro:* fails *safe* — a new build prereq just works (it's not denied); the only thing
  that can go wrong is the denylist, which is short, fixed, and assertable. Restores a
  faithful in-worktree typecheck. Keeps 0052's "config from base, code from head" seam.
- *Con:* materializes more of the head's tree than strictly needed (the whole product
  workspace), and shifts the isolation from "never checked out" to "checked out then
  removed/overridden + asserted-absent." The window between checkout and exclusion must
  not be one the reviewing agent reads config in — the implementation does the exclusion
  before the agent's instruction path is established (it never `cd`s its session into the
  review tree; it runs head commands via `pnpm -C`, exactly as 0052/0060 already require).

**Option C — Replace the isolation mechanism at the harness level** (worktrees outside
`.claude/`, or a full second clone with config pinned to base).
- *Pro:* sidesteps both the allowlist and the cone-leak entirely; a full clone trivially
  bootstraps.
- *Con:* it is a *harness/runtime* change (where agent worktrees live, how the runner
  pins config), not a `review-code` *gate-instruction* change — out of band for a skill
  edit and a much larger blast radius (it touches every agent's worktree, not just the
  review gate). ADR 0060 already flagged "relocating worktrees is a harness change, not a
  gate-instruction change." It also doesn't *decide* the in-worktree question so much as
  move it; the cone-minus-denylist mechanism (B) lives entirely inside the SKILL where the
  decision belongs.

## Decision

**`review-code`'s review worktree becomes a cone-mode checkout of the head minus a fixed
instruction denylist (Option B), not a non-cone product-only allowlist.** The worktree
materializes the head's full product workspace — so `biome.jsonc` + `biome-plugins/`,
`patches/`, the catalog, the lockfile, and everything `fate generate` needs are present —
while the head's instruction surfaces are kept off the reviewing agent's path:

- **Denylist (the security set, fixed and named):** `CLAUDE.md` (root), `.claude/**`,
  `.decisions/**`, `.patterns/**` — the ADR [0049](0049-pipeline-ships-code-not-itself.md)
  / [0052](0052-review-code-config-isolation.md) harness boundary. These are excluded from
  (or replaced by the base copy in) the review tree, and the implementation **asserts they
  are absent** after checkout — cone mode would otherwise leak root `CLAUDE.md`, so the
  exclusion is explicit, not inherited from the pattern set.
- **Everything else** (the head's product tree + build inputs) is present *by default*,
  because the security property is the small denylist above — not the complement of an
  enumerated include-list.
- **Config still comes from the base**, code from the head — 0052's seam is unchanged. The
  reviewing agent never switches its session into the review tree; head commands run via
  `pnpm -C "$REVIEW_WT"`, so even the materialized-then-excluded instruction files never
  sit on the agent's instruction path.

With the bootstrap whole, **the in-worktree `pnpm typecheck` becomes authoritative again**:
`pnpm -C "$REVIEW_WT" install` succeeds (patches hashable), `fate generate` resolves, and
`pnpm -C "$REVIEW_WT" typecheck` runs. CI + the run-evidence bundle return to being
*corroboration*, not the sole signal — reversing ADR 0060's "in-worktree typecheck is NOT
authoritative" workaround once the implementation lands.

This is recording the *mechanism choice*; the implementation (rewrite Step 2's
`sparse-checkout --no-cone` + allowlist block, verify install/typecheck run, verify the
denylist is absent, and update ADR 0060's note) is tracked in **#388** (milestone
*Pipeline hardening*).

## Consequences

- **No allowlist creep.** The checkout's security set is a short fixed denylist; new build
  prerequisites work without editing the gate. The failure polarity flips from
  fail-open-toward-broken-typecheck to fail-safe.
- **The cone-leak is the one cost.** Cone mode materializes top-level files unconditionally,
  so the implementation must force the head's root `CLAUDE.md` / `.claude/` etc. out (or
  override with the base copy) and **assert their absence** — the isolation no longer comes
  free from the pattern set the way it did under non-cone. This assertion is the load-bearing
  check that keeps ADR 0052's guarantee intact; #388 must verify it.
- **The in-worktree typecheck is authoritative again** once #388 lands — restoring the
  gate's strongest documented behavior evidence and reversing ADR 0060's deferred-to-CI
  workaround for typecheck. ADR 0060's lint decision (explicit paths, never bare `.`) is
  unchanged and orthogonal.
- **Banned:** growing the non-cone allowlist to chase build inputs (Option A — wrong
  polarity, perpetual creep, ADR 0060 already rejected it); a cone checkout that relies on
  the pattern set alone to keep root `CLAUDE.md` out (it won't — cone materializes
  top-level files regardless); treating CI as the *authoritative* typecheck signal once the
  in-worktree run works (it returns to corroboration).
- **Relationship:** refines ADR [0052](0052-review-code-config-isolation.md)'s isolation
  *mechanism* (non-cone allowlist → cone-minus-denylist) while preserving its *property*
  (head config never on the reviewer's path) and its base÷head seam; resolves the deeper
  half ADR [0060](0060-worktree-lint-changed-paths.md) deferred (#236/#336) and will reverse
  0060's "in-worktree typecheck is NOT authoritative" note; rides the
  [0049](0049-pipeline-ships-code-not-itself.md) product÷harness boundary for the denylist.
  This ADR is a harness/control-plane decision and its implementation (#388) edits
  `skills/review-code/**`, a gate-critical skill (ADR
  [0065](0065-gate-critical-skills-are-blocking.md)) — both are **merged by hand**, not
  auto-shipped.
