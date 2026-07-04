# @kampus/depo-infra

The **depo** infra package — a standalone alchemy home for
[depo](../../.glossary/TERMS.md)'s object store, its public read seam, and its
write path. It holds two separate alchemy stacks:

- **`depo.ts`** — the read path: the R2 bucket + the public-read `depo.kamp.us`
  custom domain (zero compute).
- **`doorman.ts`** — the write path: the pasaport-authed, write-once **doorman**
  upload worker (`worker/`), deployed on its own cycle at `up.depo.kamp.us`.

`depo` is kampus's internal asset store / CDN: R2-backed, content-addressed
write-once, public-read at `depo.kamp.us`, dumb by mandate (ADR
[0144](../../.decisions/0144-depo-internal-asset-cdn.md)). Objects are served
straight off R2 with **zero compute**; embedded URLs are
`https://depo.kamp.us/<sha256>.<ext>`.

## Why its own stack

depo is decoupled infra, not a product surface: a CDN's change cadence is unrelated
to product releases, so it must not share the `apps/web` worker's deploy fate (ADR
0144 decision 2). It follows the `infra/ci-credentials` standalone-stack precedent
(ADR [0057](../../.decisions/0057-multi-app-multi-worker-repo.md)) — its own
`package.json`, its own alchemy stack (`depo.ts`), and its own scripted deploy — and
reuses the account-global alchemy state store + the CI Cloudflare secrets, with no
second bootstrap.

## What this stack provisions

- **An R2 bucket** (`name: "depo"`) — net-new infra; there was no R2 binding in the
  repo before depo.
- **The public-read custom domain `depo.kamp.us`** bound straight to the bucket. The
  domain is attached with public access enabled, so an anonymous `GET` of any object
  key resolves off R2 without a worker. The zone (`kamp.us`) is inferred from the
  hostname.

There is **no read-path compute** — the read stack is just the bucket + domain. The
write path is the separate `doorman.ts` stack (below); the `depo` CLI is a separate
slice of epic #1965.

## The doorman write path (`doorman.ts` + `worker/`)

The **doorman** is the only way to write into depo (ADR 0144 decision 4) — a thin
alchemy-effect worker on its **own stack**, deployed separately from the read path and
from `apps/web`. **Dumb by mandate:** it authenticates, guards, content-addresses,
writes once, and returns the URL. No transforms, no gallery, no read compute — that is
the imgur trap ADR 0144 rejects.

The single surface is `PUT /` on `up.depo.kamp.us`: raw image bytes in, a `{key,url}`
JSON out. Four rules, all enforced as **domain objects** (`worker/domain.ts` +
`worker/upload.ts`), in this order:

1. **Auth** — the caller presents a pasaport better-auth `apiKey` (ADRs 0044/0045) as
   an `Authorization: Bearer <key>` or `x-api-key` header. The doorman verifies it
   against the same `apiKey` table pasaport owns, on the shared `phoenix_db` D1
   (adopted read-only), delegating to the `@better-auth/api-key` plugin's own
   `verifyApiKey` (`worker/verifier.ts`) — it never re-derives the key hash. A
   missing/invalid/disabled key → **401**, and nothing is written.
2. **Content-type allowlist** — PNG / JPEG / WebP only; anything else → **415**.
3. **Size cap** — bodies over ~10 MB → **413**.
4. **Content-addressed write-once** — the object key is `<sha256>.<ext>` computed from
   the body, so identical bytes always map to one immutable URL. An existing key of
   the same content is a benign idempotent re-PUT (**200**); a differing body under an
   existing address is refused (**409**) rather than overwritten.

On success the worker PUTs to the `depo` R2 bucket and returns
`https://depo.kamp.us/<sha256>.<ext>` (**201** on first write). The domain rules and
both seams (auth, storage) are unit-tested with no live D1 / R2
(`worker/*.unit.test.ts`, `pnpm --filter @kampus/depo-infra test`); the end-to-end
auth+storage happy path is exercised at deploy time against the real stack.

## Public-read is forced, and bounds what depo may hold

Anything embeddable in a GitHub PR/issue **must** be public-read: GitHub's Camo image
proxy fetches the URL anonymously and cannot authenticate to a private CDN. So
`depo.kamp.us/<sha256>.<ext>` is **capability-URL security** — unguessable (the sha256
key), but readable by anyone holding the URL. Hard constraint (ADR 0144): depo, for
the GitHub-embed path, must **never** hold read-sensitive assets.

## Deploy

A scripted/manual deploy under a profile with Cloudflare deploy credentials — **not**
part of the `apps/` CI deploy matrix (that roster is hardcoded to `web` in
`deploy.yml`; wiring depo into CI deploy automation touches `.github/**` and is a
separate control-plane follow-up). It reuses the same Cloudflare/alchemy env the CI
secrets carry:

```bash
# Read path — the bucket + depo.kamp.us domain
CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> ALCHEMY_PASSWORD=<pw> \
  pnpm --filter @kampus/depo-infra deploy:depo

# Write path — the doorman worker at up.depo.kamp.us. Deploy AFTER the read path
# (the doorman writes into the `depo` bucket). `BETTER_AUTH_SECRET` must match
# pasaport's so the shared apiKey store verifies.
CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> ALCHEMY_PASSWORD=<pw> \
  BETTER_AUTH_SECRET=<pasaport-secret> \
  pnpm --filter @kampus/depo-infra deploy:doorman
```

Re-run either to reconcile; reusing the shared `Cloudflare.state()` store keeps the
resources tracked, so a change is a clean diff. Both stacks declare the `depo` bucket
identically (same `name` + `domains`), so neither deploy clobbers the other's view.

## Verify (read-path demo)

The stack is demoable on its own, before any upload worker exists: place an object in
the bucket (Cloudflare dashboard or `wrangler r2 object put`) at a key `<sha256>.<ext>`
with the right content type, then fetch it anonymously —

```bash
curl -I https://depo.kamp.us/<sha256>.<ext>   # 200 + the object's Content-Type
```
