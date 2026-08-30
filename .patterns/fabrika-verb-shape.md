# fabrika-verb-shape — how a `packages/fabrika-cli` verb is put together

Every verb in [`packages/fabrika-cli`](../packages/fabrika-cli/) has the same two halves, and the
split is what makes a refusal as testable as an answer.

## A verb is a pure function of its dependencies

The `*-verb.ts` module computes a `VerbOutcome` — exit code, stdout, stderr — and never writes a
stream and never exits. The Effect CLI layer in each group's `command.ts` does both.

Because the outcome is a value, a test can drive an unreadable directory, a `200` carrying the wrong
bytes, or a base ref that cannot be fetched, and assert the refusal exactly as it asserts a success.

## The dependencies are Effect platform services, never a raw `node:*` import

- The filesystem is `FileSystem` / `Path` from `effect` — see
  [effect-platform-access.md](./effect-platform-access.md).
- The subprocess is `ChildProcess` / `ChildProcessSpawner` from `effect/unstable/process` — see
  [effect-process-cli-shell.md](./effect-process-cli-shell.md).

Both are satisfied by the one `NodeServices.layer` that
[`packages/fabrika-cli/src/run.ts`](../packages/fabrika-cli/src/run.ts) provides. A test substitutes
those same services rather than a hand-rolled double, so the seam under test is the seam production
uses.

A read that could not be performed fails on the `E` channel. It never resolves to an empty value a
caller could forget to distinguish from a real one — the in-code half of the fail-closed rule in
[ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md).

## Two raw boundaries, both named rather than overlooked

- **fd 0** stays a raw `node:fs` read in
  [`packages/fabrika-cli/src/io/stdin.ts`](../packages/fabrika-cli/src/io/stdin.ts). The verbs take
  that read as an injected effect, so the `EAGAIN` and TTY paths stay testable.
- **The delegation layer reads `process`** — `cwd()`, `argv`, `execPath`, `env`, `exit()` — confined
  to [`packages/fabrika-cli/src/delegate/entry.ts`](../packages/fabrika-cli/src/delegate/entry.ts).
  The walk and the decision it feeds are Effects over the platform services, so every branch is
  driven by substituted services rather than a real tree. The boundary that walk enforces is
  [ADR 0287](../.decisions/0287-delegation-stays-inside-one-repository.md).

## See also

- [Pattern library index](./index.md)
- [verb-output-pin-surfaces.md](./verb-output-pin-surfaces.md) — the surfaces a verb's printed output
  shape is copied into
- [`packages/fabrika-cli/docs/packaging.md`](../packages/fabrika-cli/docs/packaging.md) — how the
  package is published and which copy of the binary runs
