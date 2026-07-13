# @kampus/local-render

The **local render-and-capture harness** — the root prerequisite of the write-code
render-and-look inner loop ([epic #2953](https://github.com/kamp-us/phoenix/issues/2953),
issue [#2963](https://github.com/kamp-us/phoenix/issues/2963)). It renders the **composed
UI surface** of the app over a running local `alchemy dev` build and writes per-surface
PNG(s) to disk, so a write-code agent can *see* the assembled page — not just the diff —
before opening a UI PR.

```
running local build          this harness                      on disk
(pnpm dev: Vite + alchemy) → resolve local base → build plan → captureShots → surface.png
                             + dev-override cookie  + crop/downscale  (design-capture)
```

Neither [`@kampus/design-capture`](../design-capture/README.md) (shoots a *deployed*
preview URL) nor `@kampus/audit-run` (a *deployed* stage) targets a local build — this adds
that targeting on top of design-capture's plan/viewport/**capture** primitives. It does
**not** re-implement browser capture: the Playwright leg is design-capture's `captureShots`.

## What it renders — the composed surface over `alchemy dev`

Under `pnpm dev` the composed page (chrome + shell — the composition-defect surface) is
served by the **Vite dev origin** (`http://localhost:3000`), which serves the React SPA +
HMR and proxies `/api` and `/fate` to the `alchemy dev` worker (vhost-routed at
`http://phoenix.localhost:1337`). So the harness renders the Vite origin by default; point
`--base` elsewhere if your build serves the composed surface at another localhost origin.
`resolveLocalBase` refuses any non-loopback origin — a *local* render harness never renders
(or seeds a dev-override cookie into) a remote/production origin.

**Start the build first.** The harness renders a *running* build; run `pnpm dev` (or
`pnpm dev:worker` + `pnpm dev:web`) before invoking it. A down server surfaces loudly as a
`CaptureError` (the Playwright navigation fails).

## The two decided local-render constraints

- **Empty local D1, no seeding** (#2941). Composition is a property of the chrome/shell, and
  designed-empty states are exactly the in-scope defect class. The harness adds nothing to
  the local build — whatever the local worker serves is what renders. (No seeder is
  rebuilt; that is a founder v1 non-goal + security guard.)
- **Flag-gated UI via the existing dev-override cookie** (#2946). `--flag "<key>=on|off"`
  seeds the `phoenix_flag_overrides` cookie (same name + URL-encoded-JSON wire format as the
  worker's [`dev-override.ts`](../../apps/web/worker/features/flagship/dev-override.ts)) into
  the capture context, so a flag-gated surface renders locally with no new mechanism.

## Cost control — crop + downscale under a documented budget

Vision loops run 10–20x cost unbudgeted (#2943), so captures are bounded two ways, both
native to Playwright (no image dependency):

- **Crop** to the changed region — `--region "<surface>=x,y,w,h"` (CSS px) narrows the shot
  to that rectangle instead of the full page (the primary lever; drops the tall scroll).
- **Downscale** — when a region's known longest edge exceeds the budget, the shot renders at
  a `deviceScaleFactor` < 1 (device pixels = CSS pixels × dpr), bringing the raster longest
  edge under budget.

The budget is the longest edge in device px — **`LONGEST_EDGE_BUDGET = 1400`** by default,
overridable with `--budget`. The crop/downscale plan (`planCaptureDirective`) is pure and
unit-tested; the impure browser leg is injected.

## Pure core + injected impure leg

Same idiom design-capture follows: the pure selection logic (base resolution, cookie build,
crop/downscale plan, CLI-token parsers — [`plan.ts`](./src/plan.ts)) is unit-tested, and the
orchestration ([`render.ts`](./src/render.ts)) is parameterized over the capture leg
(`CaptureLeg`, defaulting to `captureShots`) so the unit test injects a fake — no real
browser, no local dev server in the tests.

## Usage

```
# render two surfaces of the running local build to ./shots
node packages/local-render/src/bin.ts render \
  --surface "/sozluk" \
  --surface "/pano:empty" \
  --out ./shots

# flag-gated surface + a cropped/downscaled region
node packages/local-render/src/bin.ts render \
  --surface "/pano" \
  --flag "pano-draft-save=on" \
  --region "/pano=0,0,1280,2600" \
  --out ./shots
```

It prints a JSON array of per-surface records
`{ surface, route, state, localPath, fileName }` on stdout — the `localPath` is the on-disk
PNG the downstream evidence-attach step
([#2964](https://github.com/kamp-us/phoenix/issues/2964)) uploads and attaches to the PR.

## What downstream consumes

- **#2964 (evidence-attach)** consumes each record's **`localPath`** (the on-disk PNG) — it
  runs the harness for the before/after captures and uploads+attaches them per the SHA-bound
  convention (reusing design-capture's `captureAndUpload`/`uploadAsset`).
- **#2965 (§CP write-code loop)** invokes the `render` entry at its render→look→fix decision
  points.

## Commands

```bash
pnpm --filter @kampus/local-render test        # unit tier
pnpm --filter @kampus/local-render typecheck
```
