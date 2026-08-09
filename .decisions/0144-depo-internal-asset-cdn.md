---
id: 0144
title: depo — kampus internal asset store/CDN (own `infra/` stack, R2 public-read `depo.kamp.us`, doorman upload worker, standalone CLI) — supersedes 0044's imge
status: accepted
date: 2026-07-04
tags: [depo, storage, infra, cdn]
---

# 0144 — depo — kampus internal asset store/CDN

## Context

Supersedes [0044](0044-imge-media-architecture.md). ADR 0044 designed **imge** as an *imgur-style image/video host* — a public product with a frontend, gallery, user uploads, video, and a full upload-safety envelope (epic [#102](https://github.com/kamp-us/phoenix/issues/102), plus [#110](https://github.com/kamp-us/phoenix/issues/110)/[#112](https://github.com/kamp-us/phoenix/issues/112)). That scope was never built, and it is far larger than the real need.

The real need is narrow and internal: **agents uploading Playwright screenshots so they render inside GitHub PR descriptions** (and, later, pano/sözlük markdown images — 0044's originating need). That is not a public product; it is a **decoupled internal infrastructure primitive** — a CDN. A CDN's change cadence is unrelated to product releases, so it must not share the `apps/web` worker's deploy fate the way an app-coupled concern (e.g. pasaport's request-path auth) does.

This ADR brutally narrows imge → **depo** (Turkish "depot/warehouse") and records the internal-CDN design.

## Decision

**depo is kampus's internal asset store / CDN** — a platform primitive, not a product, never user-facing. Internal callers only (agents + kampus systems). Six load-bearing decisions:

1. **R2-backed.** Cloudflare R2 object store (net-new infra; no R2 binding exists today).
2. **Its own `infra/depo` alchemy stack, its own deploy cycle** — *not* a route on `apps/web`, *not* an `apps/` worker. Follows the `infra/ci-credentials` standalone-stack precedent (ADR [0057](0057-multi-app-multi-worker-repo.md)). The service is decoupled, so its deployment is too.
3. **Reads: R2 public-read custom domain `depo.kamp.us`, zero compute** — objects served straight off R2, no worker in the read path. Embedded URLs are `https://depo.kamp.us/<sha256>.<ext>`.
4. **Writes: a thin "doorman" upload worker** — auth via a pasaport `apiKey` (0044's already-designed agent-credential path); **content-addressed write-once** PUT (key = `<sha256>.<ext>`, refuse overwrite → URLs are immutable); content-type allowlist (PNG/JPEG/WebP) + size cap (~10 MB). The R2 *write* capability lives behind a Cloudflare binding (not a portable, leakable secret).
5. **Client: a standalone `depo` CLI** (`packages/depo` — a thin client lib + a `depo` bin over it). `depo put <file>` → prints the URL. **Not** a `pipeline-cli` subcommand: depo is general infra decoupled from any one consumer, so a non-pipeline caller must not have to pull in the pipeline tool. Server-side products later `import` the lib (no CLI).
6. **Retention: permanent, never-delete, immutable.** Content-addressed write-once. PR-description URLs live forever; a 404 would break old PRs. Assets are KB–MB, so unbounded retention is trivially cheap.

**Dumb by mandate.** depo earns its own stack *because* it is near-zero logic. Transforms, resize-on-the-fly, a gallery, request-processing — that logic is the imgur trap this ADR rejects. The doorman is an auth+guard+write-once seam, not a feature surface. It does not grow.

**Public-read is forced, and bounds what depo may hold.** Anything embeddable in a GitHub PR/issue **must** be public-read: GitHub's Camo image proxy fetches the URL anonymously and cannot authenticate to a private CDN. So `depo.kamp.us/<sha256>.<ext>` is **capability-URL security** — unguessable, but readable by anyone holding the URL (exactly how GitHub's own `user-attachments` works). Hard constraint: **depo, for the GitHub-embed path, must never hold read-sensitive assets.**

## Consequences

- **imge's imgur scope is rejected.** Cut: public frontend/gallery, user uploads, video, the full upload-safety envelope (agents feed trusted PNGs, not hostile user uploads — so sniffing/SVG-defang/EXIF-strip evaporate). Old issues #102/#110/#112 are superseded — routed to triage for disposition (not auto-closed; they are human-filed).
- **The producer is a separate epic.** depo is only the *sink*. The Playwright step that captures UI screenshots on UI-affecting PRs and embeds them via `depo put` is a distinct new **`review-ui`** skill, filed as its own epic. Keeping them separate preserves depo's decoupling: depo does not know its consumers.
- **New infra surface:** an `infra/depo` stack (R2 bucket + `depo.kamp.us` custom domain + DNS), the doorman upload worker, and a `packages/depo` client+CLI enter the repo. The build is filed as its own issue.
- **Auth wiring:** how an agent obtains/holds its pasaport `apiKey` is a build detail (0044 already established the `@better-auth/api-key` path); depo reuses it, coining no new credential class.

## Vocabulary impact

Renames **imge → depo**. **depo** = kampus's internal asset store / CDN (R2-backed, `depo.kamp.us`, internal callers only, capability-URL public reads). The glossary `imge` row (`.glossary/TERMS.md`) and the architecture-vocab line (`.glossary/LANGUAGE.md`) are updated to `depo` in this PR (short, unambiguous rename — inlined per the adr skill's vocabulary step rather than deferred).
