# Pi's project-package install runs outside the pnpm workspace

[`.pi/settings.json`](../.pi/settings.json) declares one project-scoped package,
`npm:@kampus/fabrika-pi` (ADR [0332](../.decisions/0332-fabrika-pi-ships-as-npm-package.md)), and pi
installs it into the generated, gitignored `.pi/npm/`. That directory sits inside this repository, so
a package manager run there sees phoenix's pnpm workspace above it unless it is told not to. The
setting that keeps it out is:

```json
"npmCommand": ["pnpm", "--ignore-workspace", "--config.catalog-mode=manual"]
```

All three entries are load-bearing. Read this before shortening the array.

## What each entry buys

**`pnpm`** picks pnpm over npm, which is both the repo rule and a correctness requirement. Pi reads
`npmCommand` in `@earendil-works/pi-coding-agent`'s `dist/core/package-manager.js`: `getNpmCommand()`
falls back to `{command: "npm", args: []}` when the setting is absent, and `getNpmInstallArgs()`
branches on `getPackageManagerName()` — the pnpm arm passes `--config.auto-install-peers=false` and
friends, every other arm passes npm's `--legacy-peer-deps`. `getPackageManagerName()` takes the token
after the last literal `--` in the array, or the first token when there is none, so leading flags do
not disturb the pnpm arm.

**`--ignore-workspace`** stops the install from writing to tracked files. Without it, pnpm resolves
`.pi/npm` against the repository's workspace root and rewrites `pnpm-lock.yaml` on every refresh —
and, on a machine whose pnpm config sets `catalog-mode` to `prefer` or `strict`, also appends an
entry to the root `pnpm-workspace.yaml` catalog. Every pi child refresh would then leave the tree
dirty, which is the state `fabrika build tree --require-clean` refuses (exit `13`), so the fix for one
stranded child would strand every lane.

**`--config.catalog-mode=manual`** stops pnpm writing `"@kampus/fabrika-pi": "catalog:"` into the
generated `.pi/npm/package.json`. That protocol is what npm rejects with `EUNSUPPORTEDPROTOCOL`, and
it also breaks pnpm on the *second* run: with `--ignore-workspace` in force, pnpm ignores the local
catalog it just wrote and fails with `ERR_PNPM_CATALOG_ENTRY_NOT_FOUND_FOR_SPEC`. `manual` is pnpm's
own default, so this entry only pins behaviour against a machine-global override — which is exactly
why it cannot be dropped: whether it matters depends on the operator's pnpm config, not on this repo.

## The repo's `catalog:` rule does not reach here

`.pi/npm/` is generated and gitignored, and it is not a workspace member (`pnpm-workspace.yaml` lists
`packages/*`, `apps/*`, `infra/*`). `fabrika guard catalog-guard check` scopes to workspace members,
so the plain `^x.y.z` range pnpm writes into that generated manifest is outside the every-dependency-
via-`catalog:` rule, not an exception to it. The rule governs committed workspace manifests; this one
is neither.

## Known cost

Pi's update check (`getLatestNpmVersion`) runs `<npmCommand> view <pkg> version --json`. pnpm routes
a leading global flag into its exec fallback, so `pnpm --ignore-workspace view …` tries to run a
binary named `view` instead of querying the registry. The call throws, `shouldUpdateNpm` catches it
and returns `true`, and pi reinstalls — which is idempotent and cheap. Tracked in
[#7396](https://github.com/kamp-us/phoenix/issues/7396).
