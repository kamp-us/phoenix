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
