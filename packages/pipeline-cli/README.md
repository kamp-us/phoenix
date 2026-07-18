# @kampus/pipeline-cli

The command-line toolbox for the [kamp.us](https://github.com/kamp-us/phoenix) agent
pipeline. One subcommand router, `pipeline-cli <tool>`, dispatches to a registered tool.
Each tool is a small, deterministic, unit-tested utility the pipeline runs in place of
hand-rolled `gh`/`jq`/`git` glue: CI guards, verdict and claim helpers, and read-only
reporting views.

## Who it's for

kamp.us builds itself with a pipeline of coding agents, and this package is their shared
toolbox. It is internal tooling, not a general-purpose CLI. We publish it to npm only so a
fresh checkout can bootstrap the tools without cloning and building the monorepo first.
Outside that pipeline it has no stable API and no support guarantee. You are welcome to
read it, but it is built for our workflow.

### Why it's public

The pipeline installs this CLI at session start with a pinned, unauthenticated
`npm install @kampus/pipeline-cli@<pin>` from public npm. A public package keeps that
bootstrap auth-free: a fresh or foreign checkout gets the tools with no token and no
credentials wired into startup. A private package would push authentication into every
session start, so public is the load-bearing choice.

## Install

```bash
npm install -g @kampus/pipeline-cli
```

## Quickstart

```bash
# list every tool with a one-line description
pipeline-cli commands compact

# read one tool's flags
pipeline-cli <tool> --help

# run a tool
pipeline-cli <tool> …
```

`commands compact` prints the current, authoritative tool list. It is generated from the
tool registry, so it never drifts.

## The tools

For a fuller per-tool reference — what each tool does and the flags it takes — see
[TOOLS.md](./TOOLS.md).

## Development

The source lives in the phoenix monorepo under
[`packages/pipeline-cli/`](https://github.com/kamp-us/phoenix/tree/main/packages/pipeline-cli).

```bash
pnpm --filter @kampus/pipeline-cli typecheck
pnpm --filter @kampus/pipeline-cli test
pnpm --filter @kampus/pipeline-cli build
```

## License

MIT.
