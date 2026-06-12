/**
 * Pano fate data views — `Post`, `Comment`, `Tag`.
 *
 * Data views are the schema (ADR 0018): each view is a `FateDataView` class
 * whose static `view` IS the kernel `dataView()` output and whose `Entity<>`
 * derivation is the client's type (codegen, no schema artifact). IDs are raw
 * per-type values — no global-ID encoding, no `Node` interface.
 *
 * `Post.comments` is a `FateDataView.list(CommentView, {orderBy})` whose
 * `orderBy` is kept in lockstep with the service's comment-thread `ORDER BY`
 * (`created_at asc, id asc`) so the keyset cursors round-trip (ADR 0019; see
 * `.patterns/fate-connections.md`).
 *
 * See `.patterns/fate-effect-data-views.md`.
 */
import {type Entity, FateDataView} from "@phoenix/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {CommentRow, PostSummaryRow, PostTagRow} from "./Pano.ts";

/**
 * The view row types — mapped restatements of the service rows
 * (`Record<string, unknown>`-assignable, which the plain row interfaces are
 * not). Exported because the `Fate.source` entries over these views surface
 * the row type in their declarations (`fate/sources.ts` — TS2883 portability).
 */
export type TagViewRow = ViewRow<PostTagRow>;
export type CommentViewRow = ViewRow<CommentRow>;
export type PostViewRow = ViewRow<PostSummaryRow>;

/**
 * `Tag` — a post's category chip (`kind` + display `label`). Tags are embedded
 * scalars on the post row (parsed from `post_summary.tags` CSV), not a
 * standalone table; the `Post.tags` field carries the pre-built array on the
 * parent row. `kind` is the natural key.
 */
export class TagView extends FateDataView<TagViewRow>()("Tag")({
	kind: true,
	label: true,
}) {}

/**
 * `Comment` — a single discussion comment. `author` is the plain author-name
 * string, `authorId` gates edit/delete affordances, `parentId` carries the reply
 * tree, `deletedAt` is the reply-aware soft-delete flag, and `myVote` is the
 * viewer's `1 | null` flag — batched in one `user_vote` read
 * (`Pano.getCommentsByIds` / `listCommentsKeyset`), surfaced here as a stamped
 * scalar (no per-row resolver, no N+1).
 */
export class CommentView extends FateDataView<CommentViewRow>()("Comment")({
	id: true,
	parentId: true,
	author: true,
	authorId: true,
	body: true,
	score: true,
	createdAt: true,
	updatedAt: true,
	deletedAt: true,
	myVote: true,
}) {}

/**
 * `Post` — a link-aggregator submission plus its connection of comments.
 *
 * Scalar surface: `slug, title, url, host, body, author, authorId, score,
 * commentCount, createdAt, updatedAt, myVote`. `tags` is an embedded scalar
 * array carrying the pre-built `{kind, label}[]` on the row — NOT a normalized
 * `FateDataView.list(TagView)` relation. The tags are parsed from the
 * `post_summary.tags` CSV and ride inline on the post row — there is no
 * standalone tag table. fate's vite codegen builds the client type config from
 * data views only and never carries a source's id field, so it hardcodes the
 * default `getId` (reads `.id`) for every relation entity; `Tag` is keyed by
 * `kind` (no `id`), so a list relation would throw `Missing 'id' on entity
 * record` when the client normalizes the feed/post nodes. Modeling `tags` as a
 * scalar passes the array through verbatim (server → cache) without per-`Tag`
 * normalization. See `.patterns/fate-data-views.md` (embedded-scalar note).
 *
 * `comments` is the nested connection. Its `orderBy` MUST equal the service's
 * comment-thread `ORDER BY` — `(created_at asc, id asc)` — so the keyset cursors
 * the service builds round-trip without skips/dupes (ADR 0019). `id` is the
 * explicit final tiebreaker.
 */
export class PostView extends FateDataView<PostViewRow>()("Post")({
	id: true,
	slug: true,
	title: true,
	url: true,
	host: true,
	body: true,
	author: true,
	authorId: true,
	score: true,
	commentCount: true,
	createdAt: true,
	updatedAt: true,
	myVote: true,
	tags: true,
	comments: FateDataView.list(CommentView, {orderBy: [{createdAt: "asc"}, {id: "asc"}]}),
}) {}

/**
 * The kernel views, for the cross-feature surfaces that want fate's plain
 * `dataView()` value (the `fate/views.ts` `Root` map + barrel re-exports).
 */
export const tagDataView = TagView.view;
export const commentDataView = CommentView.view;
export const postDataView = PostView.view;

/*
 * `Replacements` restates the list relations (`comments`) and the live-`Date`
 * timestamp fields that fate's wire-facing `Entity<>` derivation
 * widens/narrows away — the full rationale lives in `sozluk/views.ts`.
 */
export type Tag = Entity<typeof TagView>;
export type Comment = Entity<
	typeof CommentView,
	{createdAt: Date; updatedAt: Date; deletedAt: Date | null}
>;
export type Post = Entity<
	typeof PostView,
	{
		createdAt: Date;
		updatedAt: Date;
		comments?: Comment[];
	}
>;
