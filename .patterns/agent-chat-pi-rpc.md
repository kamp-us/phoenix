# Agent chat — Pi RPC in atölye

The atölye `AgentChatInput` is a **local-development prototype** for a browser composition over
[Pi's RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).
It is not a worker feature and it never gives the deployed Cloudflare Worker process ownership.

## Boundary

`apps/web/piHarness.ts` is a Vite `serve` plugin. It owns one captured `pi --mode rpc` child,
translates its JSONL stdin/stdout protocol into same-origin `/__pi/*` development endpoints, and
terminates only that captured child when the Vite server closes. It runs the process at the workspace
root so Pi receives the same project context files, skills, and extensions as its terminal use.

The route is intentionally absent from `alchemy dev`, the worker, and production assets:

| Layer | Owns |
|---|---|
| `apps/web/piHarness.ts` | Local Pi process, JSONL correlation, local file search, `/__pi/*` Vite endpoints |
| `src/components/agent/piHarness.ts` | Browser transport and EventSource subscription |
| `src/components/agent/AgentChatInput.tsx` | Phoenix composition, input completion, attachments, streamed activity, extension dialogs |
| Cloudflare Worker | Nothing — no child process, local filesystem, or Pi credentials |

The Atölye exhibit opts into `mockWhenUnavailable`: when a deployed preview has no `/__pi/*`
bridge, the composer falls back to display-only models, thinking levels, commands, and local UI
interactions. The fallback never creates a worker route or emulates a remote agent; a healthy local
bridge always wins and remains the only path that executes Pi.

The Vite middleware accepts only `localhost` / loopback hosts. It starts Pi with `--approve` by
default so the developer can exercise this project's local Pi resources. The browser's `proje izni`
control can restart that captured child with `--approve` or `--no-approve`; that startup authority
must never be silently moved to a remotely reachable production route.

## RPC mapping

Use Pi's documented RPC commands verbatim; do not emulate agent behavior in React.

| UI action | RPC operation |
|---|---|
| Initial status | `get_state` |
| Model list / selection | `get_available_models` / `set_model` |
| Thinking effort | `get_available_thinking_levels` / `set_thinking_level` |
| Project trust | Restart the captured local child with `--approve` / `--no-approve` |
| `/` completion list | `get_commands` |
| Send | `prompt` |
| Yönlendir | `steer` |
| Sonraya al | `follow_up` |
| Durdur | `abort` |
| Image attachment | `prompt.images` (`ImageContent`) |
| Extension dialog response | `extension_ui_response` |

Pi has no generic tool-permission RPC or built-in sandbox. `proje izni` is deliberately scoped to
whether project-local settings, resources, packages, and extensions load at process startup; it
does not limit the child process's normal local filesystem or shell authority. See
[Pi's security documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md).

`get_commands` deliberately contains extension commands, prompt templates, and skills. Pi's
terminal-only built-ins (such as `/settings` and `/tree`) are not present and must not be shown as
browser commands: RPC documents that they do not execute through `prompt`.

## Completion and extension UI

`/` comes from the running Pi instance, so registered extensions and loaded skills remain the
source of truth. `@` is a local workspace fuzzy search, excluding generated and dependency
directories; it inserts a repository-relative `@path` token into the prompt. Pi receives that
visible path and can use its normal workspace tools to read it. RPC mode does not accept CLI
`@file` arguments, so do not encode an at-mention as a command-line argument or pretend it is an
attachment.

Pi extensions can request `select`, `confirm`, `input`, or `editor` interaction over RPC. Render
those requests through the shared `Dialog` and return the matching request id. `notify`,
`setStatus`, `setWidget`, `setTitle`, and `set_editor_text` update the surrounding local component
state without inventing a second extension protocol.

## Adding a capability

1. Find the documented Pi RPC command or event first.
2. Add it to `piHarness.ts` as a narrow bridge endpoint, retaining JSONL request correlation.
3. Add the browser transport shape under `src/components/agent/piHarness.ts`.
4. Expose it through a Phoenix shared primitive; retain the shared focus, button, dialog, and role
   token layers.
5. Keep it at `/lab/atolye/agent-chat-input` until a separately designed production broker exists.

Do not add a worker route, a public WebSocket endpoint, or a browser-side Pi credential flow as a
shortcut around that missing broker boundary.
