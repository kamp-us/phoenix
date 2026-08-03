# @kampus/fabrika-cli

The deterministic verb package [fabrika](../../claude-plugins/fabrika/) skills call.
`fabrika <group> <verb> …` dispatches to a registered verb group. Three groups are
registered: `adr`, the six verbs the `/adr` skill's derived contract specifies; `report`,
the three the `/report` contract specifies; and `eval`, the graded-corpus harness the
fabrika eval layer measures itself with.

## Who it's for

fabrika's architecture is a two-layer split: deterministic work is pushed maximally into
CLI verbs, and each skill is a thin wrapper carrying only irreducible judgment. This
package is the deterministic layer. It is internal tooling for the kamp.us agent pipeline,
not a general-purpose CLI.

## It calls nothing outside fabrika

**`fabrika` invokes `pipeline-cli` nowhere** — no import, no subprocess
([ADR 0238](../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Where v1
already solves the same problem, its source is a reference for the semantics and the scars,
never a dependency.

The reason is the deletion test: a fabrika that calls v1 can never be the thing that
replaces it, because every call is a tether keeping the old tree alive. Duplication costs a
second implementation during the transition; a tether costs the ability to ever delete
anything.

## How it is delivered

`fabrika` is installed **globally**, once, and the binary decides for itself which copy runs:

```bash
pnpm add --global @kampus/fabrika-cli
```

On startup it finds the **repo root** above the working directory, asks **Node's own resolver** what
copy of `@kampus/fabrika-cli` that root has installed, and hands the invocation to it. This is the
shape [turbo](https://turborepo.com) ships (`crates/turborepo-shim/`), reimplemented here in
TypeScript ([#4784](https://github.com/kamp-us/phoenix/issues/4784)).

There are exactly three outcomes, and **only one of them is silent**:

| Where you are | What runs | Warning |
| --- | --- | --- |
| In phoenix | the working tree — `packages/fabrika-cli` | — |
| In a consumer repo that installed it | that repo's pinned version | — |
| In a consumer repo that did **not** install it | the global | **yes**, naming both versions |
| In no repo at all | the global | no — deliberately |

The last two are the whole design. Running the global outside any repo is a normal, correct
invocation, so it stays quiet. Running the global *inside a repo that asked for a specific version*
is the quietly-wrong case, so it says so out loud and names the global's version beside the one the
root manifest declared. Set `FABRIKA_GLOBAL_WARNING_DISABLED=1` to silence it.

The property this buys is a **repo-pinned version**. phoenix carries `@kampus/fabrika-cli` in its
root `devDependencies`, so a bare `fabrika` anywhere in a phoenix checkout runs the version this
repo pins — and because pnpm links the workspace package, that means the **working tree**: edit
`src/`, the next invocation runs the edit. This supersedes `pnpm link --global`, which is
machine-wide and has to be remembered and undone.

`FABRIKA_DEBUG=1` prints one stderr line naming which copy served the invocation:

```
$ FABRIKA_DEBUG=1 fabrika --version
fabrika: global at …/pnpm/global/5/…/@kampus/fabrika-cli — delegating to the repo-local install at …/packages/fabrika-cli (…/src/bin.ts, v0.1.0)
fabrika v0.1.0
```

**Two independent recursion guards**, both read before any filesystem work: the parent always passes
`--skip-infer` to the child (stripped before any verb sees it), and `FABRIKA_SKIP_INFER` does the
same for a caller that cannot alter argv. turbo needs both because a missed guard would re-enter the
shim; we need them *more*, because for us the global and the local are the same JS file shape.

The child's cwd is the **repo root**, not yours; your cwd travels as `FABRIKA_INVOCATION_DIR`. That
is deliberate — an older local binary cannot choke on an env var it never reads, whereas it would
refuse an unknown flag.

> [!IMPORTANT]
> **`@kampus/fabrika-cli` is not published yet, so the install above does not work today.** It
> answers a registry 404 (`npm error code E404`, exit `1`, nothing on stdout). Publishing needs npm
> Trusted Publishing registered against this repo plus a one-time bootstrap publish — a human action
> outside the repo, tracked by [#4791](https://github.com/kamp-us/phoenix/issues/4791). Until it
> lands, a bare `fabrika` exits `127` on a machine with no global install, which the interface
> convention reserves for exactly that: the verb never ran. Inside a phoenix checkout the fallback
> is `node packages/fabrika-cli/src/bin.ts …`.

> [!WARNING]
> **A `.ts` `bin` cannot run from an installed copy, and that blocks the global half of the
> delegation.** Node refuses to strip types for any file whose resolved path is under
> `node_modules` — `stripTypeScriptModuleTypes` throws `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`
> unconditionally on `isUnderNodeModules(filename)` (verified against Node 24.4.1 and 26.2.0's own
> bundled source). Inside phoenix this is invisible, because pnpm links the workspace package and the
> resolved path is `packages/fabrika-cli/src/bin.ts`, outside `node_modules`. A real
> `pnpm add --global` lands under `node_modules` and therefore **cannot start**. The no-build
> development story and a runnable published artifact are in tension here; the resolution is a
> founder call, tracked on [#4784](https://github.com/kamp-us/phoenix/issues/4784).

## Quickstart

```bash
# list the registered verb groups
node src/bin.ts --help

# one group's verbs, flags and exit codes
node src/bin.ts adr --help

# run a verb
node src/bin.ts adr next
```

The `--help` index is derived from [`src/registry.ts`](./src/registry.ts) — a group appears
by being registered and nowhere else, so a parallel hand-written list cannot drift out of
step with what actually dispatches.

## The interface every verb meets

Governed by
[`claude-plugins/fabrika/docs/cli-interface-convention.md`](../../claude-plugins/fabrika/docs/cli-interface-convention.md).
Four rules matter most to a caller:

- **Stdout is the answer; everything else is stderr.** Scope lines, refusal reasons and
  progress are diagnostics.
- **The positive answer is a positive token, never an absence.** `adr sweep` prints
  `no-overlap`, not an empty shortlist — a verb whose "nothing found" answer is empty
  stdout is byte-identical to a verb that never ran.
- **The exit status is the answer; empty stdout never is.** `0` = the answer is on stdout,
  `1` = usage error or the verb failed to run, `2` = the binary started but could not resolve an
  implementation, `127` = the verb never ran, `3`+ = the verb's own proven outcomes. **A non-zero
  exit is UNKNOWN** — read the status before the bytes.
- **Fail closed on missing scope or state.** A zero-record scan is a failed read, not an
  answer ([ADR 0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)); an
  unreadable input resolves to a refusal, never to a permissive default.

## The `adr` group

The contract these six implement is
[`claude-plugins/fabrika/skills/adr/contract.md`](../../claude-plugins/fabrika/skills/adr/contract.md).

| Verb | Answers |
|---|---|
| `adr next` | the next unused id — `max(fetched merged set ∪ open-PR claims) + 1` |
| `adr new` | scaffolds `.decisions/NNNN-slug.md` from the canonical template |
| `adr resolve` | each id's real filename and state: `live` / `landed` / `in-flight` / `absent` |
| `adr supersede` | rewrites an older record's `status:` line to `superseded by [NNNN](…)` |
| `adr amend-in-part` | appends this id to an older record's `amended-in-part by` list |
| `adr sweep` | ranks the uncited live-accepted records this one may contradict |

Three behaviours are worth knowing before you call them:

- **`--base` is fetched before it is read.** Reading a stale local ref is the defect class
  the contract exists to close — it is how two lanes both minted ADR 0198, and how a stale
  checkout applied a withdrawn ADR 86 minutes after the withdrawal landed.
- **`live` and `landed` are different answers.** `landed` means present on the base ref but
  `proposed`, `superseded` or `retired`; 36 of the 233 records on `main` are in that state,
  and citing one as settled law is the failure this split exists to prevent.
- **`supersede` / `amend-in-part` assert a one-line diff before writing.** An accepted ADR's
  decision text is immutable, so a rewrite that would touch any line but `status:` aborts
  with exit 6 and writes nothing.

## The `report` group

The contract these three implement is
[`claude-plugins/fabrika/skills/report/contract.md`](../../claude-plugins/fabrika/skills/report/contract.md).

| Verb | Answers |
|---|---|
| `report dedup` | ranks the open issues that may already cover an observation — `candidates` / `none` / `indeterminate`, all three at exit 0 |
| `report file` | composes the intake issue from the six sections on stdin, guards it, creates it, and reads back what landed |
| `report note` | adds a note to an existing issue over the same guarded path, and reads the comment back |

Four behaviours are worth knowing before you call them:

- **The body is a value, never a path.** The two writing verbs take it on **stdin only** —
  no `--body`, no `--body-file`, no temp file. A flag that accepts a path turns the body
  into a string the verb could post verbatim, which is exactly how a machine-local path
  reached a public artifact while the poster read success. A shell redirect is fine: the
  *shell* reads the file, so what reaches the verb is already the bytes.
- **An empty stdin is a refusal, not an empty body.** A read that failed exits `1` (the body
  is UNKNOWN) and a pipe that was read and held nothing exits `3` (a proven refusal). They
  are never the same answer.
- **A missing `--label` is a refusal on `dedup` too, not a `none`.** `GET /issues?labels=…`
  answers HTTP 200 with `[]` for a label that does not exist, so an unchecked `dedup` would
  print a proven negative over a scope of zero — the fail-open ADR 0092 forbids. Both
  writing and reading verbs check the label first and exit `7` when it is absent
  ([#4752](https://github.com/kamp-us/phoenix/issues/4752)).
- **The write is not finished until it is read back.** A create call's own response is the
  server echoing the request; exit `9` is the landed artifact failing to match what was
  composed.

Intake applies **no type and no priority**, and that is defended mechanically rather than in
prose: exit `10` refuses a `--label` or a title prefix that resolves to the target repo's own
type/priority vocabulary.

## The `eval` group

The eval harness, moved here from v1 by founder ruling
([#4777](https://github.com/kamp-us/phoenix/issues/4777)) so that "the existing report and
scorecard path" the eval-layer children are specced against is a fabrika path rather than a
call into `pipeline-cli` that ADR 0238 forbids. Its own docs are
[`src/eval/README.md`](./src/eval/README.md).

| Verb | Answers |
|---|---|
| `eval check` | whether a corpus manifest matches the schema |
| `eval report` | the graded two-axis scorecard (pass-rate × net-token cost) over runner rows |
| `eval cases` | whether an authored eval set decodes, and the tier each case derives to |
| `eval run` | executes an eval set unattended on both arms and emits the capture manifest |

`eval run` is the one verb that spawns a model. Its supported callers are an operator's
shell and a `review-skill` spawn — **never a CI job**, on the cost constraint the founder
ruled on epic #4649, which `src/eval/spawn.unit.test.ts` asserts rather than states.

The token meter these verbs price runs with is fabrika's own
([`src/spend/token-spend.ts`](./src/spend/token-spend.ts)), not v1's. `billed` is
*specified* by ADR 0112 §2, not chosen, so the two implementations are held to one ruler by
a committed transcript fixture both packages' unit tiers assert against —
`src/spend/fixtures/one-ruler/`.

## Development

```bash
pnpm --filter @kampus/fabrika-cli test        # vitest
pnpm --filter @kampus/fabrika-cli typecheck   # tsgo
```

**There is no build step.** `bin` points at `./src/bin.ts` and Node ≥ 24 strips the types natively,
so an edit to `src/` is live on the next invocation — which is the entire point of the workspace
`devDependencies` line in the root `package.json`. Nothing is compiled, nothing is emitted, and there
is no `dist/` to go stale against the source.

A verb is a **pure function of its dependencies** — the `*-verb.ts` modules compute a
`VerbOutcome` (exit code, stdout, stderr) and never write a stream or exit. The Effect CLI
layer in each group's `command.ts` does both. That split is what makes
each refusal as deterministically testable as each answer, which is why the tests can drive
an unreadable directory, a `gh` that exits 0 with the wrong bytes, and a base ref that
cannot be fetched — inputs a real tree cannot be asked to produce on demand.

Those dependencies are the **Effect platform services**, never a raw `node:*` import: the
filesystem is `FileSystem` / `Path` from `effect`
([.patterns/effect-platform-access.md](../../.patterns/effect-platform-access.md)) and the
subprocess is `ChildProcess` / `ChildProcessSpawner` from `effect/unstable/process`
([.patterns/effect-process-cli-shell.md](../../.patterns/effect-process-cli-shell.md)), both
satisfied by the one `NodeServices.layer` [`src/run.ts`](./src/run.ts) provides. A test
substitutes those same services rather than a hand-rolled double, so the seam under test is
the seam production uses. A read that could not be performed fails on the `E` channel — it
never resolves to an empty value a caller could forget to distinguish from a real one.

Two raw `node:*` reads survive, both named by that pattern doc rather than overlooked. **fd
0** stays a raw `node:fs` read at the boundary in [`src/io/stdin.ts`](./src/io/stdin.ts) —
the standing ruling, where `Stdio.stdin` is a considered-and-declined stream swap rather
than a missing service; the verbs take the read as an injected effect, so the `EAGAIN` and
TTY paths stay testable without a real descriptor. **`homedir()`** stays a raw `node:os`
read in [`src/eval/spawn-io.ts`](./src/eval/spawn-io.ts), because Effect v4 ships no
equivalent at all; it is a parameter default, so a test substitutes it without a service.

The delegation layer reads `process` — `cwd()`, `argv`, `execPath`, `env`, `exit()` — and that is
confined to [`src/delegate/entry.ts`](./src/delegate/entry.ts), the boundary the bin bootstrap calls.
The walk and the decision it feeds are Effects over `FileSystem` / `Path` / `ChildProcessSpawner`,
so every branch — including "an ancestor could not be probed" and "the spawn faulted" — is driven by
substituted services rather than by a real tree.
