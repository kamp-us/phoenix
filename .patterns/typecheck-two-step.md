# The two-step `typecheck` script

Every workspace package's `typecheck` script runs two commands, in this order:

```jsonc
"typecheck": "tsc -p tsconfig.json && effect-tsgo diagnostics --project tsconfig.json --strict"
```

`tsc` answers the TypeScript question. `effect-tsgo diagnostics` answers the Effect
language-service question. Both are plain CLI runs off `node_modules/.bin`, so a checkout that
installed its dependencies has the whole gate — there is no install-time state to get wrong.

## Why two commands and not one patched compiler

Until [#7804](https://github.com/kamp-us/phoenix/issues/7804) the Effect diagnostics came from a
*patched* `tsc`: a root `postinstall` ran `effect-tsgo patch`, which swapped the native compiler
binary inside `node_modules` for the Effect Language Service build (ADR
[0271](../.decisions/0271-one-compiler-effect-patched-tsc.md)). That patch was state in
`node_modules`, not in git, so whether a checkout saw Effect diagnostics depended on whether one
postinstall step happened to run in it.

In a fabrika agent worktree it did not. `lefthook.yml`'s `post-checkout` `bootstrap-deps` runs
`pnpm install --prefer-offline --ignore-scripts`, which skips the root `postinstall`. The worktree
got a complete, lockfile-correct `node_modules` and a pristine compiler that dropped every Effect
diagnostic and exited 0. Nothing anywhere said the compiler was unpatched. On epic #7499 that cost
child #7560 two review rounds against a false green.

The two-step script has no such variable. CI, an agent worktree and a developer's machine all run
the same two commands over the same installed binaries.

## The flags are load-bearing

- **`--strict`** is what makes a `warning`-severity diagnostic set a non-zero exit. Without it
  `effect-tsgo diagnostics` exits 0 on the same findings, so a package that drops the flag silently
  stops gating.
- **`--project tsconfig.json`** is the package's own config. For `apps/web` that is the solution
  file, and `effect-tsgo` follows its `references` — one run covers the app, worker and node
  projects.
- **`message`-severity diagnostics never affect the exit code.** They print, they do not fail. That
  matches what the patched `tsc` did with the root `tsconfig.json`'s
  `includeSuggestionsInTsc: false`, and it is why a green run can still print a wall of `message`
  lines.

## Adding a package

A new workspace package needs both halves or its Effect diagnostics are invisible:

1. `"@effect/tsgo": "catalog:"` in `devDependencies`, so `effect-tsgo` links into that package's
   `node_modules/.bin`.
2. The two-step `typecheck` script above.

`packages/fabrika-cli/src/typecheck-shape.repo.test.ts` reads every workspace manifest and reds when
a package with a `typecheck` script omits either half, so the shape cannot drift back one package at
a time.

## A stale patched checkout

A checkout that installed *before* this change still carries a patched `tsc` in `node_modules`,
because removing the `postinstall` does not un-swap a binary that is already swapped. Such a tree
prints each Effect diagnostic twice — once from the patched `tsc`, once from `effect-tsgo` — and its
`tsc` step can fail on a warning. `pnpm exec effect-tsgo unpatch` is the tool's own inverse — it
restores the binary from the `.original` backup the patch left beside it. A fresh `node_modules` has
nothing to undo.
