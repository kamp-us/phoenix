# Erasable-only TypeScript in worker/stack code

`alchemy deploy` loads the worker stack (`apps/web/alchemy.run.ts` and everything it
imports) through **Node's strip-only TypeScript loader** — it deletes type syntax
without a full transpile. Strip-only cannot lower **non-erasable** TS constructs to
JavaScript, so it throws at load time:

```
ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode
```

Non-erasable syntax is the syntax that emits runtime code a plain type-strip can't
produce:

- **parameter properties** — `constructor(readonly x: T) {}`
- **`enum`** (and `const enum`)
- runtime **`namespace`** (a `namespace` with a value body; a `declare` / ambient
  `namespace` inside `declare module` is type-only and *is* erasable)

## The guard

The root [`tsconfig.json`](../tsconfig.json) sets **`erasableSyntaxOnly: true`**, so the
typechecker rejects the class above at `pnpm typecheck` — the fast gate — instead of at
`deploy (web)`, the slowest feedback loop in CI. Before this flag, a parameter property
typechecked, linted, passed unit tests, and even survived the transpiling integration
deploy; it broke only at `alchemy deploy` (#916, surfaced by #914's `IllegalTransition`).

The flag is set at the **repo root** because the strip-only constraint is not
worker-specific in spirit — all three `apps/web` projects (`worker`, `node`, `app`)
extend the root config, so one flag covers every file alchemy's loader can reach plus the
rest of the tree, at no cost to code that was already erasable. Requires TypeScript ≥ 5.8.

## What to write instead

Rewrite each non-erasable form as its erasable equivalent — the constructs exist to save
keystrokes, never to express something erasable syntax can't:

- parameter property → explicit field + assignment in the constructor body:
  ```ts
  class AppError {
  	readonly detail: string;
  	constructor(detail: string) {
  		this.detail = detail;
  	}
  }
  ```
- `enum` → a `const` object + `as const` (or a union of string literals)
- runtime `namespace` → a plain module (a file) or a `const` object
