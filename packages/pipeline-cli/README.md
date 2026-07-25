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

## How a guard fails

Every guard's `check` routes its `CheckFailed` through the shared handler in
[`src/gate-fail.ts`](./src/gate-fail.ts): the human report goes to stderr, the process
exits 1, and — only when `GITHUB_ACTIONS` is set — GitHub `::error` workflow commands go
to stdout so the failure renders as an inline PR annotation instead of a log dig. Local
runs are byte-identical to before.

A guard that knows where its failure lives attaches `annotations` to its `CheckFailed`
(see `catalog-guard` and `readme-guard`, which point at the offending manifest and line);
one that doesn't gets a single bare `::error` carrying the report head. Build annotations
with the constructors in [`src/annotate.ts`](./src/annotate.ts) — `unlocated`, `atFile`,
`atLine` — never by hand-formatting the command string, and wrap the build in
`annotationsOrNone` so a throw while computing them can never swallow the report.

## How a tool reads stdin

Every tool that takes its input on a pipe reads it through `readStdinTextOrExit` in
[`src/read-stdin.ts`](./src/read-stdin.ts) — never `readFileSync(0, …)` in a `try`/`catch`.

`readFileSync(0, …)` throws `EAGAIN` when fd 0 is a non-blocking pipe, which depends on what
is upstream and so happens intermittently. Wrapped in a swallow-to-empty, that throw made an
*unread* pipe look exactly like an *empty* one: a gate then computed its verdict over no
evidence and reported the vacuous green as a real zero scope. The shared reader retries
`EAGAIN` until the pipe drains, and a pipe that stops making progress fails loud instead —
it reports the stall on stderr and exits 4. An empty string now means an empty pipe and
nothing else. A TTY with nothing piped in still returns immediately rather than blocking on
a keystroke.

Take `readStdinText` instead when the tool wants to handle the failed read itself: it carries
the outcome as a typed `StdinReadFailed` in the error channel. The pure retry core, with its
IO injected so the `EAGAIN` path is testable, lives in
[`src/read-stdin-core.ts`](./src/read-stdin-core.ts).

## Development

The source lives in the phoenix monorepo under
[`packages/pipeline-cli/`](https://github.com/kamp-us/phoenix/tree/main/packages/pipeline-cli).

```bash
pnpm --filter @kampus/pipeline-cli typecheck
pnpm --filter @kampus/pipeline-cli test
pnpm --filter @kampus/pipeline-cli build
```

A test that spawns the real bin, a hook script, or `git` declares
`{timeout: SUBPROCESS_TEST_TIMEOUT_MS}` on its `describe` — see
[`src/test-budget.ts`](https://github.com/kamp-us/phoenix/blob/main/packages/pipeline-cli/src/test-budget.ts).

## License

MIT.
