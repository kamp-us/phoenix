# çaylak content containment — the sandbox seam across write paths

How new content from a **çaylak** (the unproven authorship tier — see
[`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md)) is held out of public view until a
moderator/yazar signal promotes it, and where that containment does and does not reach.
This is the map to consult when adding **any** new çaylak-reachable write path: decide up
front whether the path needs to route through the sandbox seam, and if not, why it is
inert.

The containment mechanism itself (the flag gate, the `PublishDecision` brand, the
sandbox-aware read predicates) lives in `apps/web/worker/features/kunye/sandbox.ts` and
`apps/web/worker/features/lifecycle/` — read those for the *why*; this doc is the
*where*: the surface it covers, path by path.

## The seam, in one paragraph

A çaylak-authored content row is created **Sandboxed** (`sandboxed_at` set) when the
`PHOENIX_AUTHORSHIP_LOOP` flag is on (`sandboxedAtForAuthor`,
`apps/web/worker/features/kunye/sandbox.ts`; flag-off / yazar ⇒ Live, zero regression).
Two things then keep a sandboxed row out of public view: the **read** paths filter it
(`sandboxVisibleWhere` / `isVisibleTo`, `apps/web/worker/features/lifecycle/SandboxVisibility.ts`
— anonymous/non-author see `sandboxed_at IS NULL` only), and the **create-time live
broadcast** is suppressed by routing every node fan-out through a `PublishDecision`
(`decidePublish(sandboxedAt)`), because the fate-live topics are viewer-blind (ADRs
0023/0025/0037) and would otherwise leak a full-payload frame to every subscriber (#1205,
#1280). Author and moderators still reach the content through the sandbox-aware read paths
and the divan promotion backlog.

## Containment map — every çaylak-reachable write path

| Write path | Mutation(s) | Containment | State |
|---|---|---|---|
| Post create | `post.submit` | `sandboxedAtForAuthor` → row Sandboxed; broadcast via `decidePublish` | **Contained** |
| Definition create | `definition.add` | same | **Contained** |
| Comment create | `comment.add` | `sandboxedAtForAuthor` → comment Sandboxed; thread broadcast via `decidePublish`; `commentCount` bump suppressed when sandboxed | **Contained** |
| Post/definition/comment **edit** | `*.edit` | edit updates body/title, never touches `sandboxed_at`; a sandboxed row stays sandboxed; the single-entity `*.update` topic is keyed by an id a non-author never received (the create broadcast was suppressed), so no non-author subscriber exists | **Inert** |
| Post/definition/comment **delete** | `*.delete` | own-content only (`author_id === actor_id`); removes to `Removed` | **Inert** (own content) |
| Bookmark | `post.save` / `post.unsave` | private to the acting user; no public effect, no karma | **Inert** (private) |
| Vote (any target) | `post.vote` / `comment.vote` / `definition.vote` | `Vote.cast` gates on **target** liveness only, never the **voter's** tier | **Gap — see #1810** |
| Delete → restore | `*.delete` then `*.restore` | delete clears `sandboxed_at`; `restore : Removed → Live` unconditionally, broadcasting `alwaysLive` | **Gap — see #1811** |

**Verdict on "are çaylak comments sandbox-inert?": yes.** `comment.add`
(`apps/web/worker/features/pano/mutations.ts`) routes through `sandboxedAtForAuthor` exactly
like `post.submit` / `definition.add`, and its live thread broadcast is gated by
`decidePublish(sandboxedAt)`, so a çaylak's comment lands sandboxed and does not fan out to
non-author/anonymous subscribers. Sözlük has no comment surface — its only content is the
definition.

## The two gaps (tracked, not fixed here)

The seam contains çaylak-**authored** content at create, but two paths reach live effect
without a tier gate. Both are design calls (not mechanical fixes), filed as residue for
triage by the #1705 investigation:

- **Votes are voter-tier-blind** — [#1810](https://github.com/kamp-us/phoenix/issues/1810).
  `Vote.cast` rejects a sandboxed *target* but never checks the *voter*, so a fresh çaylak
  can score live content and credit an author's global karma (ADR 0050), including across
  the çaylak→yazar promotion bar (#1288/#1289). Under open registration this is a
  score/karma-manipulation surface with no rate limit.
- **Sandbox escape via delete→restore** — [#1811](https://github.com/kamp-us/phoenix/issues/1811).
  `*.delete` clears `sandboxed_at` (stamps `Removed`) and `*.restore` returns `Live`
  unconditionally with an `alwaysLive` broadcast, so a çaylak can publish their own content
  live by deleting then restoring it — bypassing the sandbox for all three content types.

When adding a new çaylak-reachable write path, place it in the table above: contained via
the sandbox seam, inert (private / own-content / no public topic), or a new gap to file.

## The read side's blind spot — derived summary rows

`sandboxVisibleWhere` / `publicLiveWhere` mask a **content** table, keyed off the
`sandboxed_at` / `removed_at` / `author_id` columns the row itself carries. A **derived
summary** row has none of them: `term_record` is a recomputable aggregate of a term's
definitions (ADR 0011), so nothing on it says "this term is sandboxed" — yet the row is
created, and its user-authored `title` becomes readable, the moment a çaylak writes their
first definition. A list that selects the summary table directly is therefore **unmasked by
construction**, even in a codebase where every content read is masked (#3724: a newcomer's
term reached the top of the anonymous /sozluk list and its page rendered zero definitions —
a dead-end public page *and* a title-level containment leak).

The rule: **a read over a derived summary table derives its visibility from the content it
summarizes, viewer-aware** — an `EXISTS` over the content table carrying `publicLiveWhere`
for the requesting viewer, applied to the page query **and** any `count(*)` beside it, so an
author still finds their own not-yet-public row. Both sözlük term lists take this shape:
`termHasVisibleDefinitionWhere` (`apps/web/worker/features/sozluk/TermVisibility.ts`) for
the paginated lists, and the live-definition ranking inside `Sozluk.getLandingTerms` for the
landing column.

When adding a read over any table whose rows are *derived* rather than authored, ask which
content table owns its lifecycle, and mask through that.

## A gated read still has to say who it is

Passing no viewer is not neutral, and every masked Pano/Sözlük read now refuses to let you:
their options carry `MaskedReadOptions` (`apps/web/worker/features/lifecycle/SandboxVisibility.ts`),
a **required** resolved `sandboxViewer`, so omitting it is a compile error rather than a
silent read *as the public*. Anonymity is still available — you write
`sandboxViewer: anonymousViewer`, which is the RSS feed's and the landing feed's deliberate
answer — but you have to say it.

That refusal exists because the omission's failure mode is invisible: the row is simply
absent, and the caller renders whatever it renders for "missing". A write's own re-read is
where that hurt most — the mutation committed at D1, then its masked re-read dropped the row
and the handler answered `null` or `*NotFound` (#6473, #6424, #6586).

The trap the type cannot close is a read that already sits behind an authority gate. Being inside a
`Moderate`-gated resolver does nothing for the mask; the SQL only widens for a viewer that
carries `canSeeSandboxed`. The moderation report queue spent six reads this way (#6472): the
`Moderate` grant was discharged, the reads passed no viewer, and every reported çaylak item —
the ones the sandbox exists to make reviewable — rendered with a null excerpt and no link.

Inside such a path, take the viewer off the grant:

```ts
const sandboxViewer = yield* moderatorSandboxViewer; // requires Moderate in R
const rows = yield* pano.getPostsByIds(ids, {sandboxViewer});
```

`moderatorSandboxViewer` (`apps/web/worker/features/kunye/sandbox.ts`) puts `Moderate` in `R`,
so a path that never proved moderation authority cannot build the viewer that claims it. Use
`currentSandboxViewer` instead only on an **ungated** read — it probes the moderation gate and
collapses a denial to `false`, which inside a gated path is a second relation-store round trip
for an answer the grant already carries.

Two dimensions stay out of this. `removed_at` is orthogonal: the by-id reads carry their own
`isNull(removedAt)`, which takes no viewer, so widening the sandbox viewer never surfaces a
removed row. And the draft arm has no moderator branch at all (ADR 0113) — an unpublished
draft is private to its author, moderators included.

Widening the read does not widen the broadcast. `decidePublish(sandboxedAt)` still gates every
node fan-out, so a still-sandboxed target that now comes back off a moderator read reaches that
gate and is suppressed there, which is where the #1205/#1280 decision belongs — not in a read
that was masking it by accident.

## The client side — one badge per item, owner's wins

Once an opted-in yazar can meet sandboxed content in place (#6423), two wire fields describe
the same row to different people: `sandboxed` (#2200) is owner-scoped and means "your item is
in review", `sandboxedInPlace` (#6425) is reader-scoped and means "this is a çaylak's
hazırlık-stage work". They are true for disjoint viewers on almost every row — but not all: a
çaylak promoted to yazar who opts in reads both true on their own not-yet-promoted content.

So the client picks between them rather than rendering both. `sandboxMarker`
(`packages/design/src/sandbox-marker.ts`) is the pure rule — ownership first, the
owner's `ReviewBadge` winning, the reader-facing `CaylakBadge` suppressed on an item you
wrote — and `SandboxMarker` is the one slot every content surface renders. A surface that
selects `sandboxedInPlace` and hand-rolls its own ternary is the drift
`sandbox-marker-surfaces.unit.test.ts` fails on.

No client-side flag read gates this. `sandboxedInPlace` is structurally false while
`PHOENIX_CAYLAK_VISIBILITY` is off, so a second gate in the component could only disagree
with the server that already decided.
