# Property-based a11y — the promotion loop over the `ui/` primitives

The third enforcement rung of the ADR
[0162](../../../../../.decisions/0162-four-pillars-design-law.md) four-pillars
design law (issue #2175), above the deterministic CSS lint
([design-token-guard](../../../../../.github/workflows/design-token-guard.yml),
#2170) and complementary to the `review-design` judgment gate (#2174).

It generates randomized **valid** prop combinations for each `ui/` primitive with
[`fast-check`](https://fast-check.dev), renders each in jsdom, and asserts the
pillar-4 accessibility invariants via [`axe-core`](https://github.com/dequelabs/axe-core).

## The warning-to-enforced promotion loop

Each invariant carries a **posture** in [`posture.ts`](./posture.ts):

- `enforced` — a violation **fails the gate**. The jsdom-decidable rules:
  **accessible name**, **valid ARIA**, **keyboard focusability**.
- `warning` — a violation is **reported, not enforced**. The geometry/paint rules
  jsdom cannot decide (no layout engine, no applied CSS): **contrast** and
  **tap-target**. These are promotion candidates for a real-browser (Playwright)
  a11y pass.

**Promoting** a warning to enforced is a one-line edit to `posture.ts` — see the
documented procedure in that file. That is the loop: a miss a reviewer keeps
catching by hand becomes a standing property test, then a blocking gate.

## Auto-coverage — a new primitive fails until classified

[`registry.tsx`](./registry.tsx) classifies **every runtime export** of
[`../index.ts`](../index.ts) as `interactive`, `presentational`, or `deferred`.
The coverage test in [`a11y-pbt.test.tsx`](./a11y-pbt.test.tsx) asserts the
registry key set **equals** the barrel's runtime export set — so a newly added
primitive that no one classified, or a stale entry for a removed one, **fails the
gate** (fail-closed, ADR
[0092](../../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)). The
covered set can never silently go stale.

`deferred` is a conscious, reasoned parking spot (a compound base-ui/portal
primitive, or a control whose accessible name comes from a composed Field/Label),
each carrying its promotion reason — not an escape hatch.

## Run it

```bash
pnpm --filter @kampus/web test:a11y
```

Wired as a standalone CI gate in
[`.github/workflows/a11y-pbt.yml`](../../../../../.github/workflows/a11y-pbt.yml)
(least-privilege `contents: read`).
