---
id: 0113
title: Draft-Private-to-Author Composes at the Pano Read Seam, Not the Shared Lifecycle Union
status: accepted
date: 2026-06-27
tags: [visibility, lifecycle, pano]
---

# 0113 — Draft-Private-to-Author Composes at the Pano Read Seam, Not the Shared Lifecycle Union

## Context

Epic [#1359](https://github.com/kamp-us/phoenix/issues/1359) unifies the visibility-masking rule into one seam every read surface routes through — search, landing-stats, draft-by-id, and profile-counts each re-derived the rule and several drifted. The target is one seam covering all four content states: **Live / Sandboxed / Removed / Draft-private-to-author**.

Three of the four already live in the shared substrate. `EntityLifecycle` ([ADR 0096](0096-uniform-soft-delete-substrate.md), extended by #1205) is a closed `Live | Sandboxed | Removed` union, projected from the `removed_*` + `sandboxed_at` columns carried on **every** content table (`definition_record` / `post_record` / `comment_record`). Its in-memory decision `isVisibleTo(lifecycle, authorId, viewer)` and SQL mirror `sandboxVisibleWhere(cols, viewer)` (`features/lifecycle/`) are the seam.

The fork this ADR resolves: **how does the fourth state, `Draft` (private-to-author), enter the seam — given `is_draft` exists only on `post_record` (a pano-only column), while `EntityLifecycle` is shared across all three content tables?**

Two candidate shapes:

- **(A) Fourth arm on the shared union.** Add `Draft` to the `EntityLifecycle` `TaggedEnum` and the `isVisibleTo` / `sandboxVisibleWhere` match. The seam is literally one type — but it forces the shared `LifecycleColumns` + `fromColumns`/`toColumns` (used by definition and comment reads too) to model `is_draft`, a column those tables don't have.
- **(B) Compose draft at the pano read seam.** Keep `EntityLifecycle` the 3-state shared core; model draft-private-to-author as a pano-local predicate layered on the shared decision — an in-memory `postVisibleTo(...)` wrapper + a SQL `postVisibleWhere(...)` beside `sandboxVisibleWhere`. The shared substrate stays clean; pano owns its extra state.

## Decision

**(B).** `EntityLifecycle` stays the closed 3-state union (`Live | Sandboxed | Removed`); it gains **no** `Draft` member. Draft-private-to-author is composed at a pano-local seam, layered on the shared lifecycle decision.

Two reasons make (B) decisive, not merely tidy:

1. **(A) makes an invalid state representable** — the precise thing `EntityLifecycle`'s design exists to prevent (ADR 0096: a closed union, not nullable-flag soup; "sandboxed-AND-removed is unrepresentable by construction"). `is_draft` is a `post_record` column; a draft `definition_record` / `comment_record` has no meaning and no column to hold it. Adding `Draft` to the shared union forces definition/comment `fromColumns` to project a state their table can't carry — reintroducing exactly the flag-soup the substrate banishes.

2. **Draft and Sandboxed have different viewer semantics**, so they are not members of one union. `Sandboxed` is visible to the author **or a moderator** (`canSeeSandboxed` — mods review the sandbox). `Draft` is private to the author with **no moderator exemption** — an unpublished draft is not moderation-relevant; no one but the author sees it. A single `match` arm cannot express both rules; composing two predicates does so honestly.

### The seam API

The shared core is unchanged (3-state), in `features/lifecycle/`:

- `isVisibleTo(lifecycle: EntityLifecycle, authorId: string, viewer: SandboxViewer): boolean`
- `sandboxVisibleWhere(cols: SandboxColumns, viewer: SandboxViewer): SQL | undefined`

The Phase-2 substrate child ([#1402](https://github.com/kamp-us/phoenix/issues/1402)) adds the pano-local composition layer, living with pano's read code (e.g. `features/pano/PostVisibility.ts`):

```ts
// in-memory — composes the shared decision with the author-only draft gate
postVisibleTo(
  lifecycle: EntityLifecycle,
  isDraft: boolean,
  authorId: string,
  viewer: SandboxViewer,
): boolean =
  isVisibleTo(lifecycle, authorId, viewer)
  && (!isDraft || viewer.viewerId === authorId); // draft: author-only, NO mod exemption

// SQL mirror — and()'d beside the caller's own isNull(removedAt), like sandboxVisibleWhere
postVisibleWhere(cols: PostVisibleColumns, viewer: SandboxViewer): SQL | undefined =
  and(
    sandboxVisibleWhere(cols, viewer),
    draftArm(cols.isDraft, cols.authorId, viewer), // !isDraft  OR  author_id = :viewerId
  );
```

where `PostVisibleColumns extends SandboxColumns { readonly isDraft: SQLWrapper }`, and the draft arm is:

- anonymous (`viewerId === null`) → `is_draft = 0`
- signed-in → `is_draft = 0 OR author_id = :viewerId`
- **no `canSeeSandboxed` branch** — the draft gate has no moderator exemption (the one place its SQL diverges from the sandbox arm's shape).

Every Phase-3 pano read surface (#1405 draft-by-id, #1407 landing counts, #1408 search, #1406 profile counts where they read posts) routes through `postVisibleTo` / `postVisibleWhere`. Non-pano surfaces (definition/comment reads) continue to route through the 3-state `isVisibleTo` / `sandboxVisibleWhere` directly — they have no draft dimension.

## Consequences

- **Easier:** the shared substrate stays minimal and honest — definition/comment reads never touch a draft concept; the "make invalid states unrepresentable" invariant of ADR 0096 holds unbroken. Draft's author-only-no-mod rule lives in exactly one pano-local place. The epic's intent ("a read surface cannot omit the mask") still holds: `postVisibleWhere` is the single canonical pano filter, composed from two predicates rather than one monolithic match.
- **Harder / cost:** the seam is two layers for pano reads (shared 3-state + pano draft arm), not one literal type — a reader must know pano composes. The substrate child (#1402) owns `postVisibleTo` / `postVisibleWhere`; every pano read must `and()` the draft arm in, and the visibility-matrix test must cover the draft × {anonymous, author, other-member, moderator} cells — including the **moderator-cannot-see-draft** cell that distinguishes draft from sandbox.
- **Banned:** adding a `Draft` member to `EntityLifecycle`, or any `is_draft` column / projection on `definition_record` / `comment_record`. Draft is a pano-only concept by construction.

Extends the ADR 0096 / #1205 lifecycle seam and the #1359 epic; supersedes nothing. The pano composition is the shape #1402 implements and #1405 / #1406 / #1407 / #1408 route onto.
