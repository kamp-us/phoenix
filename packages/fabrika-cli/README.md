# @kampus/fabrika-cli

The deterministic verb package the [fabrika](../../claude-plugins/fabrika/) skills call.
`fabrika <group> <verb> …` dispatches to a registered verb group. fabrika's architecture is a
two-layer split: deterministic work is pushed into CLI verbs, and each skill is a thin wrapper
carrying only the judgment that cannot be mechanized. This package is the deterministic layer. It
is internal tooling for the kamp.us agent pipeline, not a general-purpose CLI.

The **verb reference** — what each group does and what its exit codes mean — is on
[`docs/verb-reference.md`](./docs/verb-reference.md). For what fabrika is and how to run it, read
[the guide](../../claude-plugins/fabrika/guide/README.md).

## Install

```bash
pnpm add --global @kampus/fabrika-cli
```

> [!NOTE]
> The package is on the public npm registry, so the line above works. A bare `fabrika` still exits
> `127` on a machine that has not installed it — the shell reporting that nothing ran, never a
> verdict. Inside a phoenix checkout the no-install fallback is
> `node packages/fabrika-cli/src/bin.ts …`.

`fabrika` is installed globally once, and the binary decides for itself which copy runs. On startup
it finds the **repo root** above the working directory, asks **Node's own resolver** what copy of
`@kampus/fabrika-cli` that root has installed, and hands the invocation to it — the shape
[turbo](https://turborepo.com) ships, reimplemented here in TypeScript.

| Where you are | What runs | Warning |
| --- | --- | --- |
| In phoenix | the working tree — `packages/fabrika-cli` | — |
| In a **git worktree** of phoenix | that worktree's `packages/fabrika-cli` | — |
| In a consumer repo that installed it | that repo's pinned version | — |
| In a consumer repo that did **not** install it | the global | **yes**, naming both versions |
| In no repo at all | the global | no — deliberately |
| Running a copy from a **different repository** by path | nothing — it refuses, exit `126` | **yes**, naming both checkouts |

No outcome is both silent and wrong. Running the global outside any repo is a correct invocation,
so it stays quiet; running it inside a repo that pinned a version is the quietly-wrong case, so it
says so and names both versions. `FABRIKA_GLOBAL_WARNING_DISABLED=1` silences that one.

Four rules make those rows hold:

- **A copy invoked by path from another repository is refused, not delegated to.** Otherwise it
  answers about a repository you did not name — the live hazard when you review from a second
  checkout ([#4956](https://github.com/kamp-us/phoenix/issues/4956)). Pass `--skip-infer` to make
  the copy you named serve the invocation.
- **Worktrees of one repository delegate to each other** (row two). The comparison is the
  repository, not the checkout: two trees' `$GIT_COMMON_DIR` is read off disk and equal common
  dirs delegate. A tree whose repository cannot be established counts as a different one.
- **A resolved install must live at or under the repo root.** Node falls back to `NODE_PATH` after
  the `node_modules` walk, and pnpm's global shim exports a `NODE_PATH` chain rooted at the
  checkout it was installed from — so anything resolved outside the repo is `absent`, whatever
  Node found.
- **Two recursion guards, both read before any filesystem work.** The parent passes `--skip-infer`
  to the child (stripped before any verb sees it), and `FABRIKA_SKIP_INFER` does the same for a
  caller that cannot alter argv.

The child's cwd is the **repo root**, not yours; your cwd travels as `FABRIKA_INVOCATION_DIR`, so
an older local binary cannot choke on it the way it would on an unknown flag. `FABRIKA_DEBUG=1`
prints one stderr line naming which copy served the invocation.

The property this buys is a **repo-pinned version**: phoenix carries `@kampus/fabrika-cli` in its
root `devDependencies`, so a bare `fabrika` in a phoenix checkout runs the working tree — edit
`src/`, the next invocation runs the edit.

### The two Node floors

The two entry points need different Nodes, so the manifest carries two floors:

| Floor | Where it lives | What it is | Who reads it |
| --- | --- | --- | --- |
| `>=22.12` | `publishConfig.engines.node` | what the compiled `dist/` runs on | consumers, via the tarball |
| `>=24` | top-level `engines.node` | what the `.ts` `bin` needs for type stripping | this workspace |

Node refuses to strip types for any file under `node_modules`, so a `.ts` `bin` cannot start from
an installed copy. `publishConfig` is what lets both halves be true: the manifest's `bin` stays
`./src/bin.ts` for the workspace, where pnpm's link resolves outside `node_modules`, and npm
rewrites `bin`/`main`/`types`/`exports`/`engines` onto the compiled `dist/` at publish time.
`files` is `["dist", "scripts"]` and `prepublishOnly` runs the build.

`>=22.12` is measured, not assumed: `dist/bin.js` is clean on 22.12 and up, warns on 22.11
(`ExperimentalWarning: Importing JSON modules`), and throws on Node 20 and 18, where `undici`'s
`webidl.util.markAsUncloneable` does not exist. The dev floor `>=24` is conservative — the `.ts`
`bin` starts on 22.18+ — and `volta.node` pins `26.2.0` here and at the root.

### The one prerequisite: a GitHub token

Every verb that touches GitHub needs a credential in the environment — `GITHUB_TOKEN`, else
`GH_TOKEN`. There is **no `gh` prerequisite**: the package reaches api.github.com over HTTP
([`src/io/gh-api.ts`](./src/io/gh-api.ts)), so a verb runs on a machine, a container or a client
that never installed the binary. `guard no-gh check` is what keeps it that way, on every push.

`gh auth token` is still read, and only as a convenience: with neither env var set and `gh` on
`PATH`, the credential is resolved from an existing login once, before any request, never on a
request path. A credential that resolves nowhere is a refusal naming both env vars — never an
anonymous call. The order and its reasons are ADR
[0315](../../.decisions/0315-fabrika-cli-github-token-resolution-and-the-three-non-rest-carves.md).

## Quickstart

```bash
# list the registered verb groups
node src/bin.ts --help

# one group's verbs, flags and exit codes
node src/bin.ts adr --help

# run a verb
node src/bin.ts adr next
```

The `--help` index is derived from [`src/registry.ts`](./src/registry.ts) — a group appears by
being registered and nowhere else. Each verb's own `--help` states its flags and every exit code it
can produce, so the per-verb detail lives there rather than here.

## The interface every verb meets

Governed by
[`claude-plugins/fabrika/docs/cli-interface-convention.md`](../../claude-plugins/fabrika/docs/cli-interface-convention.md).
Four rules matter most to a caller:

- **Stdout is the answer; everything else is stderr.** Scope lines, refusal reasons and progress
  are diagnostics.
- **The positive answer is a positive token, never an absence.** `adr sweep` prints `no-overlap`,
  not an empty shortlist — a verb whose "nothing found" answer is empty stdout is byte-identical to
  a verb that never ran.
- **The exit status is the answer; empty stdout never is.** `0` = the answer is on stdout, `1` =
  usage error or the verb failed to run, `126` = the binary started but could not resolve an
  implementation, `127` = the verb never ran, `3`+ = the verb's own proven outcomes. **A non-zero
  exit is UNKNOWN** — read the status before the bytes. `2` is allocated by nothing: it is the code
  a `PreToolUse` hook blocks a tool call on, so a fabrika exit there would deny a spawn as a side
  effect of its status.
- **Fail closed on missing scope or state.** A zero-record scan is a failed read, not an answer
  ([ADR 0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)); an unreadable input
  resolves to a refusal, never to a permissive default.

## Reference

Every registered verb group — its verbs, its flags and its exit codes — is on
[`docs/verb-reference.md`](./docs/verb-reference.md), together with the shared exit table those
codes are read against and the `capture` library subpath. Each verb's own `--help` states the same
contract at the point of use.

## Development

```bash
pnpm --filter @kampus/fabrika-cli test        # vitest
pnpm --filter @kampus/fabrika-cli typecheck   # tsc
pnpm --filter @kampus/fabrika-cli build       # tsc -> dist/, for the published tarball only
```

**The development loop has no build step.** `bin` points at `./src/bin.ts` and Node ≥ 24 strips the
types natively, so an edit to `src/` is live on the next invocation. `build` emits `dist/` for the
published tarball and nothing else reads it; see [the two Node floors](#the-two-node-floors) for
why `≥ 24` is this workspace's number and not the published package's. Emit and type-check run the
same binary — the stable native `tsc` (ADR 0271) — so the published artifact and the gate cannot
disagree about the compiler.

This package re-implements v1's work and never calls into it (ADR
[0238](../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)); v1 is deleted, so that is
history rather than a live constraint.

A verb is a **pure function of its dependencies** — the `*-verb.ts` modules compute a `VerbOutcome`
(exit code, stdout, stderr) and never write a stream or exit. The Effect CLI layer in each group's
`command.ts` does both. That split is what makes each refusal as deterministically testable as each
answer, which is why the tests can drive an unreadable directory, a 200 carrying the wrong bytes,
and a base ref that cannot be fetched.

Those dependencies are the **Effect platform services**, never a raw `node:*` import: the
filesystem is `FileSystem` / `Path` from `effect`
([.patterns/effect-platform-access.md](../../.patterns/effect-platform-access.md)) and the
subprocess is `ChildProcess` / `ChildProcessSpawner` from `effect/unstable/process`
([.patterns/effect-process-cli-shell.md](../../.patterns/effect-process-cli-shell.md)), both
satisfied by the one `NodeServices.layer` [`src/run.ts`](./src/run.ts) provides. A test substitutes
those same services rather than a hand-rolled double, so the seam under test is the seam production
uses. A read that could not be performed fails on the `E` channel — it never resolves to an empty
value a caller could forget to distinguish from a real one.

Two raw boundaries survive, both named rather than overlooked. **fd 0** stays a raw `node:fs` read
in [`src/io/stdin.ts`](./src/io/stdin.ts), with the verbs taking that read as an injected effect so
the `EAGAIN` and TTY paths stay testable. And the delegation layer reads `process` — `cwd()`,
`argv`, `execPath`, `env`, `exit()` — confined to
[`src/delegate/entry.ts`](./src/delegate/entry.ts); the walk and the decision it feeds are Effects
over the platform services, so every branch is driven by substituted services rather than a real
tree.
