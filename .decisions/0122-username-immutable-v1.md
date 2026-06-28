---
id: 0122
title: Username stays immutable under v1 — a deliberate set-once @handle, not a changeable field
status: accepted
date: 2026-06-28
tags: [pasaport, username, identity, v1]
---

# 0122 — Username stays immutable under v1

## Context

Issue [#1177](https://github.com/kamp-us/phoenix/issues/1177) is the forcing decision, filed as the
follow-up to [#1155](https://github.com/kamp-us/phoenix/issues/1155) (PR #1176, merged): now that the
`username` (`/u/<ad>`) is a **deliberate choice at signup** rather than an email-derived default chosen
in a post-signup bootstrap, should it **stay set-once immutable**, or should users get a constrained
change path?

The immutability was designed when the handle was *inherited* — a default most users accepted without
choosing. #1155 changed that premise: a user now picks their handle up front. #1177 asks whether a
*deliberately-chosen* handle should still be permanently locked.

Current behavior, verified against source:

- **Server set-once guard** — `apps/web/worker/features/pasaport/Pasaport.ts`, `Pasaport.setUsername`
  (~L564–575): it normalizes (`trim().toLowerCase()`) + `assertUsername`-validates (length 3–30,
  lowercase `[a-z0-9-]`, reserved-handle check), then **rejects any re-set** — `if (existingUser.username)`
  returns `UsernameAlreadySet` ("kullanıcı adı zaten ayarlandı; değiştirilemez"). Collisions return
  `UsernameTaken`. There is **no other username-write path** in the service.
- **Error type** — `UsernameAlreadySet` (tag `pasaport/UsernameAlreadySet`) in
  `apps/web/worker/features/pasaport/errors.ts`.
- **Profile UI** — `apps/web/src/pages/ProfilePage.tsx` renders the username as a static
  "değiştirilemez" row, no input.
- **Shared validation rule** — `apps/web/worker/features/pasaport/username-rule.ts` (introduced by #1155
  / PR #1176) is the one rule set both signup and `setUsername` honor.

The design space #1177 surfaced, if changeability were granted: a one-time lifetime change; a cooldown
window; or free change with a `/u/<old>` → `/u/<new>` redirect plus reserved-old-handle to block
squatting. A change-flow also interacts with identity/karma (künye,
[#141](https://github.com/kamp-us/phoenix/issues/141)) — handle mutability has downstream
attribution/reputation implications.

Per [ADR 0078](0078-product-driven-decisions-by-default.md) this is a product/UX policy call.

## Decision

**Keep `username` IMMUTABLE for v1.** It stays a **deliberate, set-once @handle** chosen at signup
([#1155](https://github.com/kamp-us/phoenix/issues/1155)) and permanently locked thereafter —
`Pasaport.setUsername` continues to reject any re-set with `UsernameAlreadySet`, and the profile UI
keeps rendering it read-only ("değiştirilemez").

This is the **status quo** — zero behavior change. No code moves; the current
`apps/web/worker/features/pasaport/Pasaport.ts` guard, the `UsernameAlreadySet` error, and the read-only
`ProfilePage.tsx` row already implement this decision.

Why keep it immutable:

- **A stable @handle simplifies identity.** Mentions, profile URLs (`/u/<ad>`), and attribution all key
  off the handle; a permanent handle keeps `/u/<ad>` links stable, blocks handle-squatting, and adds
  zero new surface.
- **It is now a deliberate choice, which makes permanence defensible, not arbitrary.** Post-#1155 the
  user picks the handle up front rather than inheriting an email-derived default — so locking a chosen
  handle is honoring a decision the user made, not trapping them in one they never made.
- **Changeability is an additive feature, not a v1 need.** Granting a change path reopens
  squatting/link-rot risk that must be *designed around* (redirect + reserve + the identity/karma
  interaction with künye, [#141](https://github.com/kamp-us/phoenix/issues/141)). That is post-launch
  product work, not a v1 requirement — nothing is broken by keeping the handle locked.

## Consequences

- **Username stays set-once immutable under v1.** The server guard, the `UsernameAlreadySet` error, and
  the read-only profile row are the recorded v1 behavior — #1177 closes on this decision with no code
  change.
- **No signup-time "permanence" affordance in scope here.** Whether to add an explicit "this is
  permanent" affordance at signup (so the permanence is *informed*) is left out of scope for this ADR; a
  follow-up can be filed if it's wanted.
- **A change-username flow is an additive post-launch feature.** If users ask for it after launch, file
  it as a separate feature — and it must carry the design space #1177 named (one-time / cooldown /
  redirect+reserve) plus the anti-squat and identity/karma (künye,
  [#141](https://github.com/kamp-us/phoenix/issues/141)) implications. This ADR does not foreclose that;
  it scopes immutability to v1.
- **v1-conservative ratification under delegated authority.** This decision was recorded under delegated
  authority while the maintainer was AFK; it ratifies the current behavior for v1 and is **open to
  maintainer override or supersede on review**. It is reversible by design.
