# Custom biome lint rules with GritQL

How to author and register a project-specific lint rule in phoenix using a biome
GritQL plugin — a `.grit` file referenced from `biome.jsonc`. No ESLint, no extra
toolchain: the rule runs inside the same `biome check` pass as the built-in linter.

biome 2.4.15 is the version in use (`biome.jsonc` `$schema`). GritQL support in biome
is "actively being worked on… bugs are still expected and some features are still
outright missing" — read [Gotchas](#gotchas) before reaching for anything fancy.

## When a custom rule beats the alternatives

Reach for a GritQL plugin when phoenix needs to ban or flag a pattern that no
built-in biome rule covers, and the check is *structural* (an AST shape) rather than
semantic (cross-file type info). Wins over the alternatives:

- **vs. a built-in rule** — built-ins are first choice when one exists. Custom rules
  are for phoenix-specific bans (e.g. "decode at boundaries, don't double-cast").
- **vs. ESLint** — no second linter, no second config, no second CI step. The rule is
  biome-native and runs at biome speed in the same `biome check`.
- **vs. a grep in CI** — GritQL matches the parsed AST, so it ignores formatting,
  whitespace, and quote style, and it produces a real diagnostic with a span and a
  `// biome-ignore` escape hatch.

Custom rules are *not* a substitute for the TypeScript compiler. GritQL has no type
information — it sees syntax, not types. "Ban `as unknown as`" works because the
double-cast is a syntactic shape; "ban assigning a `string` to a `number`" does not.

## `.grit` file anatomy

Plugins live in `biome-plugins/*.grit`. A file is: a `language` declaration, then one
or more **patterns**, each optionally followed by a `where` clause that adds
conditions and/or emits a diagnostic.

```grit
language js;

`console.$method($message)` where {
	$method <: or { `log`, `warn`, `error` },
	register_diagnostic(
		span = $message,
		message = "no console in worker code"
	)
}
```

### Patterns — backtick code snippets

The primary way to match is a **code snippet** in backticks. It matches structurally,
not textually:

```grit
`Object.assign($target, $source)`
```

This matches `Object.assign(a, b)` regardless of spacing or quote style. You can also
match by **AST node name** (PascalCase, e.g. `JsIfStatement()`), binding it with `as`:

```grit
JsIfStatement() as $stmt where {
	register_diagnostic(span = $stmt, message = "Found an if statement")
}
```

Prefer snippets — they read like the code you're banning and don't tie you to biome's
internal grammar node names (which can change between versions). Use node-name matching
only when a snippet can't express the shape.

### Metavariables — `$x`

A `$`-prefixed name in a snippet captures whatever sits in that position:

- `$expr`, `$type`, `$message` — capture one node each.
- `console.$method(...)` — `$method` captures any property name.
- **Repeated** metavariable means the *same* node twice: `$fn && $fn()` only matches
  when both `$fn`s are structurally equal.

Captured metavariables are what you pass to `register_diagnostic(span = …)` and what
you constrain in `where`.

### `where` clauses — conditions with `<:`

`where { … }` holds a comma-separated list of conditions. The match operator `<:`
tests a metavariable against a pattern:

```grit
`$expr as $type` where {
	$type <: or { `any`, `unknown` }
}
```

`or { `a`, `b` }` matches any of the listed snippets. `where` is also where
`register_diagnostic(...)` is called — it's an operation that runs when the conditions
hold, not a comparison.

### Emitting a diagnostic — `register_diagnostic`

`register_diagnostic` takes:

- **`span`** (required) — the matched node to underline. Typically a metavariable you
  captured (`span = $expr`).
- **`message`** (required) — the text shown in the diagnostic.
- **`severity`** (optional) — one of `hint`, `info`, `warn`, `error`. Defaults to
  `error`. phoenix wants these to fail `biome check`, so the default `error` is right.

```grit
register_diagnostic(
	span = $expr,
	message = "Type assertions are forbidden — decode at boundaries with Schema.decodeUnknown."
)
```

