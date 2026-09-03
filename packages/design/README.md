# @kampus/design

## What it is

The shared Kampüs UI primitive package: the React components, CSS tokens, fonts, and
accessibility contract used by every browser surface. Components preserve the existing
`apps/web` contracts while living outside any one application.

The design law is founder-authored in
[`design-system-manifest.md`](../../design-system-manifest.md), with component metadata
extracted into the generated [`design-system-inventory.md`](../../design-system-inventory.md).

## Why it exists

The package gives web and Tuval one implementation instead of app-bound copies or imports
across app boundaries. The extraction is the ownership move described by issue [#7561](https://github.com/kamp-us/phoenix/issues/7561); it preserves the behavior and rendered
surface of the existing primitives.

## How to use it

Import components from the package root:

```tsx
import {Button} from "@kampus/design";
```

Load the package-owned style entries from the consuming app's global stylesheet:

```css
@import "@kampus/design/fonts.css";
@import "@kampus/design/tokens.css";
```

React and React DOM remain peer dependencies of the package and are supplied by the
consumer. `AgentChatInput` accepts an optional `AgentChatInputBridge`; the consuming
app owns the Pi transport and passes it in, so this package never imports an app or a
local process bridge.

## Reference

| Entry | Contents |
| --- | --- |
| `@kampus/design` | Component and type exports from `src/index.ts` |
| `@kampus/design/tokens.css` | Raw, semantic, role, density, and Manti bridge tokens |
| `@kampus/design/fonts.css` | First-party IBM Plex Sans and JetBrains Mono faces |
| `AgentChatInputBridge` | App-owned Pi RPC transport supplied to `AgentChatInput` |
| `design-token-lint.config.json` | The token guard's package-owned baseline and allow-list |

## Testing

```bash
pnpm --filter @kampus/design typecheck
pnpm --filter @kampus/design test
pnpm --filter @kampus/design test:a11y
```
