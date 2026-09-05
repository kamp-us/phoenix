# Property-based a11y — the warning-to-enforced promotion loop over `@kampus/design`

The harness that turns the ADR [0162](../.decisions/0162-four-pillars-design-law.md)
pillar-4 accessibility rules into a standing property test over the `@kampus/design`
primitives (issue #2175). It lives in
[`packages/design/src/a11y/`](../packages/design/src/a11y/) and runs
as its own CI gate
([`a11y-pbt.yml`](../.github/workflows/a11y-pbt.yml)). This is the frontend
counterpart to the deterministic CSS lint
([design-token-guard](../.github/workflows/design-token-guard.yml), #2170): the CSS
lint gates the token seam, this gates the a11y seam.

## The shape

For every `@kampus/design` primitive, [`fast-check`](https://fast-check.dev) generates
randomized **valid** prop combinations (an `fc.Arbitrary<ReactElement>` per
primitive), each is rendered in jsdom, and the pillar-4 invariants are asserted
via [`axe-core`](https://github.com/dequelabs/axe-core) plus a direct
keyboard-focus probe. Property-based, not example-based: a single arbitrary covers
the whole prop cross-product a hand-written test would enumerate one case at a time.

Three files, one responsibility each:

- **`registry.tsx`** — classifies every runtime export of `packages/design/src/index.ts` as
  `interactive` / `presentational` / `deferred`, with an arbitrary for the first
  two.
- **`posture.ts`** — the per-invariant `enforced` / `warning` posture map (the
  promotion registry) + the documented promotion procedure.
- **`check.ts`** — runs the enforced invariants over one render and returns the
  violations; axe for name/ARIA, a DOM probe for focusability.

## The two load-bearing ideas

**1. Warning-to-enforced posture (the promotion loop).** jsdom has no layout engine
and applies no CSS, so name / ARIA / focusability are fully decidable there
(`enforced` — a violation fails the gate) but contrast and tap-target are not
(`warning` — reported, never failed; a promotion candidate for a real-browser
Playwright pass). Promoting a warning to enforced is a **one-line edit** to
`posture.ts` once every primitive holds the invariant — the miss a reviewer kept
catching by hand becomes a permanent guardrail. Never assert a geometry/paint fact
in jsdom; that is a false gate.

**2. Fail-closed auto-coverage.** The coverage test asserts the registry's key set
**equals** the barrel's runtime export set (symmetric difference empty). A new
primitive that no one classified — or a stale entry for a removed one — **fails the
gate** (ADR [0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md)), so the
covered set tracks `packages/design/src/index.ts` and never silently goes stale. `deferred` is a
reasoned, reason-carrying parking spot (Manti machine primitives needing required
`items`/`trigger`/`content` props or a portal interaction; form controls whose name
comes from a composed label prop), not an escape hatch.

## Running it from a consumer, over your own composition

The gate above covers each primitive **alone**. It does not cover what an app builds *out of* them,
and two of the reasons are structural: the compound primitives are parked `deferred` precisely
because they need composition to be representative, and an app's own markup around a primitive (a
table, a labelled region) is not in the registry at all. So an app that composes them owes its own
pass.

`runEnforcedInvariants` is exported for that, as `@kampus/design/a11y`
([`check.ts`](../packages/design/src/a11y/check.ts) is the subpath's entry, and re-exports the spec
types beside it). The consumer supplies the rendered root and a spec; `fast-check` generates the
**state** rather than the props, since a composition's inputs are its app's own domain data.
`apps/tuval/src/shell/chat/chat-a11y.unit.test.tsx` is the worked instance (issue
[#7610](https://github.com/kamp-us/phoenix/issues/7610)).

Three things that pass are worth copying:

- **Scope the scan to the regions you built.** A pass over the whole screen inherits every red from
  a primitive you only mounted — a consumer cannot fix a defect in the package, and widening its own
  gate to swallow one teaches the next builder to widen it again. Name the regions, and name the
  issue for anything excluded.
- **The focus probe needs a root that is not the control.** `checkFocusable` runs
  `root.querySelector(spec.selector)`, and `querySelector` searches descendants — so `:scope` matches
  nothing and the probe reports `no element matched selector`. Mark the control, probe from an
  ancestor by that mark, unmark.
- **Give the test its own timeout.** One `axe.run` per region per generated state is seconds, not
  milliseconds; Vitest's 5s default passes the file alone and times it out inside a loaded full run.

## Adding a primitive

Add its export to `packages/design/src/index.ts`, then classify it in `registry.tsx` — the coverage
test fails until you do. If it renders standalone with a valid prop arbitrary, make
it `interactive` (with a `selector` for its control) or `presentational`; if it needs
composition/portal/provider context to be representative, make it `deferred` with the
reason. Keep arbitraries generating only **valid** props — the harness asserts that a
correctly-used primitive is accessible, not that misuse is caught.
