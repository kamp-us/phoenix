# @kampus/tuval-claude

Tuval's Claude harness: the `claude-session` program row, the Claude Agent SDK adapter behind it
(`ClaudeAiAgent`), the three kernel tools it serves to Claude, the history mapper that turns Claude's
stored transcript into the shared transcript items, and the Claude chat window.

It is an official plugin package, built on `@kampus/tuval-sdk` and `@kampus/tuval-ui` through their
exports maps the same way an outside program is. The desk app registers Claude by importing it, and
the Agent SDK is this package's dependency, not the SDK's or the app's.

## Usage

A config registers the row:

```ts
// ~/.tuval/tuval.config.ts
import {ClientId, claudeSession, WorkspaceId} from "@kampus/tuval-claude";

const scope = {workspace: WorkspaceId.make("default"), client: ClientId.make("tuval-desk")};

export default {
  version: 1,
  programs: [claudeSession({cwd: "/path/to/repo", scope})],
};
```

## Dependencies

`@kampus/tuval-sdk`, `effect` and `react` are peer dependencies: the desk supplies the one copy of
each. `@kampus/tuval-ui`, `@anthropic-ai/claude-agent-sdk` and the Agent SDK's three peers
(`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`) are regular dependencies.

The package is workspace-only for now. It ships TypeScript source, and the window's `.tsx` reaches
stylesheets through `@kampus/tuval-ui`, so a consumer bundles it with Vite, as the desk does.

## Entries

| Entry | What it holds |
|---|---|
| `.` | `claudeSession`, the row's config schema, program id and renderer reference, and the `ClientId` / `WorkspaceId` constructors a row's `scope` needs. Node-side; reaches the Agent SDK and never React. |
| `./window` | `claudeChatWindow` and `ClaudeChatWindow`, the browser-side renderer. Reaches no Agent SDK. |
| `./agent` | `ClaudeAiAgent`, the `TuvalAiAgent` layer over the Agent SDK. |
| `./tools` | `KernelBridge` and the MCP tool server that hands Claude the kernel's `spawn`, `send` and `read`. |
| `./testing/*` | The scripted Agent SDK query, the captured history fixtures, a window state fixture, and the two Node-side replays the desk's chat proof page serves. |

## Develop

```sh
pnpm --filter @kampus/tuval-claude typecheck
pnpm --filter @kampus/tuval-claude test
```

The desk-level proofs of this harness (the scripted vertical, the subagent vertical, the restore
proof and the real-CLI `proof:claude-real`) boot the whole desk, so they live in the app under
`apps/tuval/src/claude-desk/`.
