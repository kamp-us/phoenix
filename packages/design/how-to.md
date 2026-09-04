# Use `@kampus/design`

## Import a primitive

Import components and their public types from the package root:

```tsx
import {Button} from "@kampus/design";
```

## Load the package styles

Import both package-owned style entries from the consuming app's global stylesheet:

```css
@import "@kampus/design/fonts.css";
@import "@kampus/design/tokens.css";
```

Keep application reset and focus-layer rules in the consuming app. Do not import an app module from `packages/design`.

For `AgentChatInput`, pass the consuming app's `AgentChatInputBridge`; the package does not own Pi transport wiring.

## Validate the package

Run the package's three checks from the repository root:

```bash
pnpm --filter @kampus/design typecheck
pnpm --filter @kampus/design test
pnpm --filter @kampus/design test:a11y
```
