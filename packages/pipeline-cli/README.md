# @kampus/pipeline-cli

The single subcommand-router home all pipeline tooling folds into (epic
[#994](https://github.com/kamp-us/phoenix/issues/994)). `pipeline-cli <tool> …`
dispatches to a registered tool; the tools themselves move in over Phase 2
(#997–#1002).

This is the **Phase-1 scaffold** (#996): the package shell, the registry
extension seam, the pure router core, and one tracer tool (`version`) wired end to
end. **No existing tool's logic is moved in yet.**

## Shape

Per the repo's mechanical-tooling idiom (`decisions-index` / `epic-ledger` /
`leak-guard`): a pure, unit-tested core + a thin Effect CLI bin.

- `src/registry.ts` — **the extension seam.** `registeredTools` is the array of
  `effect/unstable/cli` `Command`s the router exposes. A Phase-2 child folds its
  tool in by appending one `Command` here — and nothing else. The router and bin
  consume this array opaquely.
- `src/router.ts` — the **pure router core.** `dispatch(registry, argv)` resolves
  the first argv token to a registered tool (`Ok({ tool, rest })`), or fails with
  a clear `UnknownToolError` (unknown token) / `NoToolError` (no token). It owns
  no Effect runtime, so the dispatch contract is unit-testable directly (ADR 0040
  T0/T1) — the mirror of the runtime dispatch `Command.withSubcommands` does.
- `src/version.ts` — the `version` tracer tool, a normal registered tool.
- `src/bin.ts` — the `effect/unstable/cli` bin: `Command.withSubcommands(registeredTools)`,
  run via `NodeRuntime.runMain`.

## The extension seam

A later child registers its moved tool **without touching the router core**:

```ts
// src/registry.ts
import {myToolCommand} from "./my-tool.ts";
export const registeredTools: ReadonlyArray<RegisteredTool> = [versionCommand, myToolCommand];
```

That single append is the entire registration step. `router.ts` and `bin.ts`
never change — the router is closed for modification, the registry is open for
extension.

## Usage

```bash
# list the registered tools
node packages/pipeline-cli/src/bin.ts --help

# the Phase-1 tracer tool
node packages/pipeline-cli/src/bin.ts version

# dispatch to a registered tool (Phase-2 children)
node packages/pipeline-cli/src/bin.ts <tool> …
```

### `token-spend` — offline per-stage token-spend reporter (#1382)

Reconstructs a pipeline stage's billed token spend from its sub-agent transcript
(`<session>/subagents/agent-<id>.jsonl`) and prints the `formatSessionCost` headline over
the four-component breakdown — the one-command replacement for the hand-run `jq` in
[`.patterns/token-economics-measurement.md`](../../.patterns/token-economics-measurement.md)
§2. Claude Code does not persist its `cost.total_tokens` into the transcript, so the total
is summed from the per-message `usage` components over assistant messages
(`input + cache_creation + cache_read + output`); `cache_read` is kept on its own line as
the per-turn context-bloat signal, with `ex-cache-read` as the cross-run comparator. Reuses
`spawn-guard`'s `formatSessionCost` core read-only.

```bash
node packages/pipeline-cli/src/bin.ts token-spend <session>/subagents/agent-<id>.jsonl
```

```bash
pnpm --filter @kampus/pipeline-cli typecheck
pnpm --filter @kampus/pipeline-cli test
pnpm --filter @kampus/pipeline-cli build   # src → dist ESM
```
