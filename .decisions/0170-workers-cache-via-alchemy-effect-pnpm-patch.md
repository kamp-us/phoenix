---
id: 0170
title: "Workers Caching enablement via an alchemy `pnpm patch` (the ADR 0038 idiom) — the cache knob is declared in `alchemy.run.ts` like every other worker setting; zone-level Cache Rules + a standing purge token are rejected"
status: accepted
date: 2026-07-07
tags: [infra, alchemy, cache, pano]
---

# 0170 — Workers Caching via an alchemy `pnpm patch`

## Context

Epic [#2316](https://github.com/kamp-us/phoenix/issues/2316) (instant /pano reload) leg B
introduces an edge-cached, viewer-invariant GET base-feed projection: the worker serves the
base feed with `Cache-Control` + `Cache-Tag: pano-feed`, and the existing fanned-mutation
seam (ADR [0155](0155-fanned-mutation-publish-guard.md)) purges the tag after a write
(child issue [#2324](https://github.com/kamp-us/phoenix/issues/2324)).

The platform lever is **Workers Caching**: a per-Worker edge cache, enabled by a per-Worker
setting, controlled entirely by the worker's own response headers and runtime purge calls
([docs](https://developers.cloudflare.com/workers/cache/)):

- **Enablement is per-Worker config**, not zone config — wrangler exposes it as the
  `cache.enabled` block
  ([configuration docs](https://developers.cloudflare.com/workers/cache/configuration/));
  on the API it is the `cache_options: {enabled, cross_version_cache}` field of the script
  upload metadata (`PUT /accounts/{account_id}/workers/scripts/{script_name}`, Cloudflare
  OpenAPI spec).
- **Only `GET`/`HEAD` responses are cached** — every other method always invokes the worker
  ([limitations docs](https://developers.cloudflare.com/workers/cache/limitations/)), which
  is exactly the viewer-invariant GET-projection shape #2324 needs.
- **Purge is a runtime capability of the worker itself** — `ctx.cache.purge({tags: [...]})`
  (or `cache.purge` imported from `cloudflare:workers`), scoped to the worker/entrypoint
  that owns the cache; **no zone-level purge affects it and no API token is involved**
  ([purge docs](https://developers.cloudflare.com/workers/cache/purge/)).

Phoenix deploys via alchemy, not wrangler (ADR
[0026](0026-adopt-alchemy-effect-infra.md); there is no `wrangler.jsonc`), and the pinned
alchemy does not expose the knob:

- `alchemy@2.0.0-beta.59 — src/Cloudflare/Workers/Worker.ts`: `WorkerProps` carries
  `logpush` / `observability` / `placement` (lines 199/209/229), each typed off
  `workers.PutScriptRequest["metadata"]` — **no cache property exists**.
- `alchemy@2.0.0-beta.59 — src/Cloudflare/Workers/WorkerProvider.ts`: the deploy builds the
  script-upload metadata literal (`const metadata: workers.PutScriptRequest["metadata"]`,
  line 941) mapping those props to the API — **no `cache_options` is sent**.
- The API client type it maps through, `@distilled.cloud/cloudflare@0.27.0 —
  src/services/workers.ts` `PutScriptRequest["metadata"]`, also predates the field (zero
  cache-related members).

So enabling Workers Caching needs an infrastructure lever, and there was a genuine fork:
patch the dependency so the knob lives in the stack file, or configure zone-level Cache
Rules outside the stack plus a standing API purge token for `Cache-Tag` purges.

## Decision

**Enable Workers Caching through a local `pnpm patch` to the alchemy dependency — the ADR
[0038](0038-dependency-patches-local-only.md) idiom — exposing the enablement knob on the
Worker resource, so cache enablement is declared in `apps/web/alchemy.run.ts` like every
other binding/setting.** Zone-level Cache Rules + a standing purge credential are rejected.

The founder rationale, in full:

- **IaC-owned.** The stack file is the single source of infra truth; the cache knob joins
  `observability`/`placement` as a declared worker setting instead of drifting in a zone
  dashboard.
- **Stage/preview-uniform.** Every `alchemy deploy --stage <name>` (ADR
  [0057](0057-multi-app-multi-worker-repo.md)) gets identical cache behavior automatically;
  zone rules are global and cannot follow per-stage workers.
- **No standing purge credential.** Purge happens from the worker's own runtime capability
  (`ctx.cache.purge({tags})`), honoring the prod-cred-free invariant — no agent or CI holds
  a zone purge token.
- **The patch is a committed first-class artifact.** Versioned, reviewed, reproduced by
  `pnpm install` — per ADR [0038](0038-dependency-patches-local-only.md).

The patch's insertion points, identified against the pinned source: add a `cache` prop to
`WorkerProps` (`alchemy@2.0.0-beta.59 — src/Cloudflare/Workers/Worker.ts`, alongside
`observability`/`placement`) and thread it into the upload-metadata build
(`src/Cloudflare/Workers/WorkerProvider.ts` line 941) as the API's `cache_options` field;
the `@distilled.cloud/cloudflare@0.27.0` `PutScriptRequest` schema gains the field in the
same committed patch set (both deps already resolve via `catalog:`, and alchemy already
carries an in-repo patch, so this extends existing patch files rather than introducing a
new mechanism).

## Alternatives considered

- **Zone-level Cache Rules + a standing API purge token (rejected).** Configures caching
  outside the stack (breaking IaC ownership and the deletion test — destroying a stage
  would leave its cache rules behind), applies zone-globally so preview stages either share
  prod cache behavior or silently diverge from it, and requires a long-lived zone purge
  credential for `Cache-Tag` purges — a standing secret the runtime-purge path simply does
  not need.

## Consequences

- **This ADR gates [#2324](https://github.com/kamp-us/phoenix/issues/2324)** — the
  edge-cache child of epic [#2316](https://github.com/kamp-us/phoenix/issues/2316) is
  unblocked once this lands.
- **The alchemy change lands ONLY as an in-repo `pnpm patch` committed to the repo.** The
  upstream alchemy-effect repository is a read-only grounding source — never a fork to PR
  against, consume, or track (ADR [0038](0038-dependency-patches-local-only.md)).
- **The cached projection must stay viewer-invariant GET.** Workers Caching caches
  `GET`/`HEAD` only and serves one entry to every caller on a hit; anything
  viewer-dependent stays out of the cached route.
- **Purge rides the fanned-mutation seam.** The write path that invalidates `/fate/live`
  (ADR [0155](0155-fanned-mutation-publish-guard.md)) is where the `Cache-Tag: pano-feed`
  purge call belongs — one seam, two invalidations.
- A future alchemy release that ships the knob natively retires the patch hunk (the
  standard ADR 0038 patch lifecycle); the `alchemy.run.ts` declaration is unchanged by
  that swap.

## Vocabulary impact

None. "Workers Caching", `Cache-Tag`, and `cache_options` are Cloudflare platform nouns
used as documented, and the fanned-mutation seam is already named by ADR
[0155](0155-fanned-mutation-publish-guard.md); this ADR coins and redefines nothing —
recorded explicitly per the `/adr` vocabulary-impact step.

## Relationship to prior decisions

- **ADR [0038](0038-dependency-patches-local-only.md)** — dependency behavior changes land
  as committed local `pnpm patch`es; this is a direct instance.
- **ADR [0026](0026-adopt-alchemy-effect-infra.md)** — alchemy-managed deploys with
  `alchemy.run.ts` as the stack; why the knob must surface there and not in a
  `wrangler.jsonc`.
- **ADR [0057](0057-multi-app-multi-worker-repo.md)** — per-app stacks + per-stage
  isolation; the stage-uniformity argument rests on it.
- **ADR [0155](0155-fanned-mutation-publish-guard.md)** — the fanned-mutation seam the
  `Cache-Tag` purge attaches to in [#2324](https://github.com/kamp-us/phoenix/issues/2324).
