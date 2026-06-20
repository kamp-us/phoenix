---
id: 0097
title: Account deletion is anonymize-to-`@[silinen]` — content kept and re-attributed, identity torn down, karma kept, one synchronous `account.delete` mutation
status: accepted
date: 2026-06-20
tags: [account, delete, anonymize, pasaport, karma, fate]
---

# 0097 — Account deletion is anonymize-to-`@[silinen]`, not hard-delete

## Context

Resolves #124 (account-deletion data semantics) and the #126 execution half. Builds directly on the uniform substrate of [0096](0096-uniform-soft-delete-substrate.md).

A user who deletes their account leaves behind authored content — definitions, posts, comments — that other users have read, replied to, voted on, and built threads around. Hard-deleting it all would tear holes in every conversation the user ever touched (orphaned reply chains, dangling quote context, vanished term definitions other definitions reference). Keeping it under the departed user's name misrepresents an active identity. The maintainer's decision: **tombstone / anonymize in place.** The content stays visible, re-attributed to a real sentinel user `@[silinen]` ("the deleted one"); the user's own identity rows are removed; their karma is kept (votes are not reversed).

Today there is no mechanism: better-auth's `deleteUser` is not enabled, the fail-open `/api/admin/*` routes were deleted, and the `@[silinen]` sentinel does not exist anywhere (only the comment-tombstone string `[silindi]` exists, which is a *content* placeholder, not a *user*). This ADR introduces `@[silinen]` as a real domain entity and `account.delete` as the one synchronous fate mutation that performs the anonymization.

## Decision

### 1. `@[silinen]` is a real, reserved sentinel user

A single, real row in `user` (and its `user_profile`) with a reserved, unregisterable username `silinen` and `type` carrying a reserved discriminant (a sentinel, not `human`/`bot`). It is seeded by migration, not creatable at runtime; `Pasaport.setUsername` rejects `silinen` as reserved (alongside the existing username rules). Re-attribution points authored content's `author_id` at this one row, so every piece of deleted-user content collapses to the same recognizable `@[silinen]` author across the whole site — a real entity with a profile page, not a null author the frontend must special-case. The display name is product copy (Turkish): `@[silinen]`.

### 2. Anonymization = re-attribute content + tear down identity, in one atomic batch

`account.delete` performs, for the calling user, in **one atomic D1 batch** (ADR 0014):

- **Re-attribute** every authored content row (`definition_view`, `post_summary`, `comment_view`) — `author_id := silinen`, `author_name := "@[silinen]"` (the denormalized author-name columns are overwritten so feeds render without a join). The content stays `Live`; this is re-attribution, not removal. Content the user had *themselves* already removed stays `Removed` with its existing audit, now re-attributed — its `removed_by` is left as the original actor (the audit of *who removed it* is not rewritten by anonymization; only authorship is).
- **Tear down identity rows** — delete the `user`'s identity-bearing rows: `session`, `account`, `apikey`, `verification`, and the user's own bootstrap fields. The `user` row itself is **kept but scrubbed** to a tombstone (email/name/image nulled, a `deleted_at` stamp set on the user) so foreign keys and the `author_id → silinen` redirect have a coherent world, and so the same email could re-register fresh later. Session/account/apikey already cascade off `user` in the schema; anonymization scrubs deliberately rather than relying on cascade-delete, because the `user` row is retained, not dropped.
- **Karma is kept.** No vote reversal, no karma decrement. The departed user's `user_profile` karma either rides along on the scrubbed tombstone or is folded into nothing — but critically, the **upvotes on their content are NOT reversed**, so the `@[silinen]`-attributed content keeps its scores and `term_summary` / `pano_stats` stay correct. This is the [0096](0096-uniform-soft-delete-substrate.md) karma-kept rule applied to the account boundary.

Stats/summary recomputes (`pano_stats` total-authors, `sozluk_stats`, `term_summary` author fields) run **outside** the batch as recomputable caches (ADR 0011/0096).

### 3. It is synchronous — no sweep infra invented

There is no scheduled-job substrate (ADR 0009 deferred Workflows/Cron) and we do not invent one. `account.delete` runs the whole anonymization **synchronously** inside the one mutation, on the request fiber, as a single batch. A user's authored-content volume is bounded by what one human posts; this is a normal-sized D1 batch, not a fan-out job. If a future user's volume ever outgrows a single batch, that is the point to revisit — not a reason to build a sweep queue speculatively now (ADR 0091: infra needs a real consumer).

### 4. Typed confirmation gate

`account.delete` is irreversible (anonymization can't be undone — the identity rows are gone). It takes a **typed confirmation token in its input Schema** — the mutation does not fire on a bare call. The confirmation is part of the input contract (a required field the client must populate from an explicit user action), so "deleted an account by accident / by a replayed request" is a validation failure, not a silent execution. `CurrentUser.required` gates it (a user can only delete *their own* account; there is no "delete user X" parameter — the target is always the caller, making "anonymize someone else" unrepresentable at this surface). Moderator-initiated account removal, if ever wanted, is a separate decision and a separate surface — out of scope.

## Alternatives rejected

- **Hard-delete the user and all their content (#124's rejected branch).** Rejected by the maintainer's decision and on the merits: it shreds every thread the user participated in and orphans reply chains. Anonymize-in-place is the world-class answer because it preserves the commons.
- **Re-attribute to a `null`/synthetic non-entity author.** Rejected: forces every read surface to special-case "no author," and gives the deleted-user's content no coherent identity. A real `@[silinen]` row means zero special-casing downstream — the same reason ADR 0096 models removal as a type, not a flag.
- **Reverse karma / wipe votes on the anonymized content.** Rejected: it would silently corrupt the scores of content that stays visible and disagree with the recomputed summaries — the ADR 0024 symptom again. Karma-kept (0096) is the coherent rule.
- **An async sweep job (Workflow/Cron).** Rejected as speculative infra (ADR 0009/0091): the workload fits one synchronous batch; building a queue first is buying the expensive solution for a problem we don't have.

## Consequences

- **The commons is preserved.** Deleting an account never tears a hole in a conversation; content lives on under `@[silinen]`.
- **A new seeded domain entity** (`@[silinen]`) the frontend renders like any author, with a reserved-username guard in `Pasaport.setUsername`.
- **better-auth's `deleteUser` stays disabled.** Account deletion is OUR domain operation (`account.delete`), not better-auth's, because it is an anonymize-and-re-attribute, not an identity drop — better-auth has no concept of re-attributing third-party content. No fail-open admin surface is reintroduced.
- **Irreversible by design** (unlike content removal in 0096, which restores). The typed-confirmation input is the guard; this asymmetry is deliberate and documented.
- **Migration cost:** seed the `@[silinen]` user + profile row; add a `deleted_at` (user tombstone) column to `user`. No content-table schema change beyond what 0096 already adds.
- **Surfaces touched:** `apps/web/worker/features/pasaport/` (new `account.delete` mutation + `Pasaport` anonymize method + reserved-username guard in `setUsername`), `apps/web/worker/db/drizzle/schema.ts` (`user` tombstone column + `@[silinen]` seed migration), `apps/web/worker/features/pasaport/better-auth-live.ts` (`deleteUser` stays off — note only), the per-feature author-name denormalization in `sozluk`/`pano` shapers.
