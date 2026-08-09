# Unconditional test assertions — no silent-pass `expect` in an `if`

Why phoenix flags a test whose only `expect(...)` is nested inside an `if`, and how to
satisfy the rule. This is the rationale doc for the `no-expect-in-if` GritQL plugin
([`biome-plugins/no-expect-in-if.grit`](../biome-plugins/no-expect-in-if.grit), registered
in `biome.jsonc`'s test `overrides` block at `warn`). For *how* to author a GritQL rule at
all, read [biome-custom-gritql-rules.md](./biome-custom-gritql-rules.md).

## The silent-pass shape

A test whose only assertion sits inside an `if` passes **vacuously** whenever the branch
isn't entered — the `expect(...)` never runs, no failure is raised, and the suite goes
green while proving nothing:

```ts
// SILENT PASS — if decide(...) ever returns a non-"record" kind, this asserts NOTHING.
it("renders a primary-checkout note LOUDLY", () => {
	const d = decideBashStagingAttribution(input("git add -A"));
	if (d.kind === "record") {
		expect(renderBashStagingNote(d.record)).toContain("the PRIMARY checkout");
	}
});
```

This is the pipeline's structural test blind spot. Coder-written tests are the bulk of new
suites, and a conditionally-guarded assertion is the easiest way for one to *look* thorough
while asserting nothing — a refactor that changes `d.kind` silently defangs the test with no
red.

## Satisfying the rule

Make an assertion unconditional. The usual fix is to **assert the branch was reached**
before narrowing into it — which is also what makes the payload access type-safe:

```ts
it("renders a primary-checkout note LOUDLY", () => {
	const d = decideBashStagingAttribution(input("git add -A"));
	expect(d.kind).toBe("record"); // unconditional — reds if the shape is wrong
	if (d.kind === "record") {
		expect(renderBashStagingNote(d.record)).toContain("the PRIMARY checkout");
	}
});
```

Or pin the assertion count so a skipped branch reds the test:

```ts
it("...", () => {
	expect.assertions(1); // the test fails if fewer than 1 assertion runs
	if (cond) expect(value).toBe(1);
});
```

`expect.assertions(n)` / `expect.hasAssertions()` at the top of the test both count as
unconditional guards and clear the warning.

## What the rule does NOT flag — the narrow-after-assert idiom

phoenix's dominant discriminated-union test idiom is **structurally identical** to the
silent-pass shape but is completely safe, and the rule deliberately leaves it alone:

```ts
// SAFE — the discriminant is asserted UNCONDITIONALLY, so the `if` is guaranteed taken.
// The `if` is a pure TS type-narrowing guard to reach `r.success`.
const r = dispatch(fixture, ["beta"]);
expect(Result.isSuccess(r)).toBe(true);
if (Result.isSuccess(r)) {
	expect(r.success.tool).toBe(beta);
}
```

The `if` here is not a "branch that may never be taken" — the line above asserts the
discriminant, so if it were false the test would already have failed. A naive "any `expect`
inside any `if`" rule would fire on ~120 such honest sites across the suite (~95% false
positives). The rule avoids this by firing **only when the enclosing test callback contains
no unconditional assertion at all** — if *any* `expect(...)` / `expect.assertions(n)` /
`expect.hasAssertions()` runs unconditionally, the test proves something and the guarded
assert is the safe-narrow idiom, not a vacuous pass.

A consequence: a **mixed** test (one unconditional assert plus a separate, rarely-taken
guarded assert) is deliberately **under-reported** — the rule is fail-safe, preferring a
missed edge over a false alarm, the same bias the sibling GritQL gates take.

## The type-level sibling — a probe that compiles either way proves nothing

The same vacuous pass exists one level up, where no lint rule can see it: a **type-level probe**
asserts a claim about types, and if the claim is mis-stated the probe simply compiles anyway and
`pnpm typecheck` goes green over nothing. That is how the defect in #4969 survived its own
counterexample — `brandWitness<A>(field)` left `A` unbound to `field`, so a row naming one brand on a
field carrying another type-checked clean.

Write the probe so the expected answer sits on the **right of an `=`**, and pin a well-formed case to
the opposite value as a **positive control**:

```ts
type Inhabits<K extends string, V> = K extends BrandedKeys<V> ? true : false;

// the positive control — reds if `BrandedKeys` ever collapses to `never` and passes everything
const branded: Inhabits<"clause", VerdictMarker> = true;
const bareString: Inhabits<"namespace", VerdictMarker> = false;
```

An `=` is deliberate: a wrong claim reds with `TS2322` at the line that states it, whereas a
`type _ = Assert<…>` constraint reports against the alias and is easy to satisfy by widening.

**Then verify the probe binds, by flipping and reverting.** Flip each expected value, run
`pnpm typecheck`, confirm a real `TS2322` at each flipped line, revert. A probe you have not flipped
is decoration — there is no red-first step in a type-level test, so this is the only evidence that it
can fail at all. `@ts-expect-error` counterexamples are self-verifying by comparison: an unused one
reds as `TS2578`, so a green run is already proof each suppressed error is real.

## Scope and suppression

- **Test files only.** Registered through `biome.jsonc`'s existing test `overrides` block
  (`**/tests/**`, `**/*.test.ts(x)`, `**/*.spec.ts`), because `overrides.plugins` only
  *adds* a plugin to a path — that is the mechanism that scopes the rule to tests (see
  [biome-custom-gritql-rules.md](./biome-custom-gritql-rules.md) "Scoping"). Production code
  is never touched.
- **Syntactic, no type info.** GritQL sees syntax, not types: it matches an `expect(...)`
  call under an `if` whose enclosing function body has no unconditional assertion.
- Registered at `warn` (Phase-1): warnings surface the sites without a hard failure while
  they are migrated. The flip to `error` is a separate capstone child, not this rule.
- For a genuinely intentional branch-guarded assertion, suppress the one line with
  `// biome-ignore lint/plugin: <reason>` — the reason is mandatory, and a growing pile of
  ignores is a signal to rethink, not to keep adding.

## See also

- [`biome-plugins/no-expect-in-if.grit`](../biome-plugins/no-expect-in-if.grit) — the live rule
- [biome-custom-gritql-rules.md](./biome-custom-gritql-rules.md) — how GritQL plugins are authored + registered
- [effect-testing.md](./effect-testing.md) — the `Result`/`Exit`/`Option` assert-then-narrow idiom the rule spares
