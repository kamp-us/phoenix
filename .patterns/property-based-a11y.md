# Property-based a11y — the warning-to-enforced promotion loop over `ui/`

The harness that turns the ADR [0162](../.decisions/0162-four-pillars-design-law.md)
pillar-4 accessibility rules into a standing property test over the `ui/`
primitives (issue #2175). It lives in
[`apps/web/src/components/ui/a11y/`](../apps/web/src/components/ui/a11y/) and runs
as its own CI gate
([`a11y-pbt.yml`](../.github/workflows/a11y-pbt.yml)). This is the frontend
counterpart to the deterministic CSS lint
([design-token-guard](../.github/workflows/design-token-guard.yml), #2170): the CSS
lint gates the token seam, this gates the a11y seam.

## The shape

For every `ui/` primitive, [`fast-check`](https://fast-check.dev) generates
randomized **valid** prop combinations (an `fc.Arbitrary<ReactElement>` per
primitive), each is rendered in jsdom, and the pillar-4 invariants are asserted
via [`axe-core`](https://github.com/dequelabs/axe-core) plus a direct
keyboard-focus probe. Property-based, not example-based: a single arbitrary covers
the whole prop cross-product a hand-written test would enumerate one case at a time.

Three files, one responsibility each:

- **`registry.tsx`** — classifies every runtime export of `ui/index.ts` as
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
covered set tracks `ui/index.ts` and never silently goes stale. `deferred` is a
reasoned, reason-carrying parking spot (compound base-ui/portal primitives; form
controls whose name comes from a composed Field/Label), not an escape hatch.

## Adding a primitive

Add its export to `ui/index.ts`, then classify it in `registry.tsx` — the coverage
test fails until you do. If it renders standalone with a valid prop arbitrary, make
it `interactive` (with a `selector` for its control) or `presentational`; if it needs
composition/portal/provider context to be representative, make it `deferred` with the
reason. Keep arbitraries generating only **valid** props — the harness asserts that a
correctly-used primitive is accessible, not that misuse is caught.
