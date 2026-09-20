# Better Auth on the shared D1

This guide applies to `apps/web/worker`. Phoenix owns a local
[BetterAuth service](../apps/web/worker/features/pasaport/BetterAuth.ts) and supplies
[BetterAuthLive](../apps/web/worker/features/pasaport/better-auth-live.ts). Follow
those files when changing auth; the removed Alchemy integration package is not
part of the current wiring. Dependency versions live in the
[workspace catalog](../pnpm-workspace.yaml).

## Construction and storage

`BetterAuthLive` reads the existing [Database service](../apps/web/worker/db/Database.ts).
That service owns `Cloudflare.D1.QueryDatabase(PhoenixDb)` and exposes its raw D1
handle to both auth and product queries. The auth layer does not declare or bind a
second database. Its Drizzle instance uses `defineRelations(schema)` over the
[shared schema](../apps/web/worker/db/drizzle/schema.ts); auth tables use the same
[migration pipeline](alchemy-drizzle-d1.md) as product tables.

The signing secret comes from `betterAuthSecret` in
[config.ts](../apps/web/worker/config.ts): `Config.redacted("BETTER_AUTH_SECRET")`,
with no default. `BetterAuthLive` fails initialization if it cannot read the
secret and passes its resolved value to Better Auth. Keep the runtime binding
path; do not replace it with an Alchemy `Random` resource. Dev setup and secret
provisioning are described in [DEVELOPMENT](../DEVELOPMENT.md#quickstart).

`Effect.cached` memoizes construction of the **auth instance**. It does not cache
sessions. [Pasaport.validateSession](../apps/web/worker/features/pasaport/Pasaport.ts)
calls `auth.api.getSession({headers})` for each validation, and the auth options do
not enable `session.cookieCache`. Preserve that distinction when changing the
layer: sharing one instance must not introduce a shared session cache.

## Configuration that must survive a change

The complete options stay in
[better-auth-live.ts](../apps/web/worker/features/pasaport/better-auth-live.ts), not
in a second recipe here. Keep these choices when changing that construction:

| Concern | Current owner and constraint |
|---|---|
| Origins and cookies | `deriveAuthUrlConfig(environment)` owns development browser origins, deployed preview/audit hosts and the production apex. Do not infer these from the proxy's inbound Host header. |
| Drizzle adapter | The shared D1 uses `drizzleAdapter` with the shared schema. `experimental.joins` stays off; the reason and current check are in [alchemy-drizzle-d1.md](alchemy-drizzle-d1.md#better-auth-on-the-same-d1). |
| Plugins | Preserve `bearer`, `magicLink` and `apiKey`. API keys enable sessions and use `apiKeyRateLimit`; bearer supports the existing client's token path. |
| Email | Magic links, signup verification and change-email confirmation go through [EmailSender](../apps/web/worker/features/pasaport/email-sender.ts) and the existing templates. Signup verification does not gate sign-in. |
| User fields | `additionalUserFields` keeps server-owned fields `input: false`; callers must not grant themselves role or tier. |

The [URL configuration tests](../apps/web/worker/features/pasaport/better-auth-url-config.unit.test.ts)
and [additional-field tests](../apps/web/worker/features/pasaport/additional-user-fields.unit.test.ts)
are focused examples for these configuration boundaries.

## Consumers share the service

[Worker initialization](../apps/web/worker/index.ts) obtains `BetterAuth` once and
provides that same service value to the data layer and auth routes. It does not
rebuild `BetterAuthLive` per request.

[PasaportFromTag](../apps/web/worker/features/fate/layers.ts) resolves the service's
`auth` effect and passes the resulting instance into `makePasaportLive(auth)`.
The service contract retains a `RuntimeContext` requirement; this adapter supplies
an inert context because the current constructor already resolved its binding
inputs. The [deployed adapter test](../apps/web/tests/integration/pasaport-from-tag.test.ts)
checks that a session round-trips with that inert context. If construction begins
needing a real context, change the layer requirements deliberately instead of
weakening the test.

The [/api/auth route](../apps/web/worker/features/pasaport/route.ts) delegates to
the same service's `fetch`. Its [auth bridge](../apps/web/worker/features/pasaport/auth-bridge.ts)
converts a rejected Better Auth handler into a 503 response with
`AUTH_BRIDGE_UNAVAILABLE`, logging the cause without returning it to the caller.
Keep that response distinct from an ordinary auth denial.

For the surrounding layer ownership, see
[fate worker wiring](fate-effect-worker-wiring.md) and
[layer composition](effect-layer-composition.md).
