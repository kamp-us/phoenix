# Client setup

How the SPA talks to the backend. The short answer: a generated `react-fate/client` module creates one `createFateClient` instance, a `<FateClient>` provider puts it in the tree, and every screen reads data through Suspense with an error boundary above it. The client imports the server's `Entity<>` types type-only, so the frontend and backend share one type contract with no schema artifact in between.

## The generated client

The **fate Vite plugin** (`react-fate/vite`, `transport: "native"` — phoenix runs fate's native protocol on Hono, no tRPC adapter) generates the `react-fate/client` module at build time from the server's exported types and manifest: the typed `mutations`/`roots` tables, the normalization `types` array, and `createFateClient`. There is no hand-run codegen step. App code imports from `react-fate` (hooks, `view`) and `react-fate/client` (the configured client). The generated module imports `Entity<>` types **type-only** from the server schema module — the server is the single source of truth for types, and there is no SDL or committed generated-artifact directory to keep in sync.

```ts
// vite.config.ts
import {fate} from "react-fate/vite";

fate({
  module: "./worker/fate/schema.ts", // exports the data views + `fateServer` + entity types + `Root`
  transport: "native",
  tsconfigFile: false,               // we own `.fate/`'s tsconfig story (see "Typecheck wiring")
});
```

The plugin reads its `module` (a barrel re-exporting `worker/fate/views.ts` + `{fateServer}` from `worker/fate/server.ts`) via a Node Vite runner at build time. The output lands in `.fate/client.generated.ts` (**gitignored — never committed**) and carries a `declare module "react-fate/client"` augmentation typed from the server.

**Client-exposed roots are declared by a `Root` value exported from `views.ts`** (fate's `viewer` pattern). A view-based `Root` entry (e.g. `me: userDataView`) becomes a typed client root the plugin emits; at runtime it resolves through the matching `queries.<name>` resolver. `Root` is **not** passed to `createFateServer` (`roots: {}` stays empty there) — a non-empty `Roots` generic would surface fate's internal `DataView` symbol (TS2883). byId roots are generated from the source registry; only custom-resolver roots need a `Root` entry.

> **Codegen runner can't see `cloudflare:workers`.** The server module graph transitively imports `cloudflare:workers` (better-auth wiring), which only exists in workerd, so the plugin's Node runner can't resolve it. A `resolve.alias` with a `customResolver` scoped to the `inline` environment (Vite's `runnerImport` env name) swaps in a load-time-safe stub (`worker/fate/codegen-stubs/cloudflare-workers.ts`) for the runner only — every other environment (SPA build, the cloudflare worker build) returns `null` and resolves the real built-in.

## Creating the client

```ts
// src/fate/client.ts — the generated `createFateClient` (native transport) takes
// {url, fetch?, headers?, liveUrl?, liveRetryMs?, onLiveError?}.
import {createFateClient} from "react-fate/client";

// `authenticated` decides whether the grafted live transport is real or no-op
// (see "Enabling live" below).
export const createClient = ({authenticated}: {authenticated: boolean}) => {
  const client = createFateClient({
    url: "/fate",
    liveUrl: "/fate/live",
    // Cookie session auth: better-auth's session cookie rides every request (same-origin).
    fetch: (input, init) => fetch(input, {...init, credentials: "include"}),
    onLiveError: (error) => console.error("[fate] live", error), // live errors are out-of-band
  });
  // Graft live (real or no-op) onto the client's transport — see "Enabling live".
  return client;
};
```

Auth is the better-auth **session cookie**. `credentials: "include"` sends it on the data transport, and fate opens the live `EventSource` with `withCredentials`, so the same cookie authenticates the SSE stream — no token in the URL, no `Authorization` header. This works because the SPA and API are same-origin (one Worker). See [fate-live-views.md](./fate-live-views.md#auth).

> **Enabling live — graft the live transport.** `useLiveView`/`useLiveListView` require the client's transport to expose `subscribeById`/`subscribeConnection`, which fate's native HTTP transport only builds when constructed with `live: true`. The Vite plugin emits `live: true` in the generated client only when `fateServer.manifest.live` is non-empty — and that manifest is populated by walking `roots`. phoenix keeps `roots: {}` (every read is a custom `queries`/`lists` resolver, which keeps the `fateServer` export type nameable — TS2883), so the generated transport is built with `live: false`. So phoenix enables live the way fate's own client template does: build a separate `live: true` HTTP transport and graft its `subscribeById`/`subscribeConnection` onto the client's transport. The native live client is lazy (the `EventSource` opens on the first subscription), so grafting costs nothing until a `useLiveView` mounts. An **anonymous** client (no session) gets **no-op** live methods instead — `/fate/live` requires the session cookie, so an anon `EventSource` would 401 and retry forever; the no-ops satisfy `assertLive*Support()` without ever opening a stream. The provider re-keys on user id, so signing in rebuilds the client with the real live transport.

## The provider

The provider component is `FateClient` from `react-fate` and its prop is **`client`** (not `value`). Build the client per user id and key the provider on it:

```tsx
// src/fate/FateProvider.tsx
import {useMemo} from "react";
import {FateClient} from "react-fate";
import {useSession} from "../auth/client";
import {createClient} from "./client";

export function FateProvider({children}: {children: React.ReactNode}) {
  const userId = useSession().data?.user.id ?? null;
  // Live SSE only opens for an authenticated client (`/fate/live` 401s for anon),
  // so an anon client gets no-op live methods. Keyed on `userId`, so signing in
  // rebuilds the client with real live support.
  const client = useMemo(() => createClient({authenticated: userId != null}), [userId]);
  return (
    <FateClient key={userId ?? "anon"} client={client}>
      {children}
    </FateClient>
  );
}
```

**Key the provider on the user id.** The client holds one normalized cache; re-keying on login/logout rebuilds it so a previous session's data never leaks into the next. Mount `<FateProvider>` at the app root (above the router).

## Suspense + error rails

Reads suspend and errors throw, so every screen sits under a `<Suspense>` and an error boundary. A small wrapper pairs them:

```tsx
// src/fate/Screen.tsx
export function Screen({children, fallback, error}: ScreenProps) {
  return (
    <ErrorBoundary fallback={error}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ErrorBoundary>
  );
}
```

`useRequest` and `useView` throw a promise while data is in flight (caught by `Suspense`) and throw a `FateRequestError` on boundary-class failures (caught by the error boundary). The error carries a `code` ([fate-mutations-client.md](./fate-mutations-client.md#errors)). Mutations split errors into inline (`callSite`) vs thrown (`boundary`), so not every failure reaches the boundary — see that doc.

> **`FateRequestError` is not exported from the client entrypoints** (only `@nkzw/fate/server`). Client code must not import from `/server`, so the boundary **duck-types** the thrown error: any object with a string `code` is treated as a fate request error and its `code` surfaced; anything else falls back to `INTERNAL_SERVER_ERROR`. The `code` is widened to `string` because the phoenix server forwards a wider wire vocabulary than fate's closed `FateProtocolErrorCode` union.

## Typecheck wiring

The fate generated client (`clientRoot`/`createFateClient` returns) is **not composite-safe** — under `composite: true` the declaration-nameability check trips TS2883 on fate's internal `RootDefinition`/`DataView` symbols. So `apps/web/tsconfig.app.json` is **non-composite**: it's dropped from the root `tsconfig.json` references and checked with `tsgo -p` (the worker/node projects stay composite under `tsgo -b`). The app project also `include`s the worker fate graph (`worker`, minus `worker/index.ts`/`worker/graphql`/`worker/admin`) and adds `@cloudflare/workers-types`, because `src/fate/**` and the generated file import the server's entity types + `typeof fateServer` and `tsgo`'s `noEmit` composite refs can't share types across the project boundary without emit. `pnpm typecheck` runs `fate generate` first so `.fate/client.generated.ts` exists, then `tsgo -b && tsgo -p tsconfig.app.json`.

## What the client owns

- **One normalized cache** keyed by `__typename:id`, shared by every `useView`, `useListView`, and live subscription.
- **One batched data request per screen** ([fate-views-and-requests.md](./fate-views-and-requests.md)).
- **One shared SSE connection** for all live subscriptions ([fate-live-views.md](./fate-live-views.md)).

## See also

- [fate-views-and-requests.md](./fate-views-and-requests.md) — `view`/`useView`/`useRequest`, the read model
- [fate-mutations-client.md](./fate-mutations-client.md) — writes, optimistic updates, error routing
- [fate-live-views.md](./fate-live-views.md) — the SSE connection and its auth
- [fate-data-views.md](./fate-data-views.md) — the server views whose `Entity<>` types the client imports
- void reference (in the [fate](https://github.com/usirin/fate) repo): `example/void/.fate/client.generated.ts`, `packages/react-fate/src/context.tsx`
