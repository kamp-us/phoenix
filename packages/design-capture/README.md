# @kampus/design-capture

The **Playwright-capture + GitHub user-attachments upload** helper the
`review-design` gate drives (ADR
[0165](../../.decisions/0165-review-design-gate.md), epic
[#1966](https://github.com/kamp-us/phoenix/issues/1966)).

It is the mechanical leg of the design gate: given a UI PR's **existing per-PR
preview deploy** URL and the changed surfaces to shoot, it drives a headless
chromium to screenshot each surface, writes the PNG bytes to disk, uploads them
to GitHub so they can be embedded as evidence in the SHA-bound verdict comment,
and returns one record per surface. It **does not** judge the images (that is the
`review-design` skill, [#2246](https://github.com/kamp-us/phoenix/issues/2246)),
and it **does not** serve the app — it captures over the preview the pipeline
already stood up.

## Why it exists

ADR 0162 made the four design pillars — performance · cohesiveness · usability ·
accessibility — standing law; ADR 0165 made `review-design` the gate that checks
every UI PR against that law by *looking at the rendered screen*. A text-diff
review can't see a missing focus ring, off-grid spacing, or a sub-36px tap
target. This package is the "render it and grab the pixels" half: it produces the
screenshots the reviewer agent (Claude, multimodal) judges, and hosts them so a
human can see the evidence behind the verdict.

## The module contract (the seam #2246 codes against)

```ts
import {captureAndUpload, hostedUrls} from "@kampus/design-capture";

const records = yield* captureAndUpload({
  previewUrl: "https://pr-123.web.kamp.us",          // from the preview-deploy bot comment
  surfaces: [{surface: "/sozluk:empty", route: "/sozluk", state: "empty"}],
  outDir: "/tmp/shots",                              // where the PNG bytes land (localPath root)
  repositoryId: 1234177275,                          // gh api repos/OWNER/REPO --jq .id
  token: process.env.GITHUB_TOKEN!,                  // write access to the target repo
});
// records: CaptureRecord[] — one per surface:
//   { surface, route, state, localPath, hostedUrl, uploadError, pageErrors }
//   • localPath  — ALWAYS present on a successful capture: the PNG the gate JUDGES
//   • hostedUrl  — the GitHub asset URL to embed, or null when the upload fell back
//   • uploadError — the diagnostic when the fallback fired, else null
//   • pageErrors — runtime errors thrown into the page during THIS render (#2594):
//       [{ kind: "pageerror" | "console.error", text }] — a `pageerror` (uncaught
//       exception) hard-fails the gate; a `console.error` is advisory
```

- `captureAndUpload(request): Effect<CaptureRecord[], CaptureError, HttpClient>` —
  the primary seam. Requires an `HttpClient` (e.g. `FetchHttpClient.layer`). Only
  a genuine **capture** failure (`CaptureError`) short-circuits; the **upload leg
  never fails the effect** (see the fallback below), so `localPath` is never lost.
- `hostedUrls(records)` projects just the hosted URLs (drops the fallbacks).
- `resolvePreviewUrl(commentBody, app = "web")` resolves an app's preview base
  from the sticky `<!-- preview-deploy -->` comment, keyed off the per-app
  `<!-- preview-deploy:web -->` anchor (deploy.yml / ci.yml). **Keyed off the app
  anchor, not the first `workers.dev` URL** — a blind first-match would return the
  wrong app's URL the moment a second app's preview line appears.

Pure cores also exported for reuse/testing: `parseSurfaceSpec`,
`buildCapturePlan`, `joinPreviewUrl`, `surfaceFileName`, `mergeRecord`,
`parseUploadResponse`, `uploadEndpoint`, `renderCrashFailure` / `isRenderCrash` /
`toPageError` (the render-exception gate decision, #2594), and the viewport
constants (`DESKTOP_VIEWPORT` 1280×800, `MOBILE_VIEWPORT` 390×844,
`DEFAULT_VIEWPORT`).

## `localPath` is the primary judged artifact — never lost to an upload failure

The gate judges the **local PNG bytes** (`localPath`), decoupled from hosting.
Capture always produces `localPath` on success; the upload outcome is folded on
afterward (`mergeRecord`). So even when the upload endpoint is down, the record
still carries `localPath` — the gate has bytes to judge **exactly** when hosting
fails. (This is the correctness fix over an earlier shape that dropped the image
on the fallback path.)

## A thrown render exception fails the gate — regardless of the pixels (#2594)

A single screenshot only sees pixels, so a mount/init race that throws on a "bad
tick" but renders fine on a "good tick" (the `@kampus/composer` read-only
null-editor `TypeError`, #2593) slipped past the visual prohibitions and reached
live. So the capture render **listens for page errors** across the whole
navigation window (`page.on("pageerror" | "console")`, attached before `goto`) and
returns them per surface as `pageErrors`. An uncaught exception (`kind:
"pageerror"`) is a **hard FAIL** for the `review-design` gate; a `console.error` is
**advisory** (dev console.error is noisy — React key/prop warnings — so failing on
it would trip the gate on benign output). The pure decision core
(`renderCrashFailure`) is unit-tested against the #2593 crash class; the `capture`
bin also prints a `render FAILED — …` summary to stderr when any surface threw.

## The undocumented endpoint + the fallback (load-bearing)

The upload POSTs the PNG bytes to
**`uploads.github.com/user-attachments/assets`** — GitHub's **undocumented**
web-composer internal API (ADR 0165, "Evidence hosting"; depo / ADR 0144 was
dropped in favor of it). It works with a user token today but is a recorded
**durability risk**: it can change or break without notice. This package treats
the endpoint as **load-bearing-but-fragile**, not a silent dependency:

- The upload is **display-only and out of the decision path** — the gate judges
  the locally captured bytes; hosting merely *shows* the evidence to a human.
- Every upload failure — a non-2xx status, an unparseable body, a body with no
  recognizable hosted URL, or a transport error — is **caught and degraded** to
  `{hostedUrl: null, uploadError}`. `uploadAsset`'s error channel is `never`; a
  broken endpoint degrades the evidence embed, it **never** breaks the gate.
- This fallback is an **acceptance criterion, unit-tested** (`upload.unit.test.ts`
  drives `uploadAsset` over a stubbed transport for the 5xx and network-failure
  paths; `orchestrate.unit.test.ts` pins that the fallback still yields
  `localPath`), not a TODO.

The technique originates from a public gist
(<https://gist.github.com/MrDHat/b9c008dbe8d387832c0321fac697bcf2>); it is
described self-containedly here and in ADR 0165 so neither depends on that gist
surviving.

## CLI

```bash
# from the repo root
GITHUB_TOKEN=<token> node packages/design-capture/src/bin.ts capture \
  --preview-url https://pr-123.web.kamp.us \
  --surface "/sozluk" --surface "/sozluk:empty" \
  --out /tmp/shots \
  --repo-id 1234177275
```

Prints the `CaptureRecord[]` as JSON on stdout for the `review-design` skill to
judge (`localPath`) and embed (`hostedUrl`). `$GITHUB_TOKEN` is read as a
redacted config, never passed as a flag.

The bin needs the chromium browser binary installed
(`pnpm --filter @kampus/web exec playwright install chromium`, the same binary
the e2e suite uses) — the pure core and the unit tests need neither a browser nor
the network.

## Tests

```bash
pnpm --filter @kampus/design-capture test   # the unit tier
```

Unit-only: the pure plan/parse/resolve/merge cores and `uploadAsset` over a
stubbed transport. There is no integration tier — a real capture needs a live
preview deploy, which the `review-design` reviewer run exercises end to end.
