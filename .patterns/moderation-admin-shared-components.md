# moderation/admin shared components — reuse the shared layer, don't fork a parallel tree

How every **moderation/admin surface** — the divan, the admin surface
([#873](https://github.com/kamp-us/phoenix/issues/873)), any future mod tooling — renders its
cross-surface primitives (the **actor/user row**, **action affordances**, **audit context**) from
**one shared component layer** rather than reimplementing them per surface. This is the
[ADR 0147](../.decisions/0147-shared-moderation-admin-component-layer.md) rule made concrete: the
map to consult when building or extending any mod/admin UI.

The *why* (the founder directive, the drift it prevents) is in ADR 0147; the actor-centric spine
these surfaces share is [ADR 0138](../.decisions/0138-divan-actor-centric-spine.md). This doc is
the *where + how*.

## Where the shared primitives live

`apps/web/src/components/moderation/` is the canonical home for the surface-agnostic mod/admin
primitives. Each file is presentational + pure-testable:

| Primitive | File | What it is | Consumers |
|---|---|---|---|
| **actor/user row** | `ActorIdentity.tsx` + `actorIdentity.ts` (`actorLabel`) | An actor's handle + karma-on-others, rendered through the reusable `<Karma>` atom (#1208); the label resolved DOM-free by `actorLabel` (display name → `@username` → surface fallback noun) | divan roster + çaylak-detail (via `CaylakIdentity`); the admin user-list (#968) next |

The table grows as each real second consumer lands (see "Extract on the second consumer" below):
the **action affordances** (a confirm-before-act row like divan's `VouchSheet`/remove verdict) and
**audit context** are the next primitives the admin ban/unban (#970) and impersonation (#971)
children will share out of divan.

## The shape: shared primitive + thin per-surface wrapper

A shared primitive is **presentational and surface-agnostic**: it takes already-resolved fields
(no per-surface data coupling, no fate-client read) and keeps its markup namespace open via
class + test-id props. A surface that needs its own CSS namespace or copy supplies those as a
**thin wrapper** over the shared render — never a re-implementation.

Worked example — divan's `CaylakIdentity` (the first consumer):

```tsx
// apps/web/src/components/divan/CaylakIdentity.tsx — divan-flavoured wrapper
import {ActorIdentity} from "../moderation/ActorIdentity";

export function CaylakIdentity({authorId, displayName, username, totalKarma, showKarma = true}) {
  return (
    <ActorIdentity
      authorId={authorId}
      displayName={displayName}
      username={username}
      totalKarma={totalKarma}
      showKarma={showKarma}
      fallbackLabel="çaylak"                  // divan's fallback noun
      identityClassName="kp-divan__identity"  // divan keeps its CSS namespace
      handleClassName="kp-divan__handle"
      karmaClassName="kp-divan__karma"
      karmaTestIdPrefix="divan-karma-"
    />
  );
}
```

The shared `ActorIdentity` owns the handle+karma render; divan supplies its namespace/fallback.
divan's pure `caylakLabel` is now `actorLabel(displayName, username, "çaylak")` — one tested handle
resolver, the çaylak noun over it.

## How a new mod surface consumes the layer (the admin user-list, #968)

The admin user-list is the **second consumer** and the reason this layer exists. It does **not**
build a new user-row tree — it renders the shared `ActorIdentity` with its own namespace:

```tsx
// admin user-list row — reuse, don't fork
<ActorIdentity
  authorId={user.id}
  displayName={user.displayName}
  username={user.username}
  totalKarma={user.totalKarma}
  fallbackLabel="kullanıcı"               // admin's fallback noun
  identityClassName="kp-admin__identity"  // admin's own namespace
  handleClassName="kp-admin__handle"
  karmaTestIdPrefix="admin-karma-"
/>
```

This makes the AC on #873's children enforceable: **#968/#970/#971 reuse the shared `moderation/`
components** (actor row now; action affordance + audit context as they're extracted) rather than
growing a second tree. "Scope #968 against divan's existing render" is a checkable criterion, not
an advisory note.

## The reuse-don't-fork rule

- **Need an actor/user row, action affordance, or audit context on a mod/admin surface?** Reuse the
  shared `moderation/` component. If it doesn't yet expose what you need, **extend the shared
  primitive** (add a prop, factor a new shared piece) — never fork a parallel copy into your surface.
- **Keep shared primitives presentational + pure-testable.** Fields in, no per-surface fetch; the
  label/verdict/gating decision factored DOM-free (the `actorLabel` / `flagGateChild` idiom, since
  `apps/web/src` has no jsdom for pure files) with a unit test, plus a jsdom render test in the
  `client` tier for the component itself.
- **A surface keeps its identity via props, not markup forks:** class + test-id tokens for its CSS
  namespace and test handles; the shared render stays one source.

## Extract on the second consumer

Don't pre-build an exhaustive shared kit. Seed the layer with the primitive a real second consumer
provably overlaps (the actor row, seeded from divan for #968), and **extract the next primitive
when its second consumer lands** — the `.patterns/index.md` "used in 2+ places" bar, applied to
components. The extraction preserves the first consumer's behavior exactly (divan's render is
byte-identical post-extraction); it is a refactor, never a redesign.