## Registering the plugin

Add the `.grit` path to the top-level `"plugins"` array in `biome.jsonc`:

```jsonc
{
	"$schema": "https://biomejs.dev/schemas/2.4.15/schema.json",
	"plugins": ["./biome-plugins/no-type-assertions.grit"],
	"linter": { "enabled": true, "rules": { "recommended": true } }
}
```

The path is relative to the config file. The plugin runs as part of `biome check` /
`biome lint` — `pnpm lint` picks it up automatically, no flag needed.

## Worked example: ban `as unknown as` and `as any`

The rule phoenix actually ships. `as unknown as T` (double-cast) and `as any` blind the
TypeScript compiler — they assert a shape the compiler can no longer verify. At a trust
boundary phoenix decodes with `Schema.decodeUnknown` instead (see
[effect-schema-validation.md](./effect-schema-validation.md)); everywhere else the value
should just be typed properly.

`biome-plugins/no-type-assertions.grit` bans the assertion forms that *fully erase*
type information — `as any`, the double-cast through the top/bottom type in every
spelling (`x as unknown as T`, `(x as unknown) as T`, `x as never as T`,
`(x as never) as T`), and the angle-bracket cast (`<T>x`). It deliberately leaves a
*single* narrowing cast to a real named type alone (`as React.CSSProperties`, or
Drizzle's `column.value as never` in `db/keyset.ts`) — GritQL has no type info, so it
can't tell a safe narrowing from an unsafe one, and over-banning would swallow
legitimate code. The full rule (with header rationale) lives in the file; the shape:

```grit
language js;

or {
	`$expr as unknown as $type` where { register_diagnostic(span = $expr, message = "…") },
	`($expr as unknown) as $type` where { register_diagnostic(span = $expr, message = "…") },
	`$expr as never as $type` where { register_diagnostic(span = $expr, message = "…") },
	`($expr as never) as $type` where { register_diagnostic(span = $expr, message = "…") },
	`$expr as any` where { register_diagnostic(span = $expr, message = "…") },
	TsTypeAssertionExpression() as $assertion where { register_diagnostic(span = $assertion, message = "…") }
}
```

Two things to note:

- **Snippets over node names — except for the angle-bracket form.** The `as`-cast
  shapes are spelled out as snippets because they read like the source being banned.
  The angle-bracket cast is the exception: the `<$type>$expr` snippet does **not**
  bind biome's TS type-assertion node, so it's matched by node name
  (`TsTypeAssertionExpression()`), the one place node-name matching earns its keep.
- **Parentheses need their own arm.** `(x as unknown) as T` is a structurally
  different node from the bare `x as unknown as T` — biome doesn't unwrap the
  parens — so the parenthesized double-cast is a separate pattern. Same for
  `(x as never) as T`.

**A `where { $type <: contains \`unknown\` }` arm to flag *any* cast whose target
mentions `unknown` was considered and rejected.** It would fire on legitimate
narrowings like `as Record<string, unknown>` (GritQL can't see that the value really
is that shape), and the codebase has several such honest casts. The rule stays
surgical: only the unambiguous *erasing* forms (`any`/`unknown`/`never` as the cast
target, and the laundering double-cast) are banned; a lone narrowing cast is the
compiler's normal assertion and is left to code review.

### Scoping: production source vs. test support

The rule should bite everywhere, production *and* tests — a cast is a cast. But
test-support fakes under `__support__/` and the `*.test.ts` files legitimately bridge
Node and test types onto runtime DO/D1 surfaces that can't be implemented in full. The
instinct is to switch the plugin off for those globs via `overrides`, but biome's
`overrides.plugins` can only **add** plugins to a path — it can't disable one. There is
no path-scoped off-switch for a plugin the way there is for a built-in rule (where an
override can set a rule to `"off"`). So the ban stays global and the rare justified line
is suppressed individually (see below). That's the safer shape anyway: a broad
`includes` glob would silently exempt any stray production cast that happened to live
under a matched path.

### Suppressing one justified line

For a single justified exception, use a `// biome-ignore` comment on the line above.
Plugin diagnostics are suppressed under the **bare `lint/plugin` rule id** — not a
per-plugin id like `lint/plugin/no-type-assertions` — and the reason after the colon is
mandatory:

```ts
// biome-ignore lint/plugin: better-auth's `Auth` instance type can't be partial-constructed; the bridge tests never reach the session path, so a no-op `getSession` stand-in suffices.
const auth = fakeAuth as unknown as Auth;
```

The reason after the colon is required — biome rejects a bare suppression. These live in
the test fakes (`__support__/`, `*.test.ts`) where a partial stand-in can't satisfy a
fully-typed runtime surface; production source carries zero suppressions. A growing pile
of ignores is a signal the rule (or the code) needs rethinking, not more suppressions.

## Testing that the rule bites

GritQL plugins have no unit-test harness in biome 2.4 — you verify by running the
linter against a **probe matrix**: a throwaway file with one line per shape the rule
should (and should NOT) flag, then assert `pnpm lint` flags *exactly* the bad ones.
For `no-type-assertions` the matrix that proved the tightened rule:

```ts
// apps/web/src/__grit_probe/probe.ts — throwaway, delete after.
type T = {dev?: unknown};
declare const v: unknown;
declare const col: number;

// BAD (must be flagged):
const a = v as unknown as T;          // double-cast
const b = v as any;                   // as any
const c = (v as unknown) as T;        // parenthesized unknown double-cast
const d = v as never as T;            // never inner double-cast
const e = (v as never) as T;          // parenthesized never double-cast
const f = <T>v;                       // angle-bracket cast

// GOOD (must NOT be flagged — out of scope):
const g = [1, 2] as const;            // as const
const h = col as never;               // lone narrowing cast (Drizzle keyset style)
const i = JSON.parse("{}") as {dev?: unknown}; // lone object narrowing cast
export {a, b, c, d, e, f, g, h, i};
```

```bash
pnpm exec biome lint apps/web/src/__grit_probe/probe.ts 2>&1 | grep -E 'probe.ts:[0-9]+'
#  → exactly the six BAD lines, none of the three GOOD ones
rm -rf apps/web/src/__grit_probe
```

Confirm both that every BAD shape *is* flagged and that every GOOD shape is *not*
(no false positives), then delete the probe. To confirm a justified exception, add a
`// biome-ignore lint/plugin: <reason>` line above a probe violation and check the
diagnostic goes away.

## Gotchas

- **No type info.** GritQL matches syntax only. Anything needing the type checker
  (is this `any`-typed? does this `string` flow to a `number`?) is out of scope —
  that's the TS compiler's job, not the linter's.
- **Grammar can shift.** biome's internal node grammar "may change between versions,
  potentially breaking node-based patterns." Snippet patterns (backticks) are more
  stable than `PascalCaseNode()` matching — prefer them.
- **Experimental surface.** GritQL support is "actively being worked on… bugs are still
  expected and some features are still outright missing." Keep rules to the documented
  core (snippets, metavariables, `where`/`<:`/`or`, `register_diagnostic`); don't lean
  on undocumented operators.
- **Languages.** GritQL plugins target JavaScript/TypeScript (`language js`) and CSS
  (`language css`); declare the language at the top of the file. One language per file.
- **Node names live in `.ungram`.** If you must match by node name, the full list of
  nodes and their fields is in biome's `.ungram` grammar files — there is no in-editor
  autocomplete for them.

## See also

- [effect-schema-validation.md](./effect-schema-validation.md) — `Schema.decodeUnknown`,
  the boundary-decode the `as unknown as` ban points people toward
- `biome.jsonc` — the `"plugins"` array and the `overrides` scoping block
- `biome-plugins/no-type-assertions.grit` — the live rule
- biome GritQL reference: <https://biomejs.dev/reference/gritql/>
- biome plugins guide: <https://biomejs.dev/linter/plugins/>
