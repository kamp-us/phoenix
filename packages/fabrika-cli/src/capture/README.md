# @kampus/fabrika-cli/capture

The **Playwright-capture + GitHub user-attachments upload** helper the
`review-design` gate drives.

It is the mechanical leg of the design gate: given a UI PR's **existing per-PR
preview deploy** URL and the changed surfaces to shoot, it drives a headless
chromium to screenshot each surface, writes the PNG bytes to disk, uploads them
to GitHub so they can be embedded as evidence in the SHA-bound verdict comment,
and returns one record per surface. It **does not** judge the images (that is the
`review-design` skill), and it **does not** serve the app — it captures over the
preview the pipeline already stood up.

## Why it lives in fabrika

It began as a private package in the repo that grew it. It moved here because
`build-ui` and `review-ui` are factory tooling every adopter repo runs — and every one of
them would otherwise need a dependency on someone else's published package to get the
machinery the skills call. One release train, fabrika's.

**What stays per-repo is the data**, and none of it moved. The line is sharp:
anything naming a *host* or a *credential* belongs to the consuming repo — the blessed
golden bytes, the store they are PUT to and GET from, the pointer file that names them,
and the harness config. A repo that has never blessed a surface carries no store half at
all; the pointer path is what this package probes for. Machinery is shared; goldens are a
repo's own taste.

That split is also load-bearing for *installability*, not only taste: this package is
published, and a published artifact may depend only on what a clean registry resolves —
so a dependency on a consuming repo's private package would not resolve at all. An asset
store is therefore an injected `StoreLeg` here — the shape, never the store.

## Why it exists

The four design pillars — performance · cohesiveness · usability · accessibility
— are standing law, and `review-design` is the gate that checks every UI PR
against that law by *looking at the rendered screen*. A text-diff review can't
see a missing focus ring, off-grid spacing, or a sub-36px tap target. This
package is the "render it and grab the pixels" half: it produces the screenshots
the reviewer agent (Claude, multimodal) judges, and hosts them so a human can see
the evidence behind the verdict.

## The module contract (the seam the gate codes against)

