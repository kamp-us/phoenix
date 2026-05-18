---
id: 0012
title: Admin operations as parallel `<Feature>Admin` services with a separate runtime
status: accepted
date: 2026-05-17
tags: [backend, effect, admin, architecture]
---

# 0012 — Admin operations as parallel `<Feature>Admin` services with a separate runtime

## Context

Phoenix exposes admin routes under `/api/admin/*` (Hono handlers, originally `async (c) => ...`) — `sozluk/upsert-term`, `sozluk/clear`, `pano/seed`, `pasaport/backfill-profiles`. These called into feature `module.ts` functions like `seedTerm`, `clearAllTerms` — functions that bypass user-facing validation and operate idempotently or destructively. Authorization was `env.ENVIRONMENT === "development"` checked inline in the Hono handler.

Under [0010](0010-effect-context-service-backend.md), feature `module.ts` files are deleted in favor of `Context.Service` classes. The admin routes need a home for their operations. Four candidates:

1. **Keep `module.ts` alive solely for admin imports.** Two ways to do the same thing — service handles resolver path; module handles admin path. Splits the source of truth.
2. **Bundle admin methods into the feature service.** `Sozluk` grows `seedTerm`, `clearAllTerms` alongside `addDefinition`, `getTerm`. Resolver-facing and admin-facing operations share a service surface. Resolvers can accidentally yield admin methods.
3. **Move admin-only logic into the service as methods that admin routes call.** Variant of (2). Same problem.
4. **Parallel admin service per feature.** `SozlukAdmin`, `PanoAdmin`, `PasaportAdmin` own the admin operations. Resolver-facing services stay clean. Different auth model, different consumers, different invariants.

Admin operations have genuinely different semantics: bulk idempotent writes (seed), destructive wipes (clear-all), backfills. They aren't subject to the same validation as user-facing mutations. They have a different auth model. They're called from a different runtime context (Hono handlers, no GraphQL session).

## Decision

Each feature with admin operations gets a parallel `<Feature>Admin` `Context.Service`:

- `SozlukAdmin` — `seedTerm`, `clearAllTerms`
- `PanoAdmin` — `seedPosts` (and similar)
- `PasaportAdmin` — `backfillProfiles`

These services depend on `Drizzle` and `AdminAuth`, mirror the feature-service patterns ([0010](0010-effect-context-service-backend.md), `.patterns/feature-services.md`), and live in `worker/features/<feature>/<Feature>Admin.ts` alongside the resolver-facing service.

Admin routes run against a **separate `ManagedRuntime`** wired in `worker/admin/runtime.ts` (or equivalent). The admin runtime provides:

- `Drizzle` (shared with the GraphQL runtime in spirit, separate construction per request)
- `AdminAuth`
- All `<Feature>Admin` services
- `CloudflareEnv`

It does **not** provide: `Auth` (GraphQL user session), `RequestContext`, or any resolver-facing feature service. Resolver-facing services are unavailable to admin routes; admin services are unavailable to resolvers.

**Auth seam:** `AdminAuth` is a `Context.Service<AdminAuth, {allowed: boolean}>` with a `static readonly required` that fails with `AdminForbidden` if `allowed === false`. The initial `AdminAuthLive` derives `allowed` from `env.ENVIRONMENT === "development"`. Future hardening (signed tokens, allow-lists, audit) lands inside `AdminAuthLive` without touching call sites. The pattern mirrors `Auth.required` from the GraphQL runtime.

Hono admin route shape:

```ts
app.post("/api/admin/sozluk/upsert-term", async (c) => {
  return adminRuntime(c.env).runPromise(Effect.gen(function*() {
    const auth = yield* AdminAuth;
    yield* auth.required;
    const admin = yield* SozlukAdmin;
    return yield* admin.seedTerm(await c.req.json());
  }));
});
```

## Consequences

**Easier:**
- Resolver services stay narrow — `Sozluk` doesn't include `seedTerm`. Resolver typings can't accidentally yield admin-only operations.
- Admin auth is a single chokepoint. Future tightening (real auth, audit logging, rate limits) lands in one file (`services/AdminAuth.ts`).
- Admin services can grow operations that don't fit the user-facing model (bulk imports, schema migrations, data quality jobs) without polluting the resolver surface.

**Harder / costlier:**
- More service definitions and layers to maintain. Each feature with admin operations doubles its service file count.
- Cross-cutting helpers (e.g., body validation if a future admin operation reuses domain validation) need to be importable across both services. Encourages extraction to `worker/shared/*` modules — consistent with the helper-extraction policy.
- Two runtimes to keep in sync as new services are added. Mostly mechanical, but real.

**Now banned:**
- Admin operations on resolver-facing feature services. `Sozluk.seedTerm` would not exist; if a resolver needs to call it, the resolver is doing something it shouldn't.
- Direct `env.ENVIRONMENT === "development"` checks in admin Hono handlers. The check lives in `AdminAuthLive` only.
- A single shared runtime for both GraphQL and admin paths. Always two — the surface areas are intentionally distinct.

**Future:** if admin operations across features grow shared concerns (audit logs, dry-run mode, transaction semantics), the per-feature admin services may consolidate into a single `Admin` service that holds all admin operations as methods. Revisit if/when the duplication shows up. At this scale the per-feature split is the YAGNI-correct shape — admin operations don't share much beyond `AdminAuth.required`.

**Patterns:** see `.patterns/feature-services.md` (admin services follow the same shape as feature services), `.patterns/effect-layer-composition.md` (the dual-runtime composition).
