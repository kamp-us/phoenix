---
id: 0185
title: "`window.__BOOT__` carries the current user object — the boolean-only boot payload gains a typed `user: User | null` field so first-paint surfaces read identity synchronously (supersedes #2933's presence-only `signedIn` bit); amends ADR 0179"
status: accepted
date: 2026-07-16
tags: [frontend, performance, session, flags]
---

# 0185 — `window.__BOOT__` carries the current user object

Amends ADR [0179](0179-edge-resolved-shell-state-boot-contract.md) (the `window.__BOOT__`
edge-resolved shell-state contract). It records the founder ruling on
[#3030](https://github.com/kamp-us/phoenix/issues/3030), part of the edge-shell epic
[#2926](https://github.com/kamp-us/phoenix/issues/2926).

## Context

Under ADR 0179 the worker resolves shell state at the edge and injects `window.__BOOT__` so the
initial paint is already correct. Its payload was **boolean-only**: a `Record<BootMemberKey, boolean>`
of the three shell flag keys plus a `signedIn` presence bit (#2933). That presence bit is enough to
reserve the signed-in cluster's *geometry* and suppress the signed-out CTA, but the user's actual
*content* — name, handle, avatar, standing — still resolved asynchronously through `useMe`
(`apps/web/src/auth/useMe.ts`, a `/fate` `me` read). So even with `phoenix-edge-shell-boot` on, the
navbar cluster still soft-swapped its content in and pano's new-post CTA still popped in when the
session settled.

The remaining gap is specifically the **user object**. Flags already resolve synchronously (#2932);
`signedIn` already resolves synchronously (#2933). What first paint lacks is *who* the signed-in user
is, as a value it can read on frame one.

## Decision

`window.__BOOT__` carries the full current user as a typed field:

- The payload shape changes from boolean-only to `Record<ShellFlagKey, boolean> & { user: BootUser | null }`.
  `BootUser` is the wire `User` minus fate's transport-only `__typename` — the exact shape `useMe`
  exposes as `MeUser` — single-sourced in `apps/web/src/flags/shell-keys.ts` so the worker-injected
  object and the client-consumed object stay one type.
- The worker edge-injects the resolved user through the **same session→user resolution the `/fate`
  `me` view uses**. That resolution is factored into one shared `resolveMeUser`
  (`apps/web/worker/features/pasaport/trusted-user.ts`) that both the `me` query resolver and the
  shell-boot route call, so the boot payload and the `me` read can never describe the same user
  differently.
- The client reads it synchronously: `readBootUser()` (`apps/web/src/flags/boot.ts`) returns the
  user or `null`. `useMe` seeds its first-paint value from it and reconciles on session change; the
  navbar cluster (`apps/web/src/App.tsx`) and the pano CTA (`PanoSubnavCta`) read it directly, so
  identity renders on the first frame with no async read on the critical path.

### Scope is the user object only

The founder ruling bounds this deliberately: `__BOOT__` gains the **current user and nothing else**
— the one thing every first paint needs. No flag payloads are inlined, no below-the-fold data is
added. `user` is the single new field.

### `signedIn` is superseded by `user != null`

This supersedes #2933's presence-only `signedIn` boolean. The signed-in state is now derived from
`user != null`, so `signedIn` is removed from the boot member key set rather than kept as a second,
redundant source of the same fact. `BOOT_MEMBER_KEYS` is now exactly the shell flag keys; `user` is a
distinct typed field alongside them. The single-source drift check (ADR 0179 §3) continues to cover
the boolean flag keys — `user` is single-typed via `BootUser`, so it needs no key-set membership.

### The absent-`__BOOT__` fallback is unchanged

The optional-`__BOOT__` contract (ADR 0179 §4, #2931) carries forward as-is: when `__BOOT__` is
absent — the flag is off, or the never-hang fallback served the untransformed asset — `readBootUser()`
returns `null`, so `useMe` falls back to its async read and the surfaces render exactly as they do
today. The extra per-request user resolution sits inside the existing never-hang bound, so a slow or
failed resolve degrades to the untransformed asset rather than a hung or partial shell.

## Consequences

- First-paint identity is correct and content-complete for signed-in users: the navbar cluster and
  pano CTA no longer swap or pop in with the flag on.
- The `me` session→user resolution has one home (`resolveMeUser`), consumed by both the `/fate` query
  and the edge injection — the boot user and the reconciled `me` can't drift.
- The per-request boot resolve does more work (the user's canonical row + trusted standing reads) than
  the boolean-only version. It stays within the never-hang bound, which degrades to the untransformed
  asset on a slow resolve, so the worst case is the flag-off experience, not a regression.
- `MeUser` is now defined as `BootUser`, so the async `me` read and the synchronous boot seed carry
  identical fields by construction.
