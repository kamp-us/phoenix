---
id: 0044
title: imge Media Architecture — R2 Store, Pasaport-Bearer Uploads, One Surface
status: proposed
date: 2026-06-13
tags: [imge, storage, auth, infra]
---

# 0044 — imge Media Architecture — R2 Store, Pasaport-Bearer Uploads, One Surface

## Context

New product **imge** (epic [#102](https://github.com/kamp-us/phoenix/issues/102)): an
imgur-style image/video host. The originating need is concrete — agents filing
screenshot-driven `report`s have nowhere to host images so they render inside GitHub
issues, and pano/sözlük markdown has no host to point image syntax at.

Constraints found on `main`:

- **No object-storage binding exists.** No R2 / Cloudflare Images / Stream in
  `apps/web/alchemy.run.ts`; no upload / multipart / blob handling under
  `apps/web/worker/`. This is net-new infrastructure.
- **Bindings are declared in the worker's init phase**, not the stack. `alchemy.run.ts`
  only yields the `Phoenix` worker Tag; the worker's `bind()` calls in
  `worker/index.ts` (where D1 and the `LiveDO` namespace already live) tell alchemy
  what to provision (ADRs 0026–0031, 0028). An R2 bucket is added there.
- **Auth already issues bearer tokens.** pasaport runs better-auth with the `bearer`
  plugin enabled (`worker/features/pasaport/better-auth-live.ts:134`); the SPA itself
  authenticates with `Authorization: Bearer <token>`. The pasaport `user` (the
  `user_profile` row) is the real, built identity available today.
- **künye does not exist yet.** The reputation/identity layer — the Künye DO, invite
  gates, karma-gated privileges, and *agent registration* — is an unbuilt design epic
  ([#41](https://github.com/kamp-us/phoenix/issues/41)). Only the karma *number* exists
  today (a `total_karma` column in pasaport, D1-direct per ADR 0009). So imge must **not**
  take a hard dependency on künye; it authenticates against the pasaport user that exists
  now, and künye-based gating is a future overlay (see Decision 3).
- **Ethos:** "never build what you can install" — back the host with Cloudflare
  primitives, not custom blob storage.

Three coupled forks must be settled before `plan-epic` can split #102: (1) which
primitive stores media, (2) how non-browser agents authenticate, (3) shared vs
separate upload surface for agents and browsers.

## Decision

1. **R2 is the system of record for all imge objects** — images now, video later —
   one storage substrate with S3 semantics, free egress, and full control of keys and
   public URLs. The R2 bucket is a worker binding declared in the init phase of
   `worker/index.ts` (alongside D1 / `LiveDO`), provisioned by alchemy. R2 holds bytes;
   per-object metadata (owner pasaport user id, content type, dimensions, created-at) is
   rows in the existing D1 via Drizzle.

2. **Image variants/optimization come from Cloudflare Images *transformations* over R2
   origins** (the documented transform-from-R2 path), layered only when needed —
   Cloudflare Images is **not** the system of record. **Cloudflare Stream (video) is a
   deferred child, not v1**; v1 ships images.

3. **Agents and browsers authenticate the same way: a better-auth token tied to the
   pasaport `user` that exists today** — *not* künye. Reuse the existing `bearer`
   plugin — an upload carries whatever better-auth resolves (a browser cookie/session,
   or `Authorization: Bearer <token>` for an agent), and identity is the resolved
   pasaport user id. No bespoke API-key scheme. If agents need long-lived, non-expiring
   credentials beyond session bearer tokens, add better-auth's `apiKey` plugin (an
   install), never a custom token system.

   **künye gating is a deferred overlay, not a v1 dependency.** Once künye lands
   ([#41](https://github.com/kamp-us/phoenix/issues/41)), it can layer reputation/agent
   gates *on top* of imge uploads (e.g. only registered agents above N karma may upload,
   per-user quotas by karma) — but imge v1 ships against the bare pasaport user and must
   not block on the künye design epic. This keeps the originating use case (agents
   hosting screenshot evidence) shippable now.

4. **One upload surface for both callers.** A single authenticated upload endpoint
   (a fate mutation or `POST /api/imge/*` route) accepts media, writes to R2, records
   metadata in D1, and returns a **stable public URL** usable directly as `![](url)` in
   GitHub / pano / sözlük markdown. The surface is never forked by caller type; identity
   is the resolved pasaport user. v1 proxies bytes through the worker to the R2 binding (within
   the worker request-body limit — fine for image sizes); **presigned direct-to-R2
   upload is the documented upgrade path** for large media and video.

5. **imge is a feature module** `apps/web/worker/features/imge/` (ADR 0036) with a
   frontend product + route in `apps/web/src/App.tsx`. Public delivery is via a custom
   domain or bound public bucket on R2 (exact mechanism settled in implementation).

## Consequences

- **Easier:** one media substrate for all current and future media; agent uploads come
  "for free" off the existing better-auth bearer + pasaport user (no dependency on the
  unbuilt künye), so the originating use case closes (the `report`/`triage` skills can
  gain an upload-and-embed step); pano/sözlük markdown finally has a host to point image
  syntax at.
- **New cost:** the first object-storage binding in the stack (R2 provisioning, a
  public-delivery domain, object lifecycle); a per-object metadata schema in D1;
  moderation + rate/size limits become a real owned surface.
- **Banned:** custom blob storage; a separate agent-only auth system; forking the upload
  surface by caller type; making Cloudflare Images the system of record.
- **Deferred to later children:** the Cloudflare Images transformation layer; the
  Cloudflare Stream video pipeline; presigned direct-upload; moderation/abuse limits;
  künye-based upload gating (reputation/agent-registration overlay, pending #41).
- **Status `proposed`:** ratify forks 1–4 (R2-as-record · bearer/pasaport-user agent
  auth · one surface · proxy-through-worker for v1) before `plan-epic` splits #102. Flip
  to `accepted` on ratification.
