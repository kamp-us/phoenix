---
id: 0060
title: Worktree-isolated write-code/review-code gates lint EXPLICIT paths (changed files, else `apps packages`), never `biome check .` — bare `.` resolves to the worktree CWD under `.claude/worktrees`, matches the retained exclusion, and exits 0 without linting (false green, #236); the sparse review worktree's in-worktree typecheck is NOT authoritative (bootstrap can't run) — CI is the typecheck authority until #336
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
built in the sparse tree (`fate: command not found`). That half was **out of scope here** and
tracked separately — it needed a decision between expanding the allowlist and replacing the
isolation mechanism. **That decision was made in ADR
[0067](0067-sparse-typecheck-bootstrap.md): cone-mode-minus-instruction-denylist**, which
restores the in-worktree typecheck (see the reversal note below).

## Decision

**Lint explicit paths, never bare `.`, from inside a worktree.** `write-code` Step 4 lints
the *biome-handled changed files* when there are any, else a clean skip — never bare `.`
(which self-no-ops) and never an empty path set (which biome resolves to the ignored CWD,
the same no-op). The verified invocation:

```bash
CHANGED="$(git diff --name-only --diff-filter=ACMR origin/main...HEAD \
  | grep -Ev '^node_modules/' \
  | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css|graphql)$' || true)"
if [ -n "$CHANGED" ]; then
  pnpm exec biome check --files-ignore-unknown=true $CHANGED
else
  echo "no biome-handled changed files to lint"
fi
```

The non-empty branch is the precise, changed-files form, filtered to biome-handled
extensions; the empty branch is a clean skip (exit 0), **not** bare `.`. **A docs/markdown-only
changed set is a clean skip (exit 0) by affirmatively containing zero biome-handled files —
the extension filter empties `$CHANGED` so the `else` branch runs — not a blind no-op that
linted the wrong path.** This closes both failure modes the gate must avoid: a false-green
(bare `.` linting nothing) *and* a false-red (a docs-only diff hitting biome's "No files were
processed" exit 1). The original #236 form was a false-green; an unfiltered `biome check
$CHANGED` would be a false-red on docs-only PRs. Verified on biome 2.4.15 from inside this
worktree: a planted `.ts` `noRedeclare` in the changed set → exit **1**; a markdown-only
changed set → clean skip (exit **0**); an empty changed set → clean skip (exit **0**).
`--files-ignore-unknown=true` alone does *not* rescue an entirely-unknown path set (it still
exits 1 "No files were processed" on 2.4.15) — the **extension filter** is the load-bearing
mechanism; the flag only suppresses per-file unknown errors inside an otherwise non-empty
mixed set.
`review-code` runs the source-roots form scoped to its review worktree
(`pnpm -C "$REVIEW_WT" exec biome check apps packages`), since its changed-set lives on the
PR head ref, not against `origin/main` in that tree.

**The sparse review worktree's in-worktree typecheck is NOT authoritative.**
**SUPERSEDED by ADR [0067](0067-sparse-typecheck-bootstrap.md) (#388):** `review-code`'s
review worktree is now a cone-mode checkout minus a fixed instruction denylist, which carries
the full build inputs, so the in-worktree `pnpm typecheck` bootstraps and **is authoritative
again** — CI + the run-evidence bundle return to *corroboration*. The note below records the
original deferred-to-CI workaround for history.

Until the bootstrap was fixed, when `review-code`'s in-worktree `pnpm typecheck` could not
run, the gate took the **PR's own CI checks** (and the SHA-bound run-evidence bundle, ADR
0054) as the typecheck behavior signal — the recorded workaround, not a gap in the verdict.
`write-code` runs in a *full* worktree where `pnpm install` / `pnpm typecheck` work, so it
keeps running typecheck locally; only its lint invocation changes.

## Consequences

- The worktree lint gate can no longer false-green *or* false-red: it lints the real
  biome-handled changed files and exits non-zero on a violation, while a docs-only (or empty)
  diff is a clean skip — restoring the signal #119/#236 targeted without blocking legitimate
  docs-only changes.
- A precise, isolation-friendly fix: no allowlist creep (which would erode ADR 0052's
  isolation) and no harness-level worktree relocation (out of band for a skill edit). Both
  alternatives were rejected here — allowlist creep defeats the isolation the sparse checkout
  buys, and relocating worktrees is a harness change, not a gate-instruction change.
- `review-code` *was* explicit that an un-run typecheck is deferred to CI — superseded once
  ADR [0067](0067-sparse-typecheck-bootstrap.md) (#388) restored the authoritative in-worktree
  typecheck; the deferred-to-CI path now applies only when the in-worktree run genuinely cannot
  execute, and the verdict still states which signal it leaned on.
- Follow-up (RESOLVED): the in-worktree (sparse) typecheck-bootstrap half — biome plugins,
  `patches/` hashing, `fate generate` — was tracked in **#336** and decided by ADR
  [0067](0067-sparse-typecheck-bootstrap.md) (cone-mode-minus-instruction-denylist over
  expanding the allowlist), wired in **#388**.
