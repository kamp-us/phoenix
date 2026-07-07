---
id: 0167
title: Two-tier fate provider — an eager anonymous public client above the session gate, the identity-keyed authed client below
status: accepted
date: 2026-07-06
tags: [frontend, fate, first-paint, infra, session]
---

# 0167 — Two-tier fate provider

## Context

The pano feed is anon-capable: an anonymous visitor gets a feed, and its rows read
from public `/fate` views that need no session to render. Yet in the current React
tree the feed cannot paint until `/api/auth/get-session` resolves, because it renders
**below** the `FateProvider` session gate.

Grounded in the tree as it stands (vs `origin/main`):

- [`apps/web/src/App.tsx`](https://github.com/kamp-us/phoenix/blob/main/apps/web/src/App.tsx) —
  `Layout()` already paints an **always-painting shell frame** above the gate (topbar +
  chrome, #2160) using **only** `useSession` — no fate client. But every route, `/pano`
  → `PanoFeed` included, is a child of `<Route element={<Layout/>}>`, and the routed
  `Outlet` lives under `<Main>` → `<FateProvider>` → `LayoutContent` → `<Outlet/>`. So
  the feed renders inside `FateProvider`.
- [`apps/web/src/fate/FateProvider.tsx`](https://github.com/kamp-us/phoenix/blob/main/apps/web/src/fate/FateProvider.tsx) —
  the gate is the last statement before render: `if (session.isPending) return null;`,
  with `<FateClient key={userId ?? "anon"} client={client}>`. While `get-session` is
  pending, `FateProvider` returns `null`, so **nothing below it paints** — the
  anon-capable feed included.

This is a client-side render waterfall that persists **independent of** the server-side
`get-session` cost (#2260, fixed separately via BetterAuth `cookieCache`). Even once
`get-session` is sub-second, the feed stays structurally coupled to the session gate
rather than firing its `/fate` read (≈478ms) in parallel. Decoupling it is a
defense-in-depth win that survives any future session-resolve slowdown.

**Why this is not a simple move-it-up.** The gate's `if (session.isPending) return null`
+ `key={userId ?? "anon"}` is a deliberate guard (#438). Its own docblock: committing
the keyed client before the session settles "mounts the subtree under 'anon', then
re-keys to the real id once the session lands — remounting the whole router and wiping
any controlled form mounted in the window." The naive fix (paint the feed before the
session settles) is exactly what #438 defers the client to avoid. The shell-frame
pattern (#2160) paints above the gate precisely **because it uses no fate client**; the
feed **does** need a client (it runs a `/fate` query), so it cannot move up the same
way.

The genuine fork: how does anon-capable content obtain a fate client above / independent
of the session gate **without** re-introducing the #438 re-key remount?

Grounded substrate facts that make the split coherent (from
[`apps/web/src/fate/client.ts`](https://github.com/kamp-us/phoenix/blob/main/apps/web/src/fate/client.ts)
and `FateProvider.tsx`, not intuition):

- `createClient({authenticated})` already builds two flavors of client from one factory.
  The **anon** flavor is a first-class shape today: its `/fate/live` `EventSource` would
  401-loop, so it is given **no-op** `subscribeById`/`subscribeConnection`.
- The normalized cache is bound to the **client instance** — the FateProvider docblock
  states re-keying "rebuilds the client (and its one normalized cache)." That is *why*
  identity change is expressed as a `key` swap (which remounts). There is no react-fate
  API in-repo for an in-place cache reset without a remount.
- Viewer-scoped scalars (`myVote` / `isSaved`, read via `PanoPostCardView`) are
  **null/absent for an anonymous viewer** by construction. The public feed's rows do not
  need them to make their first paint.

This is an engineering-led structural decision on the fate/session substrate
(ADR [0078](0078-product-driven-decisions-by-default.md): platform/infra leads). Its
child is the implementation; this ADR records only the structure.

## Decision

Split the single session-gated fate provider into a **two-tier fate provider**.

1. **An eager, always-anonymous public fate client mounts *above* the session gate**,
   inside the #2160 shell frame. It commits on the first frame — it never waits on
   `session.isPending` — and it never re-keys, because it is always the anonymous client
   (`createClient({authenticated: false})`). Anon-capable **public read views** (the pano
   feed's public post-list query) bind to this client and paint in parallel with
   `get-session`, on their own data arrival.

2. **The identity-keyed authenticated fate client stays *below* the gate, unchanged.**
   `FateProvider` keeps `if (session.isPending) return null` + `key={userId ?? "anon"}`
   verbatim. It serves everything that needs the settled identity: **viewer-scoped
   scalars** (`myVote` / `isSaved`), mutations, and live SSE. The #711 app-lifetime live
   pin stays on this client.

3. **The feed's public shell reads the public client; its viewer-scoped scalars read the
   authed client.** For an anonymous visitor the viewer scalars are null/absent, so the
   public paint is the whole paint. For a signed-in visitor the public rows paint
   immediately from the public client, and the per-row vote/save affordance hydrates from
   the authed client once the session settles — a nested read boundary, not a remount.

Because the public client is a **distinct, never-re-keyed instance**, it commits
pre-session without ever triggering the #438 re-key remount; the authed client's
deferred-commit guard is untouched, so #438's invariant — no controlled-form-wiping
remount on login/logout — is **preserved verbatim**. This makes an already-latent duality
structural: a public read is, by construction, unable to depend on a session
("make invalid states unrepresentable").

This ADR does **not** touch any guard or enforcement mechanism — it is an
`apps/web/src/**` React-tree change (§CP: NO). It records the structure only; the code
change is a scoped follow-up (below).

## Rejected alternatives

- **Hoist `FateProvider` to the app root (the reporter's naive guess).** Rejected: the
  only client above the gate today is *none*; naively lifting the identity-keyed provider
  reintroduces exactly the #438 remount — mount under `"anon"`, re-key to the real id,
  wipe forms — the guard [`apps/web/src/main.tsx`](https://github.com/kamp-us/phoenix/blob/main/apps/web/src/main.tsx)
  documents removing for #2160.

- **One client, commit eagerly under `"anon"`, swap the cache in place on settle (drop
  the `key`).** Rejected on two grounds. First, the `key` also rebuilds the cache on
  logout so a prior session's data never leaks into the next — dropping it reopens that
  leak. Second, an in-place cache reset without a remount is **not** a react-fate
  capability we can ground in-repo (the cache is bound to the client instance; the
  FateProvider docblock is explicit), and asserting one would violate the repo's
  ground-platform-claims-in-source rule. Even if it existed, swapping the cache under a
  live subtree is the same anon→authed data-identity churn #438 avoids.

- **Optimistically paint the whole router under an anon client, reconcile on settle.**
  Rejected: this relaxes #438 **globally** — any controlled form mounted during the
  settle window (a deep-linked submit page mid-type) is wiped by the re-key remount.
  Scoping the eager paint to public **read** content (the chosen shape) keeps forms safe;
  a global relaxation does not.

- **Fix it via fate `defer` on the connection (the #2188 shape).** Rejected: distinct
  root cause. #2188 is a nested-connection defer-mechanism defect in the fate data seam;
  this is component-tree *placement* below `session.isPending`. Resolving the defer seam
  does not unblock a feed that structurally cannot commit until the gate clears.

## Consequences

- **Anon / cold first paint of `/pano` decouples from `get-session`.** The public feed
  fires `/fate` in parallel and paints on its own data arrival, regardless of session
  latency — the defense-in-depth win that survives any future `get-session` slowdown.
- **#438 preserved.** No re-key remount on the public path; the authed client's
  deferred-commit key guard is verbatim, so the no-controlled-form-wipe invariant holds.
- **Cost: a second fate client + cache on public routes.** A `Post` rendered for a
  signed-in viewer exists in two normalized caches (public shell in the public client,
  viewer scalars in the authed client). The public post fields and the viewer-scoped
  scalars become two read boundaries under two providers — this makes the fate
  loader/resolver / viewer-scoped-scalar seam explicit rather than implicit.
- **Live stays authed-only.** `/fate/live` 401s for anon, so the public client keeps the
  no-op live methods (`client.ts`); only the authed client below the gate subscribes.
  The CLAUDE.md fanout invariant is unchanged — a fanned mutation still publishes
  `/fate/live`, and anon cannot mutate.
- **Composes with #2160 and #711.** The public client lives inside the #2160 shell frame
  (which paints from `useSession` alone); the #711 app-lifetime live pin stays on the
  authed client below the gate.
- **Implementation is a scoped child, out of scope here.** A follow-up issue should
  decouple the `/pano` `PanoFeed` public first-paint from the session gate per this
  structure — the minimal version (mount the anon public client above the gate; bind the
  public feed list to it; keep viewer scalars on the authed client below), not a big-bang
  rewrite of every view. A coder/triage files it; this ADR does not implement it.

**Vocabulary impact:** coins **two-tier fate provider** (an eager, never-re-keyed
*public/anonymous fate client* above the session gate + the existing identity-keyed
*authenticated fate client* below it). Route the pair to
[`.glossary/TERMS.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/TERMS.md)
via `/glossary` as a follow-up; it is named here so it is not left implicit in prose.