```ts
import {captureAndUpload, hostedUrls} from "@kampus/fabrika-cli/capture";

const records = yield* captureAndUpload({
  previewUrl: "https://pr-123.preview.example.com",  // from the preview-deploy bot comment
  surfaces: [{surface: "/catalog:empty", route: "/catalog", state: "empty"}],
  outDir: "/tmp/shots",                              // where the PNG bytes land (localPath root)
  repositoryId: 1234177275,                          // gh api repos/OWNER/REPO --jq .id
  token: process.env.GITHUB_TOKEN!,                  // write access to the target repo
});
// records: CaptureRecord[] — one per surface:
//   { surface, route, state, localPath, hostedUrl, uploadError, pageErrors }
//   • localPath  — ALWAYS present on a successful capture: the PNG the gate JUDGES
//   • hostedUrl  — the GitHub asset URL to embed, or null when the upload fell back
//   • uploadError — the diagnostic when the fallback fired, else null
//   • pageErrors — runtime errors thrown into the page during THIS render:
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
  `<!-- preview-deploy:web -->` anchor the deploy workflow writes. **Keyed off the
  app anchor, not the first URL in the block** — a blind first-match would return
  the wrong app's URL the moment a second app's preview line appears.
- `readPreviewAnnouncement(commentBody, app)` reads the same block for a caller that
  must **bind the preview to a head**: it returns the URL *and* the deployed head SHA,
  is domain-agnostic (an adopter's preview is on its own host), and splits
  `Malformed` from `NoApp` so an unreadable announcement can never resolve to "no
  preview". `announcedApps` / `isPreviewAnnouncement` are its two probes. The
  `review-ui render` verb refuses on the SHA mismatch: pixels of an old tree must not
  bind a new head.
- `validateCaptureBytes(pngBytes)` is the capture-validity check — zero bytes,
  undecodable, or zero area — over the PNG header alone (`decodePngHeader`), so it stays
  pure and codec-free. A capture nobody can open is not evidence.

Pure cores also exported for reuse/testing: `parseSurfaceSpec`,
`buildCapturePlan`, `joinPreviewUrl`, `surfaceFileName`, `mergeRecord`,
`parseUploadResponse`, `uploadEndpoint`, `renderCrashFailure` / `isRenderCrash` /
`toPageError` (the render-exception gate decision), and the viewport
constants (`DESKTOP_VIEWPORT` 1280×800, `MOBILE_VIEWPORT` 390×844,
`DEFAULT_VIEWPORT`).

## `localPath` is the primary judged artifact — never lost to an upload failure

The gate judges the **local PNG bytes** (`localPath`), decoupled from hosting.
Capture always produces `localPath` on success; the upload outcome is folded on
afterward (`mergeRecord`). So even when the upload endpoint is down, the record
still carries `localPath` — the gate has bytes to judge **exactly** when hosting
fails. (This is the correctness fix over an earlier shape that dropped the image
on the fallback path.)

## A thrown render exception fails the gate — regardless of the pixels

A single screenshot only sees pixels, so a mount/init race that throws on a "bad
tick" but renders fine on a "good tick" slips past the visual prohibitions and
reaches live — a read-only editor that dereferences a null instance is the class.
So the capture render **listens for page errors** across the whole navigation
window (`page.on("pageerror" | "console")`, attached before `goto`) and returns
them per surface as `pageErrors`. An uncaught exception (`kind: "pageerror"`) is a
**hard FAIL** for the `review-design` gate; a `console.error` is **advisory** (dev
console.error is noisy — React key/prop warnings — so failing on it would trip the
gate on benign output). The pure decision core (`renderCrashFailure`) is
unit-tested against that crash class; the `capture` bin also prints a
`render FAILED — …` summary to stderr when any surface threw.

## The golden-baseline seam (store · resolve · deterministic diff)

Beyond capture+upload, this package is the **golden-baseline substrate** the
generation loop and the `review-design` gate both anchor to — one notion of
"golden", never two. The storage design is fixed: **golden bytes live in a
content-addressed, immutable asset store**; git carries only a tiny **pointer**.
No golden PNG is ever committed.

- **golden pointer** — a committed `golden-pointer.json` mapping each surface-id
  (the same `<route>[:state]` capture spec) to its current golden
  `{ sha256, blessedDate, intent }`. A re-bless is a one-line diff; history never
  bloats with binaries. This is the committed-baseline + `bless` idiom a migrations
  guard uses: the pointer file is the audited baseline, and the store's write-once
  immutability IS the "explicit update, never silent overwrite" guarantee — a
  re-bless is a **new sha256 → new store URL → a pointer move**, never an in-place
  overwrite.

```ts
import {
  diffRasters,          // deterministic rendered-vs-golden diff → structured DiffResult
  blessSurface,         // move the git pointer to an approved sha (immutably)
  loadGoldenPointer,
} from "@kampus/fabrika-cli/capture";
// the store half is the consuming repo's own package, not this one
import {resolveGoldenBytes, storeGolden} from "<consuming repo's golden store>";

// store (bless-time): PUT the approved bytes, get the sha the pointer records
const {sha256, url} = yield* storeGolden({apiKey, pngBytes});   // needs the store client

// resolve (diff-time): pointer → store URL → bytes
const pointer = loadGoldenPointer("path/to/golden-pointer.json");
const golden = yield* resolveGoldenBytes(pointer, "/catalog:empty");  // needs HttpClient

