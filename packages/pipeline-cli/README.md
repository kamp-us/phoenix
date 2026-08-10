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

## How a tool seats a verdict on an exit code

A classifier verb that can clear a hold — `cp-classify`, `guard-content-probe` — seats its
**proven-ordinary** verdict on `PROVEN_ORDINARY_EXIT_CODE` from
[`src/exit-codes.ts`](./src/exit-codes.ts), never on `1`. `1` is what a module-load failure
surfaces as; `127` is the shell's missing-binary code. A verdict sharing either is unreadable as
proof — `[ $? -ne 0 ]` then reads "the tool never ran" as "the tool ran and proved it ordinary".
This is the verdict-side twin of the stdin rule above (#4208, #4219).

A **malformed invocation** — an unrecognized flag, a typo'd subcommand — is the third way to never
run, and the router seats it on `BAD_INVOCATION_EXIT_CODE` (`4`, the same never-ran band as
`STDIN_READ_FAILED_EXIT_CODE`) rather than leaving it on effect-cli's default `1`. It used to land
on `1`, which is `cp-cardinality decide`'s `stop`: a caller that passed flags the verb never
accepted recorded four approved §CP PRs as definite stops from a decision that never ran (#5072).

The exit code discriminates verdicts **only once the verb has run**, so a caller asserts on the
**stdout state word** and treats every other value, including the empty string a failure to
invoke leaves, as a hold. Three outcomes stay distinguishable: proven-ordinary, proven-hold, and
could-not-determine.

## How a tool is loaded

Running `pipeline-cli <tool>` loads that tool's module and no other. The registry
([`src/registry.ts`](./src/registry.ts)) holds one row per tool — the selector name, and
the module import as a thunk — so the name is known without linking anything and the
module is linked only once that verb is dispatched. Only a listing (`--help`,
`commands compact`) resolves every row, because only a listing is about every tool.

That containment is the point. When the registry imported every tool's module up front,
one unresolvable row failed *every* invocation, including tools that had nothing to do
with it — and the pipeline runs many agents against one checkout, so a tool being written
right now is a normal state, not an exceptional one. A row that will not resolve now
fails just the verb that asked for it.

A load fault reports the registration by name:

```
pipeline-cli: registered tool `example` failed to load — its command module did not resolve (…)
  The registration is in packages/pipeline-cli/src/registry.ts. A tool that is mid-write in the
  working tree this CLI runs from looks exactly like this; every OTHER tool still works.
```

Two rules apply when adding a row. Write the `import()` with a **string-literal**
specifier — the build rewrites those extensions, and cannot rewrite a computed one. And
register the tool under the **same name** its `Command.make("<name>")` declares; the
loader asserts the two match, because the router selects on the registered name and the
CLI runtime dispatches on the declared one.

One case is deliberately not wrapped: an unlinked dependency still propagates untouched,
so the bin's install self-heal and its remediation message keep working.

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
