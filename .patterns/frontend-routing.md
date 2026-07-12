# Frontend routing

How the SPA's route tree is shaped, and the standing `/lab/*` convention for
in-product experiment/prototype routes.

## The route tree

`apps/web/src/App.tsx` owns the react-router `<Routes>`/`<Route>` tree. Every route
mounts under one shared `<Route element={<Layout />}>` parent, so the AppShell frame
(Topbar / `Main` / Footer) renders once and the routed page fills the `Outlet`. Page
components live in `apps/web/src/pages/` — one file per screen (`PanoFeed`,
`SozlukHome`, `SearchPage`, …). Paths are technical identifiers, so they are English
and lowercase kebab-case even where the product noun they serve is Turkish
(`/sozluk`, `/pano`, `/bildirimler`).

Routes fall into two visibility classes:

- **Public product routes** — mounted plainly, live for everyone (`/pano`, `/sozluk`,
  `/search`, `/u/:username`).
- **Dark feature routes** — mounted behind a flag the page self-gates on (off ⇒ 404):
  `/divan`, `/funnel`, `/bildirimler`. These ship dark by default and a human flips
  the flag to release them (the agents-deploy / humans-release contract, ADR 0083).

`/lab/*` is a third, deliberately-public class — see below.

## Per-product Subnav zones — nested layout routes

Each product (`/sozluk`, `/pano`, `/mecmua`, `/divan`) mounts its routes under a
**pathless per-product layout route** whose element is
[`ProductSubnavLayout`](../apps/web/src/components/layout/ProductSubnavLayout.tsx) — it
renders the product's persistent `<Subnav>` zone above the routed `<Outlet>`, so the zone
stays mounted as the user moves within `/<product>/*` (placement law #2587, epic #2596).
This is the representable form of "every product's primary affordance lives in its product
zone": the `Subnav`'s **`cta` slot** is the ratified home for a product's *primary-action*
class element (e.g. `pano/yeni`), styled with the sanctioned primary-action treatment (the
`Button` primitive's `primary` variant), never the utility filter/tab treatment.

Two properties make the nesting safe to layer over the flat tree:

- **A pathless layout route is transparent to matching.** React Router ranks routes by
  path specificity, not source order, so grouping a product's routes under a layout route
  changes only *what renders above them*, never *which* route matches. The existing
  ordering notes (static `/mecmua/yaz` out-ranking `/mecmua/:slug`) still hold unchanged.
- **The whole surface rides the default-off `phoenix-nav-ia` seam.** `App.tsx` reads
  `useFlag(PHOENIX_NAV_IA, false)` and wraps each product's routes under
  `ProductSubnavLayout` only when on; off ⇒ the router is flat, exactly as before (the
  agents-deploy / humans-release contract, ADR 0083). The per-product delta children
  (#2600–#2604) fill each zone's destinations / filters / CTA.

## `/lab/*` — the standing prototype space

`/lab/*` is a **durable, kept** home for in-product experiments and prototypes. It is
**not** per-spike throwaway: every future spike gets a discoverable, felt place to live
instead of being conjured and torn down each time. Mount a prototype as `/lab/<name>`
under the same `<Layout />` parent as any other route.

**Visibility: PUBLIC — the load-bearing rule.** `/lab/*` routes ship live to all users
and are discoverable in production. There is **no `ENVIRONMENT` dev-gate and no
`phoenix-*` dark-flag gate** on a lab route — this is the explicit inverse of the dark
feature routes above. The convention is kampus spirit: open, transparent, dogfooded in
the open. A lab route is reachable by anyone who navigates to it, the same as `/pano`.
(This does not weaken per-*action* authorization — a prototype that writes still gates
its writes on the actor the same way any surface does; it is the *route's reachability*
that is public.)

### Naming and nesting

- **Flat `/lab/<name>`**, lowercase kebab-case, English (a technical path). One segment
  names the prototype (`/lab/composer`).
- A lab surface with its own sub-navigation nests under its segment
  (`/lab/<name>/<sub>`), exactly as `/pano/:id` nests under `/pano` — the `/lab/`
  prefix is the only added namespace.

### Lifecycle

A `/lab/<name>` route is **kept by default** once it lands. Two exits, both a
product-owner call (product-driven, ADR
[0078](../.decisions/0078-product-driven-decisions-by-default.md)):

- **Graduate** — a prototype that earns a permanent home moves out of `/lab/` to a
  first-class product path (its page component and route move; the `/lab/` alias is
  dropped or redirected).
- **Cull** — an abandoned prototype's route and page are deleted.

Until one of those happens the route stays mounted and public under `/lab/`. The
default is *keep*, not *delete* — the space exists precisely so a prototype can persist
and be felt rather than vanish after one session.

### First inhabitant

**`/lab/composer` (#2465)** — the tiptap composer — is the first kept public route under
this convention (opened as PR
[#2472](https://github.com/kamp-us/phoenix/pull/2472)). It is a durable inhabitant of
the standing space, not deletable scaffolding: publicly visible, kept, and prototyping
toward the mecmua long-form publishing arc (#2467).
