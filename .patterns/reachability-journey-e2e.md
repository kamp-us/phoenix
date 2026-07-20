# Reachability journey e2e — proving a flag's first-paint UX

Every user-facing dark-ship flag needs a **journey e2e** before it can graduate (ADR
[0173](../.decisions/0173-vertical-completeness-gate.md) §2): a playwright spec under
`apps/web/tests/e2e/` whose `test`/`describe` title carries a `@journey:<flag-key>` tag.
`reachability-guard` asserts the tag exists; the e2e job runs the spec. This doc is how to
write one that actually exercises the on-path — not an empty-bodied stub that only satisfies
the static check.

The worked reference is `apps/web/tests/e2e/29-edge-shell-boot-journey.spec.ts`, which proves the
zero-CLS correct-first-paint contract of the edge-resolved shell (ADR
[0179](../.decisions/0179-edge-resolved-shell-state-boot-contract.md)). Its own flag has since
retired (#3672), so it no longer carries a `@journey:` tag — the technique below is what to copy,
and `30-member-mute-journey.spec.ts` is a live tagged example.

## Seed the edge payload client-side, don't wait on a live flag flip

A journey must run green in local/CI, where a dark-ship flag resolves to its **safe default
(off)** — so you cannot depend on the worker's on-path render to fire. Reproduce it
deterministically instead: seed the edge-injected state with `page.addInitScript`, which runs
**before any page script** — the same ordering the worker's `<head>` injection has (ADR 0179
§2). For the shell, that means seeding `window.__BOOT__`:

```ts
await page.addInitScript((boot) => { window.__BOOT__ = boot; }, BOOT_NAV_ON);
await page.goto("/");
```

The seeded payload reproduces the on-path first paint because `useFlag` resolves a
shell-key-manifest member **synchronously** off `__BOOT__` with no fetch (ADR 0179 §3) — the
nav flags render their final geometry on the first frame, exactly as the worker render
produces. The `__BOOT__` boolean keys are the flag-key **strings** (`shell-keys.ts`), and
`user` is the edge-resolved identity (ADR 0185). This is the same split
`28-reaction-bar-darkship` uses: unit tests own the pure resolution logic, the e2e owns the
in-browser first-paint proof.

## Assert geometry two ways — bounding box (strict) + scoped CLS (metric)

The AC is *final geometry at first paint, zero CLS*. Prove it with two orthogonal checks:

1. **Bounding-box stability (deterministic).** Capture `boundingBox()` of the shell region
   (`.kp-topbar` + the nav links) right after load, let the page hydrate + settle
   (`waitForLoadState("networkidle")` + a fixed wait), re-capture, and assert `toEqual`. This
   is the strict "the slots do not move" proof.
2. **A layout-shift observer scoped to the shell (the CLS metric).** Install a
   `PerformanceObserver({type: "layout-shift", buffered: true})` in an init script that only
   accrues shifts whose `sources[].node` lives inside `.kp-topbar` — so below-fold content
   settling (feed, images) never pollutes the shell measurement. Assert it stays **under a
   sub-pixel epsilon** (`toBeLessThan(0.01)`), not a literal `0`: a real browser produces
   ~7e-5 of font-metric reflow, orders of magnitude below the CLS "good" threshold (0.1,
   web.dev/cls) and below perceptibility. A literal-`0` assertion is falsely strict.

`layout-shift` entry fields (`value`/`hadRecentInput`/`sources`) aren't on the DOM lib's
`PerformanceEntry`; declare a local `LayoutShiftEntry` interface (types erase — the init
script runs in the browser).

## Cover the dark-ship half too (AC4)

Add a test with **no** `__BOOT__` seeded (`window.__BOOT__ = undefined`): assert the shell
still renders (byte-identical to today's edge-direct render) and the client resolves through
its fetch fallback — the absent-payload path is a first-class, non-error state (ADR 0179 §4).

## Lane + a divergence gotcha

A signed-out journey spec lands in the `flows` project automatically (it is neither a
`UNAUTH_SPECS` nor the `AUTHED_SPECS` entry — `playwright.config.cjs`); no config edit needed.
**Do not seed a signed-in `__BOOT__.user` while asserting cross-settle CLS in the signed-out
lane:** `reserveSignedInSlots` is on during `session.isPending` then collapses when the real
session settles signed-out (`App.tsx`), a deliberate boot/session-divergence collapse that
*will* shift the account slot. Assert only the first-paint CTA state (giriş-yap suppressed) for
a seeded-user signed-out test, and keep the zero-CLS assertion on the nav-geometry test.
