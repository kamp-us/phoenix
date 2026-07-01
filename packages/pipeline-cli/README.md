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

### `ship-digest` — the merged-since founder projection (#1595)

Renders a **founder-facing** ship digest for a `--since` window from a pre-gathered
merged-work entries JSON. Unlike `changelog-derive`'s builder-oriented Keep-a-Changelog
version sections, this groups **product vs infra** at the top level, then by **milestone**
(`Uncategorized` when none), then by **`type:*`** — a readout a non-builder can scan. An
entry with no milestone / area / type is surfaced under `Uncategorized`, never dropped.

The tool is the pure projection only: it consumes a pre-gathered entries JSON (each
`{issue?, pr, title, type?, milestone?, area?}`), decoded with a `Schema` at the boundary
(a malformed/unreadable file is a typed non-zero exit). The git-log `--since` + `gh`
issue/milestone gather is the `/what-shipped` skill's job, not this tool's.

```bash
node packages/pipeline-cli/src/bin.ts ship-digest derive --entries <file> --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--out <file>]
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

### `pointer-guard` — fail-closed stale-pointer gate for `**/CLAUDE.md` (#988)

Reads the **backticked repo-path pointers** in every git-tracked `CLAUDE.md`
("operate from the repo root, never `apps/web`"; a pointer at
`apps/web/worker/dom/settings.ts`) and exits non-zero when one no longer resolves
on disk — the reference class `doc-links` (#638) cannot see, because it validates
markdown `[text](path)` links and *masks* code spans by construction. The two gates
are complementary: `doc-links` reads link targets and masks code; `pointer-guard`
reads code spans and ignores link syntax.

Precision over recall: it flags a token only when it is an unambiguous
repo-root-relative path (begins with a known top-level segment — `apps/`,
`packages/`, `.patterns/`, …; no scheme / glob / call / placeholder syntax), so a
`catalog:` / `type:bug` / `pnpm dev` / bare basename is left alone. Scoped to
`**/CLAUDE.md` — `.decisions/**` (immutable history that legitimately cites moved
code) and `.patterns/**` (which also cite external dependency source trees) are out
of scope. Fails closed on zero CLAUDE.md in scope (ADR 0092).

```bash
node packages/pipeline-cli/src/bin.ts pointer-guard check
```

### `trivial-diff` — deterministic fail-closed trivial-diff classifier (ADR 0120 §1, #1557)

Classifies a unified diff as `trivial` / `non-trivial` for the right-sized fan-out
([ADR 0120](../../.decisions/0120-stage-right-sizing-trivial-diff-lighter-gate.md) §1, epic
[#1527](https://github.com/kamp-us/phoenix/issues/1527)). A diff is `trivial` only when a hard
AND of mechanical bounds clears: a single changed file that is doc/comment-only or under the
line bound `N` (1), with no new surface — dependency/manifest/migration/schema/config path or a
new `export`/`import`/`require(` module edge (2), and no control-plane path (3). The boundary is
the **live** `CONTROL_PLANE_RE`, re-resolved from `origin/main` at run time (REST raw,
`?ref=main`) — never a snapshot. Fail-closed by construction: a failed bound, a parse error, or
an unreadable boundary all return `non-trivial`, so a miss over-routes to the full (correct)
fan-out, never under-gates. The verdict word prints to **stdout**, the deciding reason to
**stderr**. This child builds the predicate only — it is **not** wired into the executor (#1559)
and adoption of the lighter gate is measurement-gated (ADR 0112, #1560).

```bash
git diff origin/main... | node packages/pipeline-cli/src/bin.ts trivial-diff classify
node packages/pipeline-cli/src/bin.ts trivial-diff classify --diff-file d.patch --max-lines 20
```

```bash
pnpm --filter @kampus/pipeline-cli typecheck
pnpm --filter @kampus/pipeline-cli test
pnpm --filter @kampus/pipeline-cli build   # src → dist ESM
```
