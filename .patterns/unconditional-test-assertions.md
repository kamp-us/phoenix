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
