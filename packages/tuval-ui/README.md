# @kampus/tuval-ui

The React surfaces a Tuval AI-agent window is built from: the desk's chat window and the shared
agent window (the session list, a session's transcript and the agent inspector), with the desk,
key, page and palette pieces they reach.

It exists so a harness package can build its window without the desk app, the same way a program
builds on `@kampus/tuval-sdk` without it. The SDK stays free of React; this package is where React
and `@kampus/design` come in.

A config never names this package. A harness package or a program's window imports it, and the
config lists that harness or program's row.

## Install

```sh
npm install @kampus/tuval-ui
```

The package ships compiled ES modules with type declarations.

## Dependencies

`@kampus/tuval-sdk`, `effect` and `react` are peer dependencies: the desk supplies the one copy of
each, so a window and the kernel it talks to share it. `@kampus/design` and
`@tanstack/react-virtual` are regular dependencies.

Each window module imports its own stylesheet (`import "./chat.css"`), so a page that renders one
bundles it with a bundler that handles CSS imports, as the desk does with Vite.

## Entries

| Entry | What it holds |
|---|---|
| `./chat` | `chatWindow`, the chat window renderer every harness window wraps, and its row and view helpers |
| `./agent-window` | The shared agent window: `sessionListWindow`, `SessionTranscriptView`, `AiAgentInspector` |
| `./desk` | The desk's inspector and status-bar regions and its board/inspector state |
| `./keys` | The prefix-key syntax, table and router |
| `./forwarded-key` | The channel that hands a window the key the desk forwarded to it |
| `./input-modality` | Which input the operator last used, which gates the focus ring |
| `./session-list`, `./session-transcript` | The page's wire halves for the session list and a transcript read |
| `./palette-call` | A palette line into a `SpellCall`, and a `SpellFailure` into one sentence |
| `./testing/*` | Fixtures and the jsdom shims the package's own tests use, for a consumer's tests. `./testing/dom` imports `vitest` and `@testing-library/react`, which the consumer's test setup supplies |

```tsx
import {chatWindow} from "@kampus/tuval-ui/chat";

export const myWindow = chatWindow({subagentList: true});
```

## Develop

```sh
pnpm --filter @kampus/tuval-ui typecheck
pnpm --filter @kampus/tuval-ui test
pnpm --filter @kampus/tuval-ui build
```

Inside the workspace the `exports` map points at `src`, which the desk runs with no build step.
`pnpm pack` builds `dist` and swaps in `publishConfig.exports`, which points at `dist` only.
`src/public-surface.pack.test.ts` packs the package and pins that published map.
