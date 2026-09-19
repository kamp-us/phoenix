# @kampus/tuval-boot-proof

The one thing no single `@kampus/tuval-*` package can show on its own: **all four of them on one
desk, named by package name, with nothing under `apps/tuval` changed.**

It is not a program. It is one file — [`.tuval/tuval.config.ts`](.tuval/tuval.config.ts) — held to
compile by `pnpm typecheck` and booted by hand when someone wants to see it run.

## Why it is a package

The config imports `@kampus/tuval-cron`, `@kampus/tuval-shell`, `@kampus/tuval-notify` and
`@kampus/tuval-worktree` **by name**. Node resolves a bare specifier from the importing module's
own location, so the file has to sit somewhere all four are installed. Nowhere in this repo was:
`apps/tuval` depends on none of them (that is the point of the epic), and each of the four has only
its own siblings. A workspace member that declares all four is the smallest thing that makes the
import work — and it keeps the dependency out of `apps/tuval`, where it is not allowed to go.

It runs no tests, so `pnpm -r --filter './packages/tuval-*' test` is unchanged by its existence.

## The proof

Two layers. The **global** layer is this file; the **project** layer is
`apps/tuval/.tuval/tuval.config.ts`, which is where the desk shell is registered and which this
proof does not touch. Boot merges the second over the first by row id.

```sh
pnpm -r --filter './packages/tuval-*' build
cd apps/tuval
node src/bin.ts --config ../../packages/tuval-boot-proof/.tuval/tuval.config.ts
```

The boot line names both layers and counts the rows — eight from the app, four from here:

```
tuval: booted — 12 program(s), 34 spell(s) registered from …/packages/tuval-boot-proof/.tuval/tuval.config.ts + …/apps/tuval/.tuval/tuval.config.ts; 7 process(es) live, 0 restored from …/apps/tuval/.tuval
tuval: process commands      program=commands      ports=prompt:in(commands/prompt),result:out(commands/result),…
tuval: process nightly-fetch program=nightly-fetch ports=run:in(nightly-fetch/run),brief:out(nightly-fetch/brief),…
tuval: process desk          program=desk          ports=message:in(desk/message),delivered:out(desk/delivered),…
tuval: process reviews       program=reviews       ports=open:in(reviews/open),close:in(reviews/close),…
```

**The `build` first is not a convenience.** Each package's `exports` answers `dist/index.js` under
`default` and `src/index.ts` under `development`, and boot loads a config with plain `node` — so
without a build there is no `dist` to reach. `--conditions=development` points at the source
instead, and today that path stops on `@kampus/tuval-shell`: `src/run.ts` uses a constructor
parameter property, which node's strip-only type-stripping refuses. Building is therefore both the
working path and the honest one, because `dist` is what a user installing from a registry gets.
