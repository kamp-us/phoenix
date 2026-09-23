# @kampus/app-boundary-guard

The CI check that keeps apps out of every other package's dependency graph (#9660, #9727).

## Why it exists

Anything under `apps/` is an app, apps are named `@kampus-apps/*`, and an app is never
imported ([founder ruling on #9646](https://github.com/kamp-us/phoenix/issues/9646)). A
package that reaches into an app can't be published or used on its own, so this check
reds when:

- a workspace package outside `apps/` lists an `@kampus-apps/*` name in `dependencies`,
  `devDependencies`, `peerDependencies` or `optionalDependencies`,
- a source file outside `apps/` imports an `@kampus-apps/*` specifier, or
- a source file outside `apps/` imports a relative path that resolves under `apps/`,
  such as `../../apps/tuval/src/kernel.ts`.

The workspace root's `package.json` is judged too. Source means every file git lists
outside `apps/`, tracked or untracked but not ignored: package source, tests and
`.tuval/` configs, and root-level code that belongs to no workspace member, such as
`scripts/`, `benchmarks/`, `biome-plugins/`, `claude-plugins/` and `.pnpmfile.cjs`.
`node_modules`, `dist`, `coverage` and `.turbo` are skipped, because they hold output or
installed code, and so is `.claude/worktrees/`, because each entry there is a full copy
of another checkout.

## How to use it

```sh
pnpm --filter @kampus/app-boundary-guard check
```

It prints what it scanned and exits `0` when clean, `1` naming each offending manifest
field or file line, and `2` (UNKNOWN) when it could not read its scope: a missing or
unparseable `pnpm-workspace.yaml`, a manifest that is not a JSON object, a `git ls-files`
that fails, or zero packages or files in scope. CI's `app boundary` job in `ci.yml` runs
it on every pull request, and `ci-required` requires it.

The import match is deliberately broad. It reads `from`, `import`, `import()`,
`require()` and the vitest module doubles (`vi.mock` and friends) anywhere in the text,
comments included. A false red costs a reword; a false green lets an app import land.

## Layout

- `src/app-boundary.ts`: the pure core. It parses the workspace globs, decides which
  paths are in scope, finds dependency and import references, and turns a scan into a
  verdict and its report.
- `src/bin.ts`: the IO shell. It lists the tree through git and has zero runtime
  dependencies, so the CI job runs it with no `pnpm install`.
- `src/index.ts`: the public barrel.
