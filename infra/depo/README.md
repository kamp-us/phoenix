# @kampus/depo-infra

The **depo** read-path stack — a standalone alchemy stack that provisions
[depo](../../.glossary/TERMS.md)'s object store and public read seam.

`depo` is kampus's internal asset store / CDN: R2-backed, content-addressed
write-once, public-read at `depo.kamp.us`, dumb by mandate (ADR
[0144](../../.decisions/0144-depo-internal-asset-cdn.md)). This package is the
**read path** slice — the bucket plus the public custom domain. Objects are served
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

There is **no read-path compute** and **no write path here** — the doorman upload
worker and the `depo` CLI are separate slices of epic #1965.

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
CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> ALCHEMY_PASSWORD=<pw> \
  pnpm --filter @kampus/depo-infra deploy:depo
```

Re-run to reconcile the bucket or the custom domain; reusing the shared
`Cloudflare.state()` store keeps the resources tracked, so a change is a clean diff.

## Verify (read-path demo)

The stack is demoable on its own, before any upload worker exists: place an object in
the bucket (Cloudflare dashboard or `wrangler r2 object put`) at a key `<sha256>.<ext>`
with the right content type, then fetch it anonymously —

```bash
curl -I https://depo.kamp.us/<sha256>.<ext>   # 200 + the object's Content-Type
```
