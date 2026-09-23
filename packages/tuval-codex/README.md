# @kampus/tuval-codex

Tuval's Codex harness: the `codex-session` program row, the `codex app-server` adapter behind it
(`CodexAiAgent`), the kernel tools it serves to Codex over MCP, the history mapper that turns Codex's
stored threads into the shared transcript items, and the Codex chat window.

It is an official plugin package, built on `@kampus/tuval-sdk` and `@kampus/tuval-ui` through their
exports maps the same way an outside program is. The desk app registers Codex by importing it, and
the MCP SDK the kernel tools run on is this package's dependency, not the SDK's or the app's. The
protocol and lifetime rules are in [tuval-codex.md](../../.patterns/tuval-codex.md).

## Usage

A config registers the row:

```ts
// ~/.tuval/tuval.config.ts
import {ClientId, codexSession, WorkspaceId} from "@kampus/tuval-codex";
import type {TuvalConfigInput} from "@kampus/tuval-sdk/kernel/config";

const scope = {workspace: WorkspaceId.make("default"), client: ClientId.make("tuval-desk")};

export default {
  version: 1,
  programs: [codexSession({cwd: "/path/to/repo", scope, codex: {mode: "read-only"}})],
} satisfies TuvalConfigInput;
```

The row needs the Codex CLI on `PATH` and its existing login when a process starts. Building the
row starts nothing.

## Dependencies

`@kampus/tuval-sdk`, `effect` and `react` are peer dependencies: the desk supplies the one copy of
each. `@kampus/tuval-ui`, `@modelcontextprotocol/sdk` and `@effect/platform-node` are regular
dependencies.

The package is workspace-only for now. It ships TypeScript source, and the window reaches
stylesheets through `@kampus/tuval-ui`, so a consumer bundles it with Vite, as the desk does.

## Entries

| Entry | What it holds |
|---|---|
| `.` | `codexSession`, the row's config schema, program id and renderer reference, and the `ClientId` / `WorkspaceId` constructors a row's `scope` needs. Node-side; never reaches React. |
| `./window` | `codexChatWindow` and `CodexChatWindow`, the browser-side renderer. |

## Develop

```sh
pnpm --filter @kampus/tuval-codex typecheck
pnpm --filter @kampus/tuval-codex test
TUVAL_CODEX_PROTOCOL_TEST=1 pnpm --filter @kampus/tuval-codex exec vitest run --project integration src/codex-cli.integration.test.ts
```

The last command runs the installed CLI with a temporary `CODEX_HOME`, and needs no credentials.
The desk-level cases that read Codex beside Claude or through the desk's picker live in the app
under `apps/tuval/src/codex-desk/`.
