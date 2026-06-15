---
id: 0060
title: Worktree-Isolated Gates Lint Explicit Paths, Not `biome check .`; In-Worktree Typecheck Is Not Authoritative
status: accepted
date: 2026-06-15
tags: [pipeline, skills, write-code, review-code, lint, typecheck, agents, worktree]
---

# 0060 — Worktree-Isolated Gates Lint Explicit Paths, Not `biome check .`; In-Worktree Typecheck Is Not Authoritative

## Context

`write-code` (Step 4) runs in a full isolated git worktree under `.claude/worktrees/<id>/`,
and `review-code` (Step 2) runs in an ADR-0052 non-cone *sparse* worktree. Both documented
`pnpm lint` (= `biome check .`) as the lint gate. That invocation false-greens from inside a
worktree (#236).

`biome.jsonc` retains `!**/.claude/worktrees` (the #119 narrowing, so the repo's own
`.claude/**` is still linted at the repo root). But a worktree's CWD *physically* sits under
`.claude/worktrees/<id>`, so bare `.` resolves to a path that matches that exclusion. Biome
reports "Checked 0 files … These paths were provided but ignored: - ." and **exits 0 without
linting anything** — a false green. Verified in this worktree against biome 2.4.15: from the
worktree root, `biome check .` returns the "0 files / ignored" no-op (exit 0), while
`biome check apps/web/src/<file>` and `biome check apps packages` both catch a planted
`noRedeclare` (exit 1). This is the `.`-invocation false-pass #119's acceptance bullet 1
named but a config-only fix could not close without dropping the required worktree exclusion.

#236 also surfaced a *deeper* half: the ADR-0052 sparse review worktree cannot bootstrap
`pnpm typecheck` at all. Under its allowlist (`/apps/ /packages/ pnpm-workspace.yaml
pnpm-lock.yaml package.json turbo.json tsconfig.json`): `biome.jsonc` + its plugin files
aren't checked out (plugin load error), `pnpm install` dies hashing a `patches/` entry
(ADR 0038), `turbo` mis-resolves, and the `apps/web` typecheck prereq `fate generate` isn't
built in the sparse tree (`fate: command not found`). That half is not yet nameable as a
single fix — it needs a decision between expanding the allowlist and replacing the isolation
mechanism — so it is **out of scope here** and tracked separately.

## Decision

**Lint explicit paths, never bare `.`, from inside a worktree.** `write-code` Step 4 and
`review-code` Step 2 lint the *changed files* when there are any, else the source roots —
never bare `.` (which self-no-ops) and never an empty path set (which biome resolves to the
ignored CWD, the same no-op). The verified invocation:

```bash
CHANGED="$(git diff --name-only --diff-filter=ACMR origin/main...HEAD | grep -Ev '^node_modules/' || true)"
if [ -n "$CHANGED" ]; then pnpm exec biome check $CHANGED; else pnpm exec biome check apps packages; fi
```

The non-empty branch is the precise, changed-files form; the empty branch falls back to the
CWD-robust source roots (`apps packages`), **not** to bare `.`. Both branches were verified
to catch a planted `noRedeclare` and exit 1 from inside this worktree; bare `.` did not.
`review-code` runs the source-roots form scoped to its review worktree
(`pnpm -C "$REVIEW_WT" exec biome check apps packages`), since its changed-set lives on the
PR head ref, not against `origin/main` in that tree.

**The sparse review worktree's in-worktree typecheck is NOT authoritative.** Until the
bootstrap is fixed, when `review-code`'s in-worktree `pnpm typecheck` cannot run, the gate
takes the **PR's own CI checks** (and the SHA-bound run-evidence bundle, ADR 0054) as the
typecheck behavior signal — the recorded workaround, not a gap in the verdict. `write-code`
runs in a *full* worktree where `pnpm install` / `pnpm typecheck` work, so it keeps running
typecheck locally; only its lint invocation changes.

## Consequences

- The worktree lint gate can no longer false-green: it lints real files (changed or source
  roots) and exits non-zero on a violation, restoring the signal #119/#236 targeted.
- A precise, isolation-friendly fix: no allowlist creep (which would erode ADR 0052's
  isolation) and no harness-level worktree relocation (out of band for a skill edit). Both
  alternatives were rejected here — allowlist creep defeats the isolation the sparse checkout
  buys, and relocating worktrees is a harness change, not a gate-instruction change.
- `review-code` is explicit that an un-run typecheck is deferred to CI, not silently asserted
  — the verdict states which signal it leaned on.
- Follow-up: the in-worktree (sparse) typecheck-bootstrap half — biome plugins, `patches/`
  hashing, `fate generate` — is tracked in **#336** (candidate approaches: expand the
  allowlist vs. a different isolation mechanism), to be resolved by its own decision.
