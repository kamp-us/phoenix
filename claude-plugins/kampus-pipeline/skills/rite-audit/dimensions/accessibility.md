# Dimension: accessibility

Walk the rite's loop surfaces as a keyboard-and-screen-reader user would and assert each is
**operable and perceivable** — no serious/critical WCAG 2.1 A/AA violations, every interactive
element reachable and operable by keyboard with a visible focus ring, and text/UI that clears the
AA contrast floor. Each (check, surface) pair emits one `Finding`; an inaccessible surface is an
unmistakable FAIL, never a silent pass (story 11).

Read [`../DIMENSIONS.md`](../DIMENSIONS.md) first — the `Finding`/`DimensionResult` shapes, the
status semantics, the roll-up rule, and the shared primitives (run context, route map,
Playwright-MCP driver) are defined there and consumed here, not re-derived.

## Declaration

- **`id`** — `accessibility` (this file's basename == id == the *Active dimensions* row key).
- **`surfaces`** — uses the [`SKILL.md`](../SKILL.md) route-map keys. Two tiers:
  - **Full rubric** (all five checks) on the **core 6 loop surfaces**: `/` (landing), `/auth`,
    `/sozluk` + `/sozluk/:slug`, `/pano` + `/pano/yeni`, `/profile` (as the self-registered
    çaylak), `/divan` (as the `testMod`).
  - **axe-scan-only** (A1 + A5, the two static-scan checks) on `/u/:username` and `/search` —
    cross-user read surfaces worth a contrast/violation sweep but outside the keyboard-walk budget.
- **`probe`** — for each surface, in the appropriate identity context: navigate, settle, inject +
  run axe (A1, A5), then on the full-rubric surfaces Tab-walk every interactive element (A2), read
  the focus ring at each stop + on each route/modal transition (A3), and force
  `prefers-reduced-motion: reduce` via the `emulateMedia` seam and assert motion is suppressed
  (A4). See **The probe** below.
- **`rubric`** — the named checks **A1, A2, A3, A4, A5** below. A4 (reduced-motion) drives the
  `emulateMedia` seam ([`SKILL.md`](../SKILL.md) *Playwright MCP wiring*) to force
  `prefers-reduced-motion: reduce` on the core-6 full-rubric surfaces — a real drive-test now that
  #1537 landed the media-emulation seam.

### Finding granularity — one Finding per (check, surface)

The `Finding` key is `dimension` + `check` + `surface` (DIMENSIONS.md), so this dimension emits
**one `Finding` per (check, surface) pair** — a failure names the exact surface it was found on
(`surface: /pano/yeni`), never a single dimension-wide verdict that hides *where* the rite is
inaccessible. With five checks over the core 6 surfaces plus the two axe-scan-only surfaces
(A1 + A5 each), that is `5×6 + 2×2 = 34` findings on a full run. The `check` names (`axe-scan`,
`keyboard-nav`, `focus-visible`, `reduced-motion`, `color-contrast`) are stable across runs so
#1516 diffs cleanly.

## Identity contexts (consumed from the route map / SKILL.md identity model)

One browser context per identity (SKILL.md *one context per identity*), so a stale session never
leaks authority across surfaces:

- **public** (signed-out) — `/`, `/auth`, the public `/sozluk` · `/sozluk/:slug`, `/pano`,
  `/u/:username`, `/search`.
- **çaylak** (the fresh self-registered author the functional rite creates) — `/pano/yeni`,
  `/profile`, and the authenticated write surfaces.
- **testMod** (`testMod.email` / `testMod.password` from the run context) — `/divan`, the only
  surface that resolves for an authorized (mod/yazar) viewer.

Run the `functional-rite` dimension first when present so the çaylak and its sandboxed artifacts
exist; if running standalone, self-register a fresh çaylak through `/auth` exactly as that
dimension's T1 does before walking the çaylak surfaces.

## axe-core delivery — vendored + pinned, never a CDN (Q2 ruling)

The static-scan checks (A1, A5) run **axe-core 4.10.2**, vendored at
[`vendor/axe.min.js`](./vendor/axe.min.js) (MPL-2.0; pin + sha256 + provenance in
[`vendor/README.md`](./vendor/README.md)). The probe **inlines the vendored build into the
`browser_evaluate` body** — it does not fetch from a CDN — so the scan is **CSP-immune**
(no third-party script load to be blocked), **deterministic** (the same rule corpus every run, so
#1516's diff is stable), and **network-free** (never flakes on a CDN outage or a sandboxed-network
stage). Concretely: read the contents of `vendor/axe.min.js` and paste them at the marked point in
the **axe load + run** snippet below, immediately before the `axe.run(...)` call, so the single
`browser_evaluate` call both defines `window.axe` and runs it.

## The probe (prose to follow + JS to paste)

Drive only the **real** Playwright-MCP tools: `browser_navigate`, `browser_wait_for`,
`browser_evaluate`, `browser_snapshot`, `browser_press_key`, `browser_take_screenshot`,
`browser_resize`, `browser_emulate_media` (the media-emulation seam — SKILL.md *Playwright MCP
wiring*). Do not invent a tool. Every check is `drive → observe → assert → record` and emits
exactly one `Finding` per surface in the shape DIMENSIONS.md defines.

For **each surface** in this dimension's `surfaces`:

1. In the surface's identity context, `browser_navigate` to `${baseUrl}<path>` (route map paths,
   never a literal origin) and `browser_wait_for` the surface's load-bearing anchor to settle
   (the route map's key `data-testid` / form field) so axe and the Tab-walk see the final DOM.
2. **A1 + A5 — inject and run axe** with the *axe load + run* snippet (one `browser_evaluate`).
3. On the **full-rubric** surfaces only: **A2** Tab-walk with `browser_press_key('Tab')` +
   the *focus probe* snippet; **A3** read the focus ring at each stop and across each
   route/modal transition, `browser_take_screenshot` as evidence.
4. On the **full-rubric** surfaces only: **A4** — force `prefers-reduced-motion: reduce` via
   `browser_emulate_media`, then run the *reduced-motion probe* snippet to observe the app
   suppressed motion; restore the default (`{ reducedMotion: 'no-preference' }`) after.

### Snippet — axe load + run (paste into `browser_evaluate`; backs A1 + A5)

```js
async () => {
  // >>> PASTE THE FULL CONTENTS OF ./vendor/axe.min.js HERE (defines window.axe) <<<
  if (!window.axe) throw new Error("axe-core failed to define window.axe");
  const results = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] });
  const isBlocking = (v) => v.impact === "serious" || v.impact === "critical";
  const blocking = results.violations.filter(isBlocking);
  const contrast = results.violations.filter((v) => v.id === "color-contrast");
  return JSON.stringify({
    // A1 evidence: blocking violation ids + total offending node count
    blockingIds: blocking.map((v) => v.id),
    blockingNodeCount: blocking.reduce((n, v) => n + v.nodes.length, 0),
    // A5 evidence: per-node contrast failures with the measured ratio axe reports
    contrast: contrast.flatMap((v) =>
      v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
    ),
    axeVersion: window.axe.version,
  });
}
```

If `browser_evaluate` throws (axe could not define `window.axe`) or the surface never settled,
the scan **could not run** → record **BLOCKED** for that (check, surface), never PASS.

### Snippet — focus probe (paste into `browser_evaluate`; backs A3, and A2's operability read)

```js
() => {
  const el = document.activeElement;
  if (!el || el === document.body) return JSON.stringify({ focused: null });
  const s = getComputedStyle(el);
  const outlineRing = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
  const shadowRing = s.boxShadow !== "none" && s.boxShadow !== "";
  // Tailwind focus rings render as a box-shadow var; treat a non-empty ring var as a ring too
  const twRing = (s.getPropertyValue("--tw-ring-shadow") || "").trim() !== "none" &&
    (s.getPropertyValue("--tw-ring-shadow") || "").trim() !== "";
  return JSON.stringify({
    tag: el.tagName,
    testid: el.getAttribute("data-testid"),
    role: el.getAttribute("role"),
    text: (el.textContent || "").trim().slice(0, 40),
    outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
    boxShadow: s.boxShadow,
    visibleFocusRing: outlineRing || shadowRing || twRing,
  });
}
```

### Tab-walk (A2 — `browser_press_key`, no invented tool)

1. `browser_snapshot` to read the accessibility tree and enumerate the surface's interactive
   elements (links, buttons, form fields, custom `role` widgets) — this is the expected reachable
   set.
2. From the top of the document, `browser_press_key('Tab')` repeatedly; after **each** Tab run the
   *focus probe* snippet to read `document.activeElement`. Record the ordered set of elements the
   focus visited.
3. For a focusable control that performs an action, `browser_press_key('Enter')` (and, for a
   button/checkbox/switch, `browser_press_key(' ')` / `'Space'`) and observe that it operates
   (the same observable effect a pointer activation produces).
4. **Keyboard-trap probe:** if Tab stops advancing — `document.activeElement` is unchanged across
   consecutive Tabs and never escapes a region (e.g. an open modal/sheet) — that is a trap.

### Snippet — reduced-motion probe (paste into `browser_evaluate`; backs A4)

Run **after** forcing `prefers-reduced-motion: reduce` via `browser_emulate_media`. It confirms
the media feature is actually forced (`matchMedia` reports `reduce`), then sweeps every rendered
element for a non-trivial CSS `animation`/`transition` that the app failed to suppress under
`reduce` — an app that respects the preference collapses these to `none`/`0s` (a
`@media (prefers-reduced-motion: reduce)` rule, or a motion-off token). A non-empty
`unsuppressed` array is the FAIL evidence: the element + the animation/transition still running.

```js
() => {
  const forced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const running = (s) => {
    const anim = s.animationName !== "none" &&
      parseFloat(s.animationDuration) > 0;
    const trans = parseFloat(s.transitionDuration) > 0;
    return anim || trans;
  };
  const unsuppressed = [...document.querySelectorAll("*")]
    .filter((el) => running(getComputedStyle(el)))
    .slice(0, 20)
    .map((el) => {
      const s = getComputedStyle(el);
      return {
        tag: el.tagName,
        testid: el.getAttribute("data-testid"),
        animationName: s.animationName,
        animationDuration: s.animationDuration,
        transitionDuration: s.transitionDuration,
      };
    });
  return JSON.stringify({ forced, unsuppressedCount: unsuppressed.length, unsuppressed });
}
```

If `forced` is `false` the seam did not take effect (or is unavailable) → the check **could not
run** → record **BLOCKED** for that (check, surface), never PASS.

## The rubric — A1, A2, A3, A4, A5 (each emits one `Finding` per surface)

### A1 — axe-scan

- **check name** — `axe-scan`. **Runs on** all surfaces (core 6 + the two axe-scan-only).
- **drive** — Inject + run axe via the *axe load + run* snippet on the settled surface.
- **observe** — `blockingIds` / `blockingNodeCount` from the snippet result.
- **assert / record** — **PASS** iff axe reports **no `serious` or `critical`** violation. **FAIL**
  on any (evidence = the violation ids + offending node count from the snippet). **BLOCKED** if axe
  could not run or the surface would not load (the `browser_evaluate` threw / never settled).
  `surface:` the route walked.

### A2 — keyboard-nav

- **check name** — `keyboard-nav`. **Runs on** the core 6 full-rubric surfaces only.
- **drive** — Tab-walk (above): enumerate interactive elements from `browser_snapshot`, then
  Tab through them, operating actionable controls via Enter/Space.
- **observe** — the ordered focus set the Tab-walk visited vs the expected interactive set; whether
  each actionable control operated; whether focus ever trapped.
- **assert / record** — **PASS** iff **every** interactive element is reachable via Tab **and**
  operable via Enter/Space **and** there is **no keyboard trap**. **FAIL** if an interactive element
  is unreachable, inoperable by keyboard, or focus traps (evidence = the unreachable/trapping
  element's testid/role + the visited-vs-expected sets). **BLOCKED** if the surface would not load
  or the snapshot could not be read. `surface:` the route walked.

### A3 — focus-visible

- **check name** — `focus-visible`. **Runs on** the core 6 full-rubric surfaces only.
- **drive** — At each Tab stop run the *focus probe* snippet; additionally read the focus probe
  **after each route change** and **after opening any modal/sheet** (e.g. the `VouchSheet` on
  `/divan`, opened via `vouch-button`). `browser_take_screenshot` at representative focus stops and
  at each transition as evidence.
- **observe** — `visibleFocusRing` per stop (a non-`none` outline/ring/box-shadow via
  `getComputedStyle`); where focus lands after a route change and after a modal/sheet opens.
- **assert / record** — **PASS** iff the focused element **always** shows a visible focus indicator
  **and** focus moves sensibly on route change (not lost to `<body>`) **and** moves **into** an
  opened modal/sheet (and is restored on close). **FAIL** if any focused element shows no visible
  ring, or focus is lost/stranded on a transition, or never enters an opened modal (evidence =
  the screenshot ref + the focus-probe `boxShadow`/`outline` readout). **BLOCKED** if the surface
  would not load. `surface:` the route walked.

### A4 — reduced-motion

- **check name** — `reduced-motion`. **Runs on** the core 6 full-rubric surfaces only.
- **drive** — Force `prefers-reduced-motion: reduce` via `browser_emulate_media` (the
  `emulateMedia` seam, SKILL.md *Playwright MCP wiring*), then run the *reduced-motion probe*
  snippet on the settled surface. Restore `{ reducedMotion: 'no-preference' }` after so the forced
  state never leaks into the next surface's checks.
- **observe** — `forced` (did the seam take effect — `matchMedia('(prefers-reduced-motion:
  reduce)')` reports `reduce`) and the `unsuppressed` array (elements still running a non-trivial
  CSS `animation`/`transition` under `reduce`).
- **assert / record** — **PASS** iff the feature forced ON (`forced === true`) **and** the app
  suppressed motion (`unsuppressed` is empty — every animation/transition collapsed to `none`/`0s`
  under `reduce`). **FAIL** if any element keeps animating under `reduce` (evidence = the
  `unsuppressed` entries: element testid + the animation/transition still running). **BLOCKED** if
  the seam did not take effect (`forced === false` — media emulation unavailable) or the surface
  would not load. `surface:` the route walked.

### A5 — color-contrast

- **check name** — `color-contrast`. **Runs on** all surfaces (core 6 + the two axe-scan-only).
- **drive** — Read axe's `color-contrast` rule subset from the *axe load + run* snippet's
  `contrast` array (the AA floor: 4.5:1 body text, 3:1 large text + UI components).
- **observe** — the per-node `color-contrast` failures axe reports, each with its measured ratio in
  the `failureSummary`.
- **assert / record** — **PASS** iff axe reports **no** `color-contrast` violation. **FAIL** on any
  (evidence = the offending nodes + the measured ratio from `failureSummary`). **BLOCKED** if axe
  could not run or the surface would not load. `surface:` the route walked.

## Roll-up

Per [`../DIMENSIONS.md`](../DIMENSIONS.md): `accessibility` is **PASS iff every emitted `Finding`
is PASS**; any FAIL **or** BLOCKED ⇒ the dimension FAILs. Emit all `Finding`s (one per
(check, surface), never drop one), with axe evidence and focus screenshots, and hand the bundle to
the harness for the #1516 verdict report.
