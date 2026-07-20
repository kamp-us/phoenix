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

## Force the edge payload at the network seam, not from a page script

A journey must run green in local/CI, where a dark-ship flag resolves to its **safe default
(off)** — so you cannot depend on the worker's on-path render to fire. Reproduce it
deterministically instead.

**`page.addInitScript` is the wrong seam whenever the worker also writes the state.** It runs
before any page *script*, but it does not run after the *document* — so an inline tag the server
injected into `<head>` executes later and overwrites the seed. That is exactly what happened to
`window.__BOOT__` when #3672 retired the containment flag: CI had been serving the flag off, the
worker never injected, and `addInitScript` was the payload's only writer. The moment the worker
injected unconditionally the seed was silently clobbered and the spec went red. So:

> Seed with `addInitScript` only for state **nothing on the server writes** (an observer, a
> stub, a clock). For state the server injects, **rewrite the document response.**

Intercept the navigation, strip the server's tag, and re-inject the payload under test:

```ts
await page.route("**/*", async (route) => {
  if (route.request().resourceType() !== "document") return route.continue();
  const response = await route.fetch();
  const headers = {...response.headers()};
  if (!(headers["content-type"] ?? "").includes("text/html")) return route.fulfill({response});
  delete headers["content-length"];   // the body below is decoded and re-length'd
  delete headers["content-encoding"];
  const stripped = (await response.text()).replace(WORKER_BOOT_SCRIPT, "");
  // `boot === null` serves the shell with NO payload — see the fallback half below.
  const body = boot === null ? stripped : stripped.replace(/<\/head>/i, `${bootTag(boot)}</head>`);
  await route.fulfill({status: response.status(), headers, body});
});
await page.goto("/");
```

The substituted payload reproduces the on-path first paint because `useFlag` resolves a
shell-key-manifest member **synchronously** off `__BOOT__` with no fetch (ADR 0179 §3) — the
nav flags render their final geometry on the first frame — and it now arrives on the same wire
the edge uses, so there is no ordering race left to lose. The `__BOOT__` boolean keys are the
flag-key **strings** (`shell-keys.ts`), and `user` is the edge-resolved identity (ADR 0185).
This is the same split `28-reaction-bar-darkship` uses: unit tests own the pure resolution
logic, the e2e owns the in-browser first-paint proof.

Have the interceptor **count the documents it rewrote** and assert that count is non-zero in any
test whose assertion is about *absence*. Otherwise a silently no-op'd route makes the test pass
against the un-rewritten server response.

## Assert geometry two ways — bounding box (strict) + scoped CLS (metric)

The AC is *final geometry at first paint, zero CLS*. Prove it with two orthogonal checks:

1. **Bounding-box stability (deterministic).** Capture `boundingBox()` of the shell region
   (`.kp-topbar` + the nav links), let the page hydrate + settle
   (`waitForLoadState("networkidle")` + a fixed wait), re-capture, and assert `toEqual`. This
   is the strict "the slots do not move" proof.

   **Anchor that capture after `await page.evaluate(() => document.fonts.ready)`.** Against a
   real deployment the webfont swaps a few hundred ms in and moves every nav link several px —
   nothing to do with the payload contract, but enough to red an exact `toEqual` depending on
   network latency. Waiting for the swap keeps the strict check measuring the thing it is for
   (hydration and the session/flag settle move nothing) instead of a font race.

   Pop-in is then asserted separately and **font-independently**: snapshot the nav's link texts
   (`locator(".kp-topbar__nav a").allInnerTexts()`) at first paint, before the `fonts.ready`
   wait, and assert the set is unchanged after settle. A late-resolving flag adds or drops an
   entry there whichever way the pixels moved.
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

## Cover the absent-payload half too (AC4)

Add a test served with **no** boot payload at all: assert the shell still renders and the client
resolves through its fetch fallback — the absent-payload path is a first-class, non-error state
(ADR 0179 §4), and it is what the never-hang guard degrades to.

Assigning `window.__BOOT__ = undefined` from an init script **does not produce this state** and
never did anything but coincide with a flag-off environment. Serve it from the interceptor above
with `boot === null`, so the document genuinely carries no boot script.

## Lane + a divergence gotcha

A signed-out journey spec lands in the `flows` project automatically (it is neither a
`UNAUTH_SPECS` nor the `AUTHED_SPECS` entry — `playwright.config.cjs`); no config edit needed.
**Do not serve a signed-in `__BOOT__.user` while asserting cross-settle CLS in the signed-out
lane:** `reserveSignedInSlots` is on during `session.isPending` then collapses when the real
session settles signed-out (`App.tsx`), a deliberate boot/session-divergence collapse that
*will* shift the account slot. Assert only the first-paint CTA state (giriş-yap suppressed) for
a signed-in-payload signed-out test, and keep the zero-CLS assertion on the nav-geometry test.
