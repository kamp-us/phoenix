---
id: 0098
title: Report moderation — a server-managed `moderator` role read as a `Moderator.required` capability, a report resolution state machine, act-on-target via the soft-delete substrate, full audit
status: accepted
date: 2026-06-20
tags: [moderation, auth, role, report, state-machine, audit, pasaport]
---

# 0098 — Report moderation: the `moderator` capability + resolution lifecycle

## Context

Resolves #155 (moderation gate) and #156 (resolution lifecycle). Builds on the uniform substrate of [0096](0096-uniform-soft-delete-substrate.md).

The capture half of reporting already shipped (#151–154 closed): `report.submit` is a live fate mutation, the bildir buttons are wired, a `content_report` row persists born `status='open'`, idempotent on the composite PK, and `Report.submit` already refuses a soft-deleted target via `assertTargetLive` (`Report.ts:66`). The "inert bildir buttons" premise of #82/#155/#156 is stale. What is missing is everything *after* a report lands: who may act, what acting means, and what a resolved report records.

Two non-negotiables shape the decision:

1. **The gate must be a real server-managed role, not an env allowlist.** An `ENVIRONMENT`-gated allowlist is exactly the fail-open shape this repo deleted (the `/api/admin/*` routes). Moderator authority must be persisted, server-managed, and read as a domain capability that makes "acted without authority" untypeable — modeled like `CurrentUser.required`, not an `if (isMod)` branch.
2. **Acting on a target must reuse the substrate**, not invent a moderation-specific delete. A moderator removing content produces a `Removed(Moderated({reportId}))` via [0096](0096-uniform-soft-delete-substrate.md) — reversible, audited, karma-kept — so a wrong moderation can be restored and every removal traces to its report.

The precedent for a server-managed, not-user-input role already exists: `user.type` (enum `["human","bot"]`, default `human`) is in D1 but dormant (zero reads — `schema.ts:22`), and better-auth's `additionalFields` already carries a server-only `username` with `input:false` (`better-auth-live.ts:93`). That is the shape a `moderator` flag follows.

## Decision

### 1. A server-managed `role` on `user`, never user-writable

Add a moderator capability to `user` as a **server-managed field** following the `user.type` / `input:false username` precedent: a `role` column declared as a closed enum — `role: text("role", {enum: ["member","moderator"]}).notNull().default("member")` on the `user` table (`schema.ts:17`) — declared to better-auth as an `input:false` `additionalField` alongside `username` (`better-auth-live.ts:93`), and granted only by a server-side path: an **offline D1 grant script** (a karma/künye-gated promotion may follow later).

> Amended by [ADR 0102](0102-admin-via-better-auth-plugin.md): the direct-D1-only grant path (the offline grant script) is superseded by the authenticated better-auth admin-plugin API mounted on the worker, surfaced through the `kampus admin role set …` CLI verb; the rest of this ADR stands.

This column is the moderation MVP — it is reconciled onto the platform's role/AC model under [#873](https://github.com/kamp-us/phoenix/issues/873) when the admin plugin + admin dashboard are built. There is **no runtime endpoint** that writes it. The `input:false` declaration means no client write can reach it. It is *not* carried in the session's `CurrentUserInfo` (which stays the minimal id/email/name/image — `CurrentUser.ts:31`); per the CLAUDE.md rule, richer reads go through a domain service. Authority is read from D1 at the point of use, not trusted from session state.

### 2. `Moderator.required` — a capability that makes acting-without-authority untypeable

Mirroring `CurrentUser.required` (`CurrentUser.ts:66`), authority is a derived Effect over a domain service, not an `if`:

```
Moderator.required : Effect<ModeratorIdentity, Unauthorized | NotAModerator, Pasaport>
```

It reads the caller's `role` from D1 (through `Pasaport`, the identity service) and either yields a `ModeratorIdentity` token or fails with a tagged error (`Unauthorized` if anonymous, `NotAModerator` if authenticated-but-not). A moderation mutation `yield*`s it; the requirement appears in `R` (the service that resolves the role) and the failure in `E`. This is the phoenix-local `*.required` idiom — composed, per effect-smol grounding, from §Context.Service (a service with no default, so the only way to obtain the token is to pass the check) + a `Schema.TaggedErrorClass` failure in `E` + dying on infra (`orDieAccess`, ADR 0011) so `R` carries only `Pasaport`. There is no code path that performs a moderator action without first discharging `Moderator.required`; "moderated without being a moderator" does not typecheck. `NotAModerator` carries no wire `FateWireCode` that distinguishes it from not-found where that would leak the moderation surface — it encodes as the same `UNAUTHORIZED`/not-found the client already handles, so the moderation queue is invisible to non-moderators.

### 3. The report resolution state machine

`content_report.status` becomes a closed state machine, modeled as a `Schema.Literals` set with transitions handled by `Match.tagsExhaustive` (effect-smol `Match.ts:1095` — a missing transition is a compile error), so an illegal transition is unrepresentable:

```
open ──assign──▶ open            (claimed by a moderator; optional)
open ──resolve(removed)──▶ resolved   (target removed via substrate)
open ──resolve(dismissed)──▶ dismissed (no action; report was unfounded)
resolved ──reopen──▶ open         (a restore re-opens; bounded)
dismissed ──reopen──▶ open
```

Terminal states (`resolved`, `dismissed`) are reached only through a moderation mutation that has discharged `Moderator.required`. A resolution records its **decision** (`removed` vs `dismissed`) and, when `removed`, links the `Removed(Moderated({reportId}))` it produced. Because the report carries the originating `report_id` into the entity's removal reason and the entity's removal links back to the report, the two are mutually traceable — a restored entity (ADR 0096) can `reopen` its report, and the loop is closed and bounded.

### 4. Audit columns are mandatory

`content_report` gains `resolver_id` (the moderator's `user.id`), `resolved_at` (timestamp), and `resolution` (the decision: `removed` | `dismissed`). A `resolved`/`dismissed` report is **uninhabitable without** all three — the state machine's terminal transition is the only writer, and it always stamps them. "Resolved but we don't know who decided or what they decided" is unrepresentable. This mirrors the [0096](0096-uniform-soft-delete-substrate.md) `removedAt`/`removedBy`/`reason` triad on the content side; the report side and the content side each carry their own complete audit, and the `reportId` link ties them.

### 5. Repeat-offender signal comes free

The reverse index `content_report_target` on `(target_kind, target_id)` already exists (`schema.ts:411`), so "how many distinct reporters flagged this target" is a free count — the repeat-offender / pile-on signal the moderation queue surfaces, with no new index. The moderation **read** path (the queue: open reports, grouped by target, with report counts) is a `Moderator.required`-gated query over `content_report` + its reverse index; it is private moderation state with no live view (the `Report` service's existing posture).

### 6. Acting on the target reuses the substrate

A moderator's "remove this content" is **not** a moderation-specific delete. It calls the [0096](0096-uniform-soft-delete-substrate.md) removal primitive with `RemovalReason = Moderated({reportId})`, which soft-deletes (reversible), wipes votes via `Vote.clearTarget` (karma KEPT), and stamps `removed_by = resolverId`. A wrongful removal is restored by the same substrate, which `reopen`s the report. The moderator never touches a content table directly.

## Alternatives rejected

- **An `ENVIRONMENT`-gated moderator allowlist.** Rejected — it is the deleted fail-open `/api/admin/*` shape: an env var is not a per-user capability, can't be granted/revoked at runtime, and reads as a config branch rather than a typed authority. This is the exact anti-pattern #155 names.
- **better-auth's `admin` (access-control) plugin `role` field.** Deferred to the admin-dashboard initiative ([#873](https://github.com/kamp-us/phoenix/issues/873)) — at v1.6.10 the plugin is indivisible: enabling it for its `role` column also mounts `ban-user`/`remove-user`/`impersonate-user`/`set-user-password` (15 `/admin/*` endpoints) and adds `banned`/`banReason`/`banExpires`/`session.impersonatedBy`. Those act on the `user`/`session` tables *outside* the ADR 0096 substrate §6 mandates, and re-introduce exactly the broad privileged-endpoint surface the deleted `/api/admin/*` routes were removed to avoid. For the moderation MVP we need one server-managed bit read from D1 — a plain `input:false` column on `user`, the `user.type`/`username` shape, delivers that with zero new endpoints. The custom column is the deliberate, right-sized moderation MVP, not a permanent rejection of the platform: #873 tracks enabling the admin plugin + building an admin dashboard for full user administration, and will reconcile this `role` column onto the platform's role/AC model when that lands.
- **`if (user.isModerator) { ... }` inline checks.** Rejected: it scatters the gate across every mutation, makes "forgot the check" a silent omission rather than a compile error, and trusts a session field. `Moderator.required` makes the check structural and unbypassable, the way `CurrentUser.required` already does for auth.
- **A free-text `status` string / open enum on `content_report`.** Rejected: it permits illegal transitions (`dismissed → resolved`), can't be exhaustively handled, and carries no decision/audit by construction. The state machine + mandatory audit columns make the resolution lifecycle a type, not a convention.
- **A moderation-specific hard-delete of reported content.** Rejected: irreversible (a wrong call is unrecoverable), unauditable, and reverses karma — it violates every property [0096](0096-uniform-soft-delete-substrate.md) exists to provide. Acting-via-substrate is the only world-class option.

## Consequences

- **Real, revocable, server-managed moderator authority**, read as a capability that can't be bypassed — `if (isMod)` is banned in moderation code the way the env allowlist is banned.
- **A complete, traceable resolution lifecycle:** every resolved report names its resolver, time, and decision; every moderated removal links its report; restore reopens. No moderation action is anonymous or untracked.
- **Zero new abuse surface:** the moderation queue and `NotAModerator` are invisible to non-moderators; the gate fails closed.
- **The `role` column is the moderation MVP, not the end-state:** it deliberately ships one server-managed bit with zero new endpoints, and is reconciled onto the platform's role/AC model under [#873](https://github.com/kamp-us/phoenix/issues/873) (enable the better-auth admin plugin + build an admin dashboard for full user administration).
- **Migration cost:** add the `role` enum column to `user` with `input:false`; add `resolver_id` + `resolved_at` + `resolution` to `content_report`; widen `status` to the closed state set. The reverse index already exists. No new index for the repeat-offender signal.
- **Surfaces touched:** `apps/web/worker/db/drizzle/schema.ts` (`user.role`, `content_report` audit columns + status set + migration), `apps/web/worker/features/pasaport/Pasaport.ts` + `better-auth-live.ts:93` (role read + `input:false` field, `Moderator.required`), `apps/web/worker/features/report/Report.ts` + `mutations.ts` + `views.ts` + `sources.ts` (resolution mutations, moderation queue query, state machine), the [0096](0096-uniform-soft-delete-substrate.md) removal primitive (consumed with `Moderated` reason), `CurrentUser.ts:66` (the `*.required` idiom this mirrors).