// diff: candidate vs golden — the SIGNAL, not the verdict
const result = diffRasters(goldenRaster, candidateRaster, {
  masks: [{x: 0, y: 0, width: 120, height: 24}],  // known-dynamic region (a timestamp)
});
// result: { dimensionsMatch, magnitude, diffPixels, comparedPixels, maskedPixels, regions }
```

- `storeGolden` / `resolveGoldenUrl` / `resolveGoldenBytes` are the **consuming repo's**, not
  this package's — they name a store host and a credential. An adopter supplies its own and
  passes the write half in as the injected `StoreLeg` below. What this package owns is the
  *shape*: `StoredGolden` is `{sha256, url}`, and an **unblessed surface resolves to `null`**
  (nothing to compare against yet), never an error.
- `diffRasters(golden, candidate, {masks, channelThreshold})` is the **deterministic
  diff** — same inputs always yield the same result. It returns a **structured
  per-surface result** (deviation `magnitude` in [0, 1] + the differing `regions` as
  bounding boxes), **not a bare boolean**: the accept/redline *judgment* is the
  `review-design` gate's, not this core.
- **Flake-canon split.** The capture-time canon (animations off, reduced-motion,
  `document.fonts.ready`, srgb, seeded data + frozen clock) is enforced when the
  bytes are *rendered*, in the render harness. The **diff-time** canon lives
  here: known-dynamic regions are **masked** out of the compare so a legitimately
  varying region never reads as a deviation. `diffRasters` operates on **decoded RGBA
  rasters**, so it needs no PNG codec and stays pure/unit-tested; decoding golden +
  candidate PNG bytes into a `RasterImage` is the render caller's boundary.
- The pure cores — `golden-pointer.ts` (resolve/bless), `golden-diff.ts`
  (determinism/masking/regions), `golden-fs.ts` (pointer round-trip) — are
  unit-tested.

### Re-bless via a CLI (the audited pointer move)

The invocations below are the worked shape of each operation — the argv a consuming
repo's own bin has to reproduce over these cores.

```bash
# after the operator approves a surface's candidate in the PR gallery comment,
# and its bytes are already PUT to the store (the no-re-render guard):
<bin> golden-bless \
  --surface "/catalog:empty" \
  --sha256 <64-hex content-address of the approved bytes> \
  --intent "catalog empty state — initial bless"
```

`golden-bless` is pure + fs (the golden analogue of a migrations guard's `baseline`):
it records the **approved** sha into the committed pointer — it never re-renders or
re-stores bytes, so "what the operator saw" and "what gets committed" are provably the
same content address.

## The candidate-render step (`render-candidates`)

The candidate-render step produces the small set of candidate screens an operator
blesses in one sitting. It renders the **priority surfaces, in order** — the ones
`PRIORITY_SURFACES` names — over a **flag-forced preview deploy**, PUTs each
candidate's bytes to the store, and emits a **candidate set** staged for blessing.
It does **not** bless — blessing is the operator's step; this step stops at "a
deterministic candidate set exists."

- **`priority-surfaces.ts`** (pure) — `PRIORITY_SURFACES` is the ordered set;
  `resolvePrioritySurfaces({termSlug})` substitutes the parameterized route's `:slug` and
  yields concrete capture surfaces in order, failing closed on an unfilled param,
  non-contiguous order, or a duplicate surface-id.
- **`candidate-set.ts`** (pure) — `assembleCandidateSet` folds the resolved surfaces
  against their rendered-and-stored artifacts into the `CandidateSet` the blessing
  surface consumes; `serializeCandidateSet` / `parseCandidateSet` are its JSON
  boundary. Each `CandidateScreen` carries its surface-id (the golden-pointer key) +
  the **exact store `sha256`** of the rendered bytes — the no-re-render
  anchor: the bless later moves the pointer to that same `sha256`, no re-render.
- **`candidate-render.ts`** (thin Effect) — `renderCandidateSet` drives the reused
  capture leg (the same flake canon `review-design` uses) + the store leg over
  the priority set. Both impure legs are injected seams, so the whole orchestration is
  unit-tested with fakes — no browser, no store.

```bash
# render the priority surfaces over a flag-forced preview into a candidate set:
STORE_TOKEN=<api key> <bin> render-candidates \
  --preview-url https://pr-123.preview.example.com \
  --term-slug amortisman \
  --out /tmp/candidates \
  --flag "golden-screens=on" \
  --emit /tmp/candidates/candidate-set.json
