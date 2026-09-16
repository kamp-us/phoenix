# better-auth on Cloudflare D1 with plugins — the forked CloudflareD1 Layer

> Derived from `alchemy@2.0.0-beta.59` — re-verify on pin bump.

Phoenix runs better-auth on `@alchemy.run/better-auth`'s `BetterAuth`
Context.Service tag, but provides its own Layer implementation rather than
the upstream `CloudflareD1` reference Layer. The reasons are concrete: the
upstream Layer hard-codes `makeBetterAuth({database, secret})` with no
plugin slot, declares its own D1 (which would be a second D1 alongside
phoenix's existing `PhoenixDb`), and ships no `baseURL`/`trustedOrigins`
wiring. Forking ~40 lines and adding the missing pieces is the shortest
path to keep plugins (magic-link, bearer), the existing D1, and the dev
Vite-proxy cookie config.

This doc captures the pattern. The implementation is
`apps/web/worker/features/pasaport/better-auth-live.ts`; the call site is
`apps/web/worker/index.ts`; the consumer that needs an `Auth` instance
without leaking `RuntimeContext` is `apps/web/worker/features/pasaport/Pasaport.ts`.

## The shape

```ts
// features/pasaport/better-auth-live.ts (shape, simplified)
import * as BetterAuth from "@alchemy.run/better-auth";
import * as Cloudflare from "alchemy/Cloudflare";
import {betterAuth as makeBetterAuth} from "better-auth";
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {bearer, magicLink} from "better-auth/plugins";
import {drizzle} from "drizzle-orm/d1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as schema from "../db/drizzle/schema.ts";
import {PhoenixDb} from "../db/resources.ts";
import {betterAuthSecret} from "../../config.ts";

export const BetterAuthLive = Layer.effect(
  BetterAuth.BetterAuth,
  Effect.gen(function* () {
    // Reuse phoenix's existing D1 — no separate BetterAuth DB.
    const connection = yield* Cloudflare.D1.QueryDatabase(PhoenixDb);
    const env = yield* Cloudflare.WorkerEnvironment;

    // The session-signing secret is a `secret_text` binding, read at request
    // time. NOT the reference layer's `alchemy/Random`: that is a deploy-time
    // resource with no value in the workerd isolate. `orDie` — a missing
    // secret is an unrecoverable misconfig, never a blank signing key.
    const secret = yield* betterAuthSecret.pipe(Effect.orDie);

    // ... resolve baseURL / trustedOrigins from env ...

    // `Effect.cached` so the `makeBetterAuth` call happens once per
    // isolate, not per request.
    const auth = yield* Effect.gen(function* () {
      const d1 = yield* connection.raw;
      const db = drizzle(d1, {schema});
      return makeBetterAuth({
        emailAndPassword: {enabled: true},
        database: drizzleAdapter(db, {provider: "sqlite", schema}),
        secret: Redacted.value(secret),
        ...(baseURL ? {baseURL} : {}),
        ...(trustedOrigins ? {trustedOrigins: [...trustedOrigins]} : {}),
        user: {additionalFields: {username: {type: "string", required: false, input: false}}},
        plugins: [
          bearer(),
          magicLink({sendMagicLink: async ({email, token, url}) => { /* ... */ }}),
        ],
      });
    }).pipe(Effect.cached);

    return {
      auth, // Effect.Effect<Auth, never, RuntimeContext>
      fetch: /* request handler that calls auth.handler(...) */,
    };
  }),
).pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding));
```

The Layer satisfies `BetterAuth.BetterAuth` (the Context tag from
`@alchemy.run/better-auth`), so any consumer that yields it gets the same
phoenix-configured instance.

## Why fork rather than use upstream `CloudflareD1` directly

Three load-bearing differences from the reference Layer:

- **Plugins.** The upstream `CloudflareD1` calls `makeBetterAuth({database, secret})`
  with no plugin slot. Magic-link is non-negotiable (it's how phoenix's
  signup-by-link flow works), and `bearer()` is needed for API token
  callers. There's no clean composition that adds plugins to a
  pre-constructed `Auth` instance, so the construction itself has to
  carry them.
- **Database reuse.** The reference Layer declares its own
  `Cloudflare.D1.Database("BetterAuth")` — a second D1 alongside the
  canonical `PhoenixDb` defined in `apps/web/worker/db/resources.ts`.
  The better-auth tables (user, session, account, verification) live on
  the same D1 as the rest of the product data (post, term,
  definition, user_profile) — schema is in
  `apps/web/worker/db/drizzle/schema.ts`. The fork binds `PhoenixDb`
  directly.
- **`baseURL` / `trustedOrigins`.** Phoenix's dev loop runs the SPA
  behind a Vite proxy (ADR 0030/0031), so the worker sees
  `Host: 127.0.0.1:<port>` rather than the browser origin. better-auth
  needs the real browser origin to set/validate its cookie. The
  reference Layer doesn't surface these knobs — the fork reads them off
  `WorkerEnvironment` and passes them through.

The fork is ~40 lines and is the smallest delta that keeps the three
above. Tracking upstream is straightforward — the structure
(`D1.QueryDatabase`, `Effect.cached` for the `makeBetterAuth` call)
mirrors the reference Layer; the secret's source and the
`makeBetterAuth` body are what diverge.

## The secret — a `secret_text` binding, not `alchemy/Random`

The session-signing secret is a Cloudflare `secret_text` binding, read at
request time as `Config.redacted("BETTER_AUTH_SECRET")`
(`apps/web/worker/config.ts`) with no default, so a missing secret fails
closed rather than signing with a blank key.

The reference Layer's `Random("BETTER_AUTH_SECRET")` was tried and dropped.
`Random` is a **deploy-time** resource: its `.text` has no value inside the
workerd isolate, so better-auth ended up signing cookies with an unresolved
Effect. A value the worker must read on every request has to travel as a
binding.

One consequence is load-bearing for anything outside the worker that signs a
session cookie: **the value lives only where it was deployed from.** The
`secret_text` binding does not read back, and `infra/ci-credentials/github.ts`
mints one stable repo-wide value and pushes it as a write-only GitHub Actions
secret, which `.github/workflows/deploy.yml` passes into `alchemy deploy` for
every stage. So the one readable copy is the stack's alchemy state, behind
`$ALCHEMY_PASSWORD`. A seat that signs a preview session cookie —
`review-ui render`'s tier states — needs that value and nothing else: the
throwaway `insecure_`-prefixed secret in `apps/web/.env.example` signs a
well-formed cookie the deployed worker answers as a visitor, which is
indistinguishable at the shot from an unseeded preview. That verb's
`--auth-secret-from` is the named supply route, and it refuses the placeholder
rather than signing with it (#9288).

ADR 0032 retired `Alchemy.Secret`/`Alchemy.Variable` in favor of
`Config.redacted`, and this secret is on that path.

## Auth instance threading — yielded once, passed as a factory parameter

`betterAuth.auth` is `Effect.Effect<Auth, never, RuntimeContext>`. A
consumer that yields it inside a service method body inherits
`RuntimeContext` on the method's `R`. For a feature service like
`Pasaport`, which has methods like `validateSession` that need the `Auth`
instance to call `auth.api.getSession(...)`, the naive shape leaks
`RuntimeContext` into every method's `R`, which propagates to every fate
resolver that calls a Pasaport method, and so on.

The fix is to yield the `Auth` instance **once** in worker init (where
`RuntimeContext` is in scope from alchemy's `Phoenix.make` body) and pass
the **resolved instance** into the `Pasaport` Layer factory as a plain
function parameter:

```ts
// worker/index.ts (init phase)
const betterAuth = yield* BetterAuth.BetterAuth;
const authInstance = yield* betterAuth.auth; // Auth, the resolved instance
const fateLayer = makeFateLayer(createDrizzle(raw), env, authInstance);
```

```ts
// features/pasaport/Pasaport.ts
export const makePasaportLive = (auth: BetterAuthInstance) =>
  Layer.effect(Pasaport)(Effect.gen(function* () {
    const {run} = yield* Drizzle;
    const validateSession = Effect.fn("Pasaport.validateSession")(function* (/* ... */) {
      // `auth` is closed over from the factory parameter — no yield, no R.
      const session = yield* Effect.promise(() => auth.api.getSession({headers}));
      // ...
    });
    return Pasaport.of({validateSession, /* ... */});
  }));
```

Pasaport's method `R` types stay `never`. The `Auth` instance is shared
with the `/api/auth/*` route (which calls `auth.handler(request)`), so
sessions are signed and validated with the same secret on both paths.

This is the canonical pattern for "I need an instance of something that
was constructed at init time, and I don't want its construction
requirements to land on my service's method signatures". The factory
parameter is the seam.

## Reuse the existing phoenix D1

`yield* Cloudflare.D1.QueryDatabase(PhoenixDb)` is how the Layer binds
to the canonical D1 (declared in `apps/web/worker/db/resources.ts`).
The drizzle adapter then takes `connection.raw` (the underlying
`D1Database` handle) plus the shared schema:

```ts
const d1 = yield* connection.raw;
const db = drizzle(d1, {schema});
makeBetterAuth({database: drizzleAdapter(db, {provider: "sqlite", schema}), /* ... */});
```

This is the same D1 phoenix's feature services run on, so the better-auth
tables migrate alongside the product tables (`drizzle-kit` reads
`apps/web/worker/db/drizzle/schema.ts`; both surfaces are there). A
single migration set, a single D1, a single backup story.

## The magic-link callback's dynamic import

The `magicLink({sendMagicLink: …})` callback uses a **dynamic** import of
`cloudflare:workers` rather than a top-level static import:

```ts
sendMagicLink: async ({email, token, url}) => {
  const {env: wenv} = await import("cloudflare:workers");
  if (wenv.ENVIRONMENT === "development") {
    console.log("[pasaport] magic link", {email, token, url});
  }
},
```

The reason is the fate codegen Vite plugin: it imports this module graph
in a plain Node runner to read the server's `Entity<>` types, and the
workerd built-in `cloudflare:workers` can't resolve in that context. A
static import resolves at module load time (breaking codegen); a dynamic
import inside the already-async callback resolves only at call time,
inside workerd — so codegen never touches it and runtime behavior is
unchanged.

## Citations

- `apps/web/worker/features/pasaport/better-auth-live.ts` — the forked Layer.
- `apps/web/worker/features/pasaport/Pasaport.ts` — `makePasaportLive(auth)`
  factory that takes the resolved instance.
- `apps/web/worker/index.ts` — the worker init that yields `betterAuth.auth`
  once and threads `authInstance` into the fate Layer.
- `apps/web/worker/db/resources.ts` — `PhoenixDb` (the shared D1).
- `apps/web/worker/db/drizzle/schema.ts` — the shared schema (product
  tables + better-auth tables).

## See also

- [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) — `D1.QueryDatabase`,
  drizzle wiring.
- [effect-layer-composition.md](./effect-layer-composition.md) — the
  `RuntimeContext`-escape: why a service whose method yields
  `RuntimeContext` propagates `R` upward, and why the resolved value is
  threaded as a plain factory argument instead.
- [feature-services.md](./feature-services.md) — one service per
  feature, methods on the service value.
- [ADR 0031](../.decisions/0031-local-first-dev-state.md) — dev cookie /
  `baseURL` / trusted-origins context.
- [ADR 0032](../.decisions/0032-alchemy-beta45-and-dev-model.md) —
  `Config.redacted` replaces `Alchemy.Secret`, which is the path this
  pattern's session-signing secret is on.
