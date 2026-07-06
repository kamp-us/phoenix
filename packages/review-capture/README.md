# @kampus/review-capture

The **Playwright-capture + GitHub user-attachments upload** helper the
`review-design` gate drives (ADR
[0165](../../.decisions/0165-review-design-gate.md), epic
[#1966](https://github.com/kamp-us/phoenix/issues/1966)).

It is the mechanical leg of the design gate: given a UI PR's **existing per-PR
preview deploy** URL and the changed surfaces to shoot, it drives a headless
chromium to screenshot each surface at deterministic viewports, uploads the PNGs
to GitHub so they can be embedded as evidence in the SHA-bound verdict comment,
and returns per-shot evidence. It **does not** judge the images (that is the
`review-design` skill, #2246), and it **does not** serve the app — it captures
over the preview the pipeline already stood up.

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
import {captureAndUpload, hostedUrls} from "@kampus/review-capture";

const evidence = yield* captureAndUpload({
  previewUrl: "https://pr-123.web.kamp.us",          // from the preview-deploy bot comment
  surfaces: [{label: "sozluk-home", route: "/sozluk"}],
  repositoryId: 1234177275,                          // gh api repos/OWNER/REPO --jq .id
  token: process.env.GITHUB_TOKEN!,                  // write access to the target repo
});
// evidence: ShotEvidence[] — one per (surface × viewport)
//   { _tag: "hosted",   label, hostedUrl }   → embed this GitHub asset URL
//   { _tag: "unhosted", label, diagnostic }  → surface a marked no-hosted-evidence note

const urls = hostedUrls(evidence); // the (previewUrl, surfaces[]) → hostedScreenshotUrl[] projection
```

- `captureAndUpload(request): Effect<ShotEvidence[], CaptureError, HttpClient>` —
  the primary seam. Requires an `HttpClient` (e.g. `FetchHttpClient.layer`). Only
  a genuine capture failure (`CaptureError`) short-circuits; the **upload leg
  never fails the effect** (see the fallback below).
- `ShotEvidence` is a discriminated union: `hosted` carries the embeddable
  GitHub asset URL; `unhosted` carries a diagnostic. The union preserves the
  fallback so the caller never silently loses a shot.
- `hostedUrls(evidence)` projects just the hosted URLs when the `unhosted`
  fallback is surfaced elsewhere.

Pure cores also exported for reuse/testing: `buildCapturePlan`,
`joinPreviewUrl`, `parseUploadResponse`, `uploadEndpoint`, and the viewport
constants (`DESKTOP_VIEWPORT` 1280×800, `MOBILE_VIEWPORT` 390×844,
`DEFAULT_VIEWPORTS`).

## The undocumented endpoint + the fallback (load-bearing)

The upload POSTs the PNG bytes to
**`uploads.github.com/user-attachments/assets`** — GitHub's **undocumented**
web-composer internal API (ADR 0165, "Evidence hosting"; depo / ADR 0144 was
dropped in favor of it). It works with a user token today but is a recorded
**durability risk**: it can change or break without notice.

This package treats the endpoint as **load-bearing-but-fragile**, not a silent
dependency:

- The upload is **display-only and out of the decision path** — the gate judges
  the **locally captured bytes**; hosting merely *shows* the evidence to a human.
- Every upload failure — a non-2xx status, an unparseable body, a body with no
  recognizable hosted URL, or a transport error — is **caught and degraded** to an
  `unhosted` `ShotEvidence` carrying a diagnostic. `uploadAsset`'s error channel
  is `never`; a broken endpoint degrades the evidence embed, it **never** breaks
  the gate.
- This fallback is an **acceptance criterion, unit-tested** (`upload.unit.test.ts`
  drives `uploadAsset` over a stubbed transport for the 5xx and network-failure
  paths, plus the full `parseUploadResponse` classification), not a TODO.

The technique originates from a public gist
(<https://gist.github.com/MrDHat/b9c008dbe8d387832c0321fac697bcf2>); it is
described self-containedly here and in ADR 0165 so neither depends on that gist
surviving.

## CLI

```bash
# from the repo root
GITHUB_TOKEN=<token> node packages/review-capture/src/bin.ts run \
  --preview-url https://pr-123.web.kamp.us \
  --surfaces '[{"label":"sozluk-home","route":"/sozluk"}]' \
  --repository-id 1234177275
```

Prints the `ShotEvidence[]` as JSON on stdout for the `review-design` skill to
embed. `$GITHUB_TOKEN` is read as a redacted config, never passed as a flag.

The bin needs the chromium browser binary installed
(`pnpm --filter @kampus/web exec playwright install chromium`, the same binary
the e2e suite uses) — the pure core and the unit tests need neither a browser nor
the network.

## Tests

```bash
pnpm --filter @kampus/review-capture test   # the unit tier
```

Unit-only: the pure plan/parse cores and `uploadAsset` over a stubbed transport.
There is no integration tier — a real capture needs a live preview deploy, which
the `review-design` reviewer run exercises end to end.