```

Prints the serialized candidate set on stdout (and to `--emit` if given) — the input
the blessing surface consumes. `--flag "<key>=on|off"` records the forced flag
state as provenance; this step **consumes** an already-flag-forced preview, it does not
force flags. The store's api key resolves from the bin's own token flag, then its
environment variable, then the consuming repo's token file.

## The blessing surface (`golden-gallery` + `golden-bless-set`)

The blessing surface is the **human-in-the-loop bless → commit path** on top of the
candidate set and the golden pointer. The operator takes a candidate set,
blesses/redlines it down to the small golden set (~5–8 screens), and the approved
candidates are committed as golden baselines. It renders **no** new bytes: a bless
is a **pointer move** to the exact `sha256` the operator saw in the gallery.

- **`blessing-surface.ts`** (pure) —
  - `renderBlessingGallery(set)` emits the operator-facing GitHub gallery comment:
    one section per candidate in set order, embedding the store URL at
    full resolution, plus a copy-paste **decision template** (`<surfaceId>
    approve|redline` per line) the operator marks. The placeholder ships un-defaulted, so
    a copy without editing fails loud rather than silently blessing.
  - `parseBlessDecisions(text)` reads the filled-in template (ignoring blanks, `#`
    comments, and ``` fences) into `{surfaceId, verdict}` decisions.
  - `applyBlessing({set, decisions, blessedDate, pointer})` folds the verdicts into a
    golden-pointer move: it blesses each **approved** surface to the `sha256` it carries
    **in the set** (never a decision-supplied value — the no-re-render guard is
    structural), leaves **redlined** ones out, and fails closed on an unaddressed
    candidate, an unknown surface, or a duplicate decision. A re-bless is the
    same fold over the existing pointer — an explicit committed update to the new sha,
    never a silent overwrite; a redline leaves an existing golden untouched (it is "not
    re-blessed", not "removed").

```bash
# 1. render the gallery comment from a candidate set, post it on the PR for the operator:
<bin> golden-gallery \
  --set /tmp/candidates/candidate-set.json > gallery.md

# 2. the operator copies the decision template, marks each surface approve|redline into
#    decisions.txt, then commit the blessed set into the golden pointer:
<bin> golden-bless-set \
  --set /tmp/candidates/candidate-set.json \
  --decisions decisions.txt
```

`golden-bless-set` writes `golden-pointer.json` (the `--pointer` default) — a one-line
pointer move per approved surface, reviewable in a normal diff. It is the batch analogue
of the single-surface `golden-bless`; both are pure + fs and never re-render bytes.

## The undocumented endpoint + the fallback (load-bearing)

The upload POSTs the PNG bytes to
**`uploads.github.com/user-attachments/assets`** — GitHub's **undocumented**
web-composer internal API. It works with a user token today but is a recorded
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
described self-containedly here so nothing depends on that gist surviving.

## CLI

```bash
# from the repo root
GITHUB_TOKEN=<token> <bin> capture \
  --preview-url https://pr-123.preview.example.com \
  --surface "/catalog" --surface "/catalog:empty" \
  --out /tmp/shots \
  --repo-id 1234177275
```

Prints the `CaptureRecord[]` as JSON on stdout for the `review-design` skill to
judge (`localPath`) and embed (`hostedUrl`). `$GITHUB_TOKEN` is read as a
redacted config, never passed as a flag.

The bin needs the chromium browser binary installed
(`pnpm exec playwright install chromium`, the same binary the e2e suite uses) —
the pure core and the unit tests need neither a browser nor the network.

## Tests

```bash
pnpm --filter @kampus/fabrika-cli test   # the unit tier
```

Unit-only: the pure plan/parse/resolve/merge cores and `uploadAsset` over a
stubbed transport. There is no integration tier — a real capture needs a live
preview deploy, which the `review-design` reviewer run exercises end to end.
