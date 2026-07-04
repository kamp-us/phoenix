---
id: 0044
title: imge Media Architecture — R2 Store, Pasaport-Auth Uploads, One Surface
status: superseded by [0144](0144-depo-internal-asset-cdn.md)
date: 2026-06-13
tags: [imge, storage, auth, infra]
---

# 0044 — imge Media Architecture — R2 Store, Pasaport-Auth Uploads, One Surface

Superseded by [0144](0144-depo-internal-asset-cdn.md) — the imgur-style scope was brutally narrowed to **depo**, a decoupled internal asset CDN (own `infra/` stack, `depo.kamp.us` public-read, doorman upload worker, standalone CLI). The R2-store + pasaport-`apiKey`-auth spine below survives; the public-product scope (frontend, gallery, user uploads, video, full safety envelope) is rejected.

## Context

New product **imge** (epic [#102](https://github.com/kamp-us/phoenix/issues/102)): an
imgur-style image/video host. The originating need is concrete — agents filing
screenshot-driven `report`s have nowhere to host images so they render inside GitHub
issues, and pano/sözlük markdown has no host to point image syntax at.

Constraints found on `main`:

- **No object-storage binding exists.** No R2 / Cloudflare Images / Stream in
  `apps/web/alchemy.run.ts`; no upload / multipart / blob handling under
  `apps/web/worker/`. This is net-new infrastructure.
- **Bindings are declared through the worker, not the stack.** `alchemy.run.ts` only
  yields the `Phoenix` worker Tag; the worker's init wiring tells alchemy what to
  provision (ADRs 0026–0031, 0028). The `LiveDO` namespace is bound in `worker/index.ts`
  init; for D1 the `.bind(PhoenixDb)` call lives in `DatabaseLive` (`worker/db/Database.ts`)
  off a Resource in `worker/db/resources.ts`, which `index.ts` consumes via the `Database`
  seam — the bind is not literally in `index.ts`. An R2 bucket follows the same
  pattern: alchemy ships `Cloudflare.R2Bucket` with a `.bind()` mirroring D1's, plus
  native custom-domain and streaming-`put` support.
- **Auth: a real user identity today, but only a *session* bearer for browsers.**
  pasaport runs better-auth with the `bearer` plugin
  (`worker/features/pasaport/better-auth-live.ts:134`); the SPA authenticates with
  `Authorization: Bearer <token>`. Caveat — better-auth's `bearer()` does not mint a
  separate credential: the bearer token *is* the session token, it expires (~7-day
  default, no `session.expiresIn` override), and it's harvested from a browser login. So
  it is **not** an agent credential — an unattended `report` agent has no browser session
  to derive one. The pasaport `user` (`user_profile` row) is the real, built identity;
  durable agent credentials use the better-auth `apiKey` plugin, whose table is already
  migrated (`apiKey` in the D1 baseline); the plugin ships as a separate scoped package
  (`@better-auth/api-key`), so enabling it is a dependency add, not a better-auth bump
  (Decision 3, and the bullet below).
- **künye does not exist yet.** The reputation/identity layer — the Künye DO, invite
  gates, karma-gated privileges, and *agent registration* — is an unbuilt design epic
  ([#41](https://github.com/kamp-us/phoenix/issues/41)). Only the karma *number* exists
  today (a `total_karma` column in pasaport, D1-direct per ADR 0009). So imge must **not**
  take a hard dependency on künye; it authenticates against the pasaport user that exists
  now, and künye-based gating is a future overlay (see Decision 3).
- **The `apiKey` *table* is migrated; the plugin is a separate package to install.** The
  `apiKey` table is in the D1 baseline and matches the apiKey-plugin schema. The plugin is
  **not** in the `better-auth/plugins` barrel (only `bearer`, `magicLink`, `jwt`, `mcp`, …
  are) — it ships as its own scoped package **`@better-auth/api-key`**, versioned in lockstep
  with the better-auth family. An exact **`@better-auth/api-key@1.6.10`** exists whose
  peer-deps (`better-auth ^1.6.10`, `@better-auth/core ^1.6.10`) match our current pins, with
  a `./client` subpath for the SPA. So enabling agent credentials is a **dependency add +
  register** at our current version — no better-auth bump — verified against the alchemy
  better-auth integration per the dependency policy (ADR
  [0038](0038-dependency-patches-local-only.md)). (See Decision 3.)
- **Ethos:** "never build what you can install" — back the host with Cloudflare
  primitives, not custom blob storage.

Three coupled forks triggered this ADR — (1) which primitive stores media, (2) how
non-browser agents authenticate, (3) shared vs separate upload surface — and the design
surfaced a fourth that must ship with them: the **safety envelope** (served-content
security + abuse limits + a stable URL contract) an authenticated public-write media host
cannot defer. All are settled below before `plan-epic` splits #102.

## Decision

1. **R2 is the system of record for all imge objects** — images now, video later —
   one storage substrate with S3 semantics, free egress, and full control over keys and
   public URLs. The R2 bucket is a worker binding (the `Cloudflare.R2Bucket.bind`
   pattern, mirroring D1), provisioned by alchemy. Bytes live in R2; per-object metadata
   (owner pasaport user id, content type, byte size, dimensions, created-at) lives in the
   existing D1 via Drizzle. Object keys are **opaque and non-enumerable** (content-hash or
   random id, never sequential) — see Decision 5.

2. **Cloudflare Images is a transform layer over R2 origins, not the store; Stream
   (video) is deferred.** Variants/optimization come from Cloudflare Images
   *transformations* over R2-origin URLs (the documented transform-from-R2 path), layered
   when needed. We reject Cloudflare-Images-**as-system-of-record** deliberately: Images
   gives direct-creator-upload, built-in variants, and signed delivery URLs (real
   conveniences), but it is image-only and priced per stored image + per delivery, so it
   loses on the axes we weight most — one substrate for video-later, predictable storage
   cost, and owning our own URL scheme. R2-as-record + Images-as-transform keeps those and
   still buys the optimization. Cloudflare **Stream** backs video as a deferred child;
   v1 ships images.

3. **Identity is the pasaport user; browsers use the session bearer, non-browser agents
   use the `apiKey` plugin — added as a dependency in v1.** The upload endpoint
   authenticates whatever better-auth resolves and keys the object to the resolved pasaport
   user id — *not* künye. Browsers present the existing session bearer. **Agents authenticate
   via better-auth's `apiKey` plugin.** The `apiKey` *table* is already migrated and matches
   the plugin's schema; the plugin ships as the scoped package **`@better-auth/api-key`**
   (with a `./client` for the SPA), and **`@better-auth/api-key@1.6.10` peer-matches our
   current `better-auth`/`@better-auth/core@1.6.10` pins** — so v1 **adds that dependency to
   the catalog and registers `apiKey()` in pasaport's plugins array** (beside `bearer()` /
   `magicLink()` in `better-auth-live.ts:89`), no better-auth bump. **Verified:** pasaport
   builds better-auth directly (`makeBetterAuth({…, plugins:[…]})`) and the
   `@alchemy.run/better-auth` wrapper is only the Effect service Tag (`auth: Effect<Auth<any>>`)
   — it never references plugins, so `apiKey()` drops straight into the existing array with no
   wrapper passthrough involved. The plugin is the right primitive: a
   durable, revocable credential an unattended `report` agent can actually hold, unlike the
   ~7-day browser session token, and no bespoke token scheme. **Threat model — borrowed identity, v1:** because künye does not
   exist, an agent borrows a human's pasaport user, and the quota (Decision 6) is per-user — so
   one shared `apiKey` means one quota, one blast radius, and all-or-nothing revocation for that
   human. The plugin supports many keys per user, so v1 should issue **one `apiKey` per agent
   instance**, giving per-agent revocation and rate-limiting granularity even before künye.
   *How* an agent obtains and presents that `apiKey` is specified in ADR
   [0045](0045-kampus-client-cli.md): the `kampus` client CLI's `kampus auth` issues and
   stores the credential, and `kampus imge upload` consumes it. **künye gating is a deferred
   overlay, not a v1 dependency:** once
   künye lands ([#41](https://github.com/kamp-us/phoenix/issues/41)) it can layer
   reputation/agent gates *on top* (e.g. only registered agents above N karma may upload),
   but imge v1 ships against the bare pasaport user.

4. **One upload surface for both callers, with a v1 size cap.** A single authenticated
   endpoint (a fate mutation or `POST /api/imge/*`) accepts media, validates it
   (Decision 6), writes to R2, records metadata in D1, and returns the stable public URL
   (Decision 5). The surface is never forked by caller type. v1 **proxies bytes through
   the worker** to the R2 binding, streaming `put` with `contentLength`; this is sound for
   images under the Cloudflare Workers request-body limit (**100 MB on Free/Pro**), which
   also sets the **v1 max upload size** (cap set well below the platform limit).
   Presigned direct-to-R2 upload is the upgrade path for large media and video — and is
   **non-trivial** (it needs S3-API signing credentials the worker does not hold today),
   not a config toggle.

   **v1 sequencing (both halves stay v1, built incrementally):** v1 splits into a
   **pre-public internal slice** then a **public-delivery gate**. The internal slice —
   add `@better-auth/api-key` + register the plugin + upload-through-worker + R2 + D1 metadata,
   gated to a private/allowlisted delivery path (or the existing authed origin) — proves the agent loop
   end-to-end. The **public-delivery gate** then ships before *any* public read: the cookieless
   delivery domain + content-type sniffing + SVG defang + per-user rate/size/storage quotas
   (Decisions 5–6). Every security requirement in Decisions 5–6 stays mandatory for v1; this
   only orders them so v1 is buildable in two steps.

5. **Stable, opaque public delivery is a v1 decision, not an implementation detail.** A
   media host's contract is that URLs never break. v1 fixes: (a) the public-read surface —
   a **dedicated delivery domain** (cookieless, see Decision 6), not ad-hoc `r2.dev`;
   (b) an **opaque, non-enumerable key/URL scheme** (content-hash or random id) so URLs are
   stable, unguessable, and don't leak a public/unlisted distinction; (c) the embedding
   contract — the returned URL renders directly as `![](url)` through GitHub's camo proxy
   and in pano/sözlük markdown. Content-hash keys also give free dedup + idempotent agent
   retries. **Because "URLs never break" is a v1 contract, the policy for what happens to an
   embedded image when its uploader (or their `apiKey`) is deleted is a v1 decision point — not
   deferrable** (e.g. embedded URLs survive uploader/key deletion vs. break with it). General
   deletion/GC of the rest of the object lifecycle stays specify-before-build (Consequences).

6. **The served-content safety envelope ships in v1.** Hosting arbitrary bytes on our own
   origin is the classic image-host footgun, and the upload credential is user-scoped while
   the output is public — so these are load-bearing, not deferrable:
   - **Content type by sniffing, allowlisted** — determine type from the actual bytes and
     allowlist image types; never trust the client's declared type.
   - **Neutralize active content** — serve with `X-Content-Type-Options: nosniff` and
     appropriate `Content-Disposition`, from a **cookieless delivery domain** isolated from
     the better-auth cookie origin; **reject or defang SVG** (serve as attachment /
     `text/plain`, or sanitize) since inline-script SVG executes in-origin.
   - **Per-user rate + storage quotas + a size cap** at the upload endpoint (a
     content-length check + a D1 count-per-window — cheap; the metadata table already
     supports it). Without these, one leaked credential is unbounded public-CDN write on our
     R2 bill and domain reputation.
   - **Strip EXIF / embedded metadata on ingest** *(added by the 2026-06-13 amendment —
     see Amendments below)* — remove EXIF and other embedded metadata (GPS, camera,
     timestamps) before storing, so the served object is pixels only. Compute the
     content-hash key on the **post-strip** bytes and **preserve visual orientation**.
     Screenshots carry none, but a real photo leaks its capture location to a public,
     permanent URL.

   Human *content* moderation (takedown review of lawful-but-unwanted media) stays
   deferred — it is distinct from these mechanical limits.

7. **imge is a feature module** `apps/web/worker/features/imge/` (ADR 0036) with a
   frontend product + route in `apps/web/src/App.tsx`.

## Consequences

- **Easier:** one media substrate for all current and future media; agent uploads ride a
  durable better-auth `apiKey` credential + the pasaport user (no dependency on the unbuilt
  künye); pano/sözlük markdown finally has a host to point image syntax at;
  content-hash keys give free dedup + idempotent retries.
- **Joint acceptance with 0045 — the originating use case is NOT closed by imge alone.** imge
  v1 enables a credential no agent can *use* without ADR [0045](0045-kampus-client-cli.md)'s
  issuance (a token in env → `kampus imge upload` → stable URL → embed in markdown). The claim
  "imge v1 closes the originating use case" is **false** until 0045's PAT path also ships; the
  end-to-end agent path is a **joint acceptance criterion across both epics**. The minimum
  joint slice: `@better-auth/api-key` added + `apiKey()` registered + create-apiKey reachable +
  `kampus`'s token-read + upload path.
- **New cost, owned in v1:** **adding the `@better-auth/api-key` dependency (`@1.6.10`,
  peer-matches our pins) + registering `apiKey()` in pasaport** (small — table already migrated,
  and verified that pasaport builds better-auth directly so the plugin drops into its existing
  array with no `@alchemy.run/better-auth` wrapper passthrough); the first object-storage binding (R2
  provisioning + a dedicated cookieless delivery domain + object lifecycle); a per-object
  metadata schema in D1; content-type sniffing + size/rate/quota enforcement on the upload path.
- **Banned:** custom blob storage; a separate agent-only auth system; forking the upload
  surface by caller type; making Cloudflare Images the system of record; trusting
  client-declared content types; sequential/enumerable object keys; serving user content
  from the cookie-bearing origin.
- **Deferred to later children:** the Cloudflare Images transformation layer; the
  Cloudflare Stream video pipeline; presigned direct-upload; **human content moderation**
  (takedown review — distinct from the v1 mechanical limits); künye-based gating
  (reputation/agent overlay, pending #41).
- **Still to specify before build (not blocking ratification):** object **deletion / GC**
  and D1↔R2 orphan consistency (who can delete) — *except* the uploader-deletion→embedded-URL
  policy, which is a v1 decision per Decision 5; and **CORS** on the upload + delivery surfaces.
  (**EXIF/GPS stripping** was listed here originally; the 2026-06-13 amendment pulled it into
  v1 — see Decision 6 and Amendments.)
- **Status `accepted`:** the forks are ratified — R2-as-record · Images-as-transform ·
  pasaport-user identity with `apiKey` for agents · one surface (proxy-through-worker,
  capped) · opaque stable delivery · the v1 security/limits envelope. Next: `plan-epic`
  splits #102 into children.

## Amendments

- **2026-06-13 — EXIF/GPS stripping pulled into v1.** Originally listed under Consequences →
  "Still to specify before build" as deferred (rationale: low-risk for screenshots, a privacy
  leak only for phone photos later). Moved into the Decision 6 served-content safety envelope
  and scheduled in the upload-hardening child
  [#110](https://github.com/kamp-us/phoenix/issues/110). **Why the call changed:** the served
  URLs are public and permanent ("URLs never break", Decision 5), so an un-stripped phone
  photo's GPS/location leak would itself be public and un-retractable; stripping metadata we
  never need is a cheap ingest-path addition now and an expensive retrofit once URLs are live.
  The original screenshots-first reasoning still holds — it simply stopped outweighing the
  asymmetric, irreversible downside. Implementation notes (hash the post-strip bytes; preserve
  orientation) live in #110. Decided during `plan-epic` of #102.
