# @kampus/fabrika-cli

The deterministic verb package [fabrika](../../claude-plugins/fabrika/) skills call.
`fabrika-cli <group> <verb> …` dispatches to a registered verb group. Two groups are
registered: `adr`, the six verbs the `/adr` skill's derived contract specifies, and
`report`, the three the `/report` contract specifies.

## Who it's for

fabrika's architecture is a two-layer split: deterministic work is pushed maximally into
CLI verbs, and each skill is a thin wrapper carrying only irreducible judgment. This
package is the deterministic layer. It is internal tooling for the kamp.us agent pipeline,
not a general-purpose CLI.

## It calls nothing outside fabrika

**`fabrika-cli` invokes `pipeline-cli` nowhere** — no import, no subprocess
([ADR 0238](../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Where v1
already solves the same problem, its source is a reference for the semantics and the scars,
never a dependency.

The reason is the deletion test: a fabrika that calls v1 can never be the thing that
replaces it, because every call is a tether keeping the old tree alive. Duplication costs a
second implementation during the transition; a tether costs the ability to ever delete
anything.

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
  `1` = usage error or the verb failed to run, `127` = the verb never ran, `3`+ = the verb's
  own proven outcomes. **A non-zero exit is UNKNOWN** — read the status before the bytes.
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

## Development

```bash
pnpm --filter @kampus/fabrika-cli test        # vitest
pnpm --filter @kampus/fabrika-cli typecheck   # tsgo
pnpm --filter @kampus/fabrika-cli build       # tsc -p tsconfig.build.json
```

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

The one exception is **fd 0**, which stays a raw `node:fs` read at the boundary in
[`src/io/stdin.ts`](./src/io/stdin.ts) — the standing ruling in the same pattern doc, where
`Stdio.stdin` is a considered-and-declined stream swap rather than a missing service. The
verbs take the read as an injected effect, so the `EAGAIN` and TTY paths stay testable
without a real descriptor.
