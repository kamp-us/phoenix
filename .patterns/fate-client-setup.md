# Client setup

How the SPA talks to the backend. The short answer: a generated `react-fate/client` module creates one `createFateClient` instance, a `<FateClient>` provider puts it in the tree, and every screen reads data through Suspense with an error boundary above it. The client imports the server's `Entity<>` types type-only, so the frontend and backend share one type contract with no schema artifact in between.

## The generated client

The **fate Vite plugin** generates the `react-fate/client` module at build time from the server's exported types and manifest: the typed `mutations`/`roots` tables, the normalization `types` array, and `createFateClient`. There is no hand-run codegen step. App code imports from `react-fate` (hooks, `view`) and `react-fate/client` (the configured client). The generated module imports `Entity<>` types **type-only** from `worker/fate/views.ts` — the server is the single source of truth for types, and there is no SDL or committed generated-artifact directory to keep in sync.

## Creating the client

```ts
// src/fate/client.ts
import {createFateClient} from "react-fate/client";

export const client = createFateClient({
  url: "/fate",
  liveUrl: "/fate/live",
  // Cookie session auth: better-auth's session cookie rides every request (same-origin).
  fetch: (input, init) => fetch(input, {...init, credentials: "include"}),
  onLiveError: (error) => console.error("live", error),  // live errors are out-of-band
});
```

Auth is the better-auth **session cookie**. `credentials: "include"` sends it on the data transport, and fate opens the live `EventSource` with `withCredentials: true`, so the same cookie authenticates the SSE stream — no token in the URL, no `Authorization` header. This works because the SPA and API are same-origin (one Worker). See [fate-live-views.md](./fate-live-views.md#auth).

## The provider

```tsx
// src/main.tsx
import {FateClient} from "react-fate";
import {client} from "./fate/client";

<FateClient value={client} key={userId ?? "anon"}>
  <App />
</FateClient>;
```

**Key the provider on the user id.** The client holds one normalized cache; re-keying on login/logout rebuilds it so a previous session's data never leaks into the next.

## Suspense + error rails

Reads suspend and errors throw, so every screen sits under a `<Suspense>` and an error boundary. A small wrapper pairs them:

```tsx
export const Screen = ({children, fallback}: {children: ReactNode; fallback: ReactNode}) => (
  <ErrorBoundary fallback={(e) => <ScreenError code={e.code} />}>
    <Suspense fallback={fallback}>{children}</Suspense>
  </ErrorBoundary>
);
```

`useRequest` and `useView` throw a promise while data is in flight (caught by `Suspense`) and throw a `FateRequestError` on boundary-class failures (caught by the error boundary). The error carries a `code` ([fate-mutations-client.md](./fate-mutations-client.md#errors)). Mutations split errors into inline (`callSite`) vs thrown (`boundary`), so not every failure reaches the boundary — see that doc.

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
