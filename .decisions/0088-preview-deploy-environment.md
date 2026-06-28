---
id: 0088
title: A third deploy environment — `preview` — distinct from `development` and `production`
status: accepted
date: 2026-06-18
tags: [infra, deploy, auth, environment]
---

# 0088 — A third deploy environment — `preview` — distinct from `development` and `production`

**Note ([0090](0090-remove-dashboard-app.md)):** `apps/dashboard` is removed, so this
ADR's dashboard deploy leg is gone. The `preview` environment decision is unchanged and
fully stands; only the second-app leg it described no longer exists.

**Note (#1511, epic #1510 — the rite-audit harness):** a fourth class, **`audit`**, joins
the taxonomy for the dedicated isolated audit stage. It is a non-production deployed class
(served from `*.kampusinfra.workers.dev`, sharing `preview`'s auth topology) that exists so
the `phoenix-authorship-loop` flag's environment-targeting force-on rule (`equals environment
== audit`) can serve `on` non-interactively for the audit stage while `production` can never
match it. `isProduction` is unchanged (`=== "production"`), so `audit` provisions no email
subdomain / apex domain; `environmentForStage` maps only the `audit` stage to `audit`
(`prod`→`production` is untouched); and `parseDeployEnvironment` stays fail-loud on
genuinely-unknown values — `audit` is now a *known* class, not a relaxation of the #1433
guard.

## Context

`ENVIRONMENT` was a two-value `Config.literals(["development", "production"])`
read by both the `apps/web` and `apps/dashboard` workers (the worker-environment
pattern). `deploy.yml` set it as `STAGE == 'prod' ? 'production' : 'development'`,
so **every per-PR preview stage ran as `development`**.

That conflated two genuinely distinct deploy classes:

- **local `alchemy dev`** — served behind the Vite proxy, so the worker sees
  `Host: 127.0.0.1:<port>`, *not* the browser origin (`localhost:3000` / Vite's
  `:5173`). The browser origin must therefore be named explicitly.
- **a deployed ephemeral preview** — served directly from
  `*.kampusinfra.workers.dev`, where the worker's request host *is* the browser
  origin.

The conflation caused bug [#704](https://github.com/kamp-us/phoenix/issues/704):
the `development`-mode Better Auth config hardcoded a **localhost-only** trusted
origin list (correct for the proxied local case), which a deployed preview
rejected — a real browser sign-up there sends `Origin: https://…workers.dev`,
absent from the localhost list, so Better Auth returned **"Invalid origin"** and
UI sign-up/sign-in was broken on *every* preview. The e2e `signUpViaApi` setup
path masked it (`page.request.post` sends no browser `Origin` header), so only
the [#525](https://github.com/kamp-us/phoenix/issues/525) full-suite e2e flip
(PR [#699](https://github.com/kamp-us/phoenix/pull/699)) surfaced it — 32 authed
write-flow specs failing identically.

## Decision

Add **`preview`** as a first-class `ENVIRONMENT` literal:
`Config.literals(["development", "preview", "production"])` in both
`apps/web/worker/config.ts` and `apps/dashboard/worker/config.ts`. `deploy.yml`
labels deployed non-prod stages `ENVIRONMENT=preview` (prod stays `production`);
local `alchemy dev` keeps `development` via `.env`. Each class gets one tight
auth-origin config instead of `development` carrying both topologies:

- **`development`** — explicit `baseURL: "http://localhost:3000"` +
  `trustedOrigins: ["http://localhost:3000", "http://localhost:5173"]` (the
  Vite-proxy browser origins).
- **`preview`** — Better Auth's dynamic `baseURL: { allowedHosts:
  ["*.kampusinfra.workers.dev"] }` (its documented preview-deploy mechanism):
  resolves per request to the stage's own served origin and trusts it, scoped to
  *our account's* workers.dev subdomain so it matches only our own previews. No
  localhost — a preview is never hit from localhost.
- **`production`** — omit `baseURL`/`trustedOrigins`: Better Auth infers and
  self-trusts its request origin. Prod never trusts a preview or localhost
  origin — no CSRF widening (see ADR [0085](0085-auth-in-ci-storagestate-reuse.md)'s
  security note).

The dashboard worker only *reports* `environment` (in `/health`); it does not
branch on it, so adding the literal is sufficient there.

### Alternatives considered

- **Keep `development` overloaded, add the workers.dev wildcard inside its
  branch.** Works — proven 63/73 green on PR #699 — but mixes local + preview
  trust in one config, and that looseness has no clean home. Rejected for the
  honest three-class split.
- **Bind the worker's own deployed URL as `BETTER_AUTH_URL` via alchemy.**
  Rejected: alchemy's `worker.url` can be bound into *another* worker's `env`,
  but a worker can't reference its *own* url in its own `env` (circular; the
  preview url also carries a random suffix, so it is not predictable), and
  `@alchemy.run/better-auth` has no native origin/`baseURL` handling (it is thin
  D1 wiring). There is no alchemy-native primitive for this.
- **`preview` omits like `production`** and relies on Better Auth's request-origin
  inference. Viable — preview and prod share the deployed-direct topology — but
  prod's inference is currently untested, whereas `allowedHosts` is proven, so
  `preview` uses the explicit, proven mechanism.

## Consequences

- Every `ENVIRONMENT` branch must handle three values. Today the only behavioral
  branch is `better-auth-live.ts`'s `isLocalDev` gate (local-only magic-link
  `console.log`), kept `development`-only — a deployed preview logs to Cloudflare,
  not a watched console.
- `.patterns/worker-environment-pattern.md`'s documented literal list updates to
  three.
- `deploy.yml` lives under `.github/**`, so this change is control-plane
  (ADR [0053](0053-control-plane-boundary.md)) → human-merged.
- Future preview-specific behavior (gates, logging, seed conveniences) now has a
  named branch to hang on instead of overloading `development`.
- Mechanism verified against the installed `better-auth@1.6.10`
  (`getTrustedOrigins`, `matchesOriginPattern` / `wildcardMatch`).
