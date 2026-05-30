/**
 * Pano fate data views — `Post`, `Comment`, `Tag`.
 *
 * Data views are the schema (ADR 0018): each `dataView` declares an entity
 * type's fields; the exported `Entity<>` types are the client's types (codegen,
 * no schema artifact).
 *
 * `Post.comments` is a `list(commentDataView, {orderBy})` whose `orderBy` is
 * kept in lockstep with the service's comment-thread `ORDER BY` (`created_at
 * asc, id asc`) so the keyset cursors round-trip (ADR 0019; see
 * `.patterns/fate-connections.md`).
 *
 * See `.patterns/fate-data-views.md`.
 */
import type {SourceDefinition} from "@nkzw/fate/server";
import {dataView, list} from "@nkzw/fate/server";
import type {CommentRow, PostSummaryRow, PostTagRow} from "./Pano.ts";

type ViewRow<Row> = {[K in keyof Row]: Row[K]};

type DataViewOf<Item extends Record<string, unknown>> = SourceDefinition<Item>["view"];

type EntityOf<Row, Fields, Name extends string> = {
	[K in keyof Fields as Fields[K] extends true ? K : never]: K extends keyof Row ? Row[K] : never;
} & {__typename: Name};

type TagViewRow = ViewRow<PostTagRow>;
type CommentViewRow = ViewRow<CommentRow>;
type PostViewRow = ViewRow<PostSummaryRow>;

/**
 * `Tag` — a post's category chip (`kind` + display `label`). Tags are embedded
 * scalars on the post row (parsed from `post_summary.tags` CSV), not a
 * standalone table; the `Post.tags` list carries the pre-built array on the
 * parent row. `kind` is the natural key.
 */
const tagFields = {
	kind: true,
	label: true,
} as const;

export const tagDataView: DataViewOf<TagViewRow> = dataView<TagViewRow>("Tag")(tagFields);

/**
 * `Comment` — a single discussion comment. `author` is the plain author-name
 * string, `authorId` gates edit/delete affordances, `parentId` carries the reply
 * tree, `deletedAt` is the reply-aware soft-delete flag, and `myVote` is the
 * viewer's `1 | null` flag — batched in one `user_vote` read
 * (`Pano.getCommentsByIds` / `listCommentsKeyset`), surfaced here as a stamped
 * scalar (no per-row resolver, no N+1).
 */
const commentFields = {
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
} as const;

export const commentDataView: DataViewOf<CommentViewRow> =
	dataView<CommentViewRow>("Comment")(commentFields);

/**
 * `Post` — a link-aggregator submission plus its connection of comments.
 *
 * Scalar surface: `slug, title, url, host, body, author, authorId, score,
 * commentCount, createdAt, updatedAt, myVote`. `tags` is an embedded scalar
 * array carrying the pre-built `{kind, label}[]` on the row.
 *
 * `comments` is the nested connection. Its `orderBy` MUST equal the service's
 * comment-thread `ORDER BY` — `(created_at asc, id asc)` — so the keyset cursors
 * the service builds round-trip without skips/dupes (ADR 0019). `id` is the
 * explicit final tiebreaker.
 */
const postFields = {
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
	// `tags` is an **embedded scalar array** (`{kind, label}[]`), NOT a normalized
	// `list(tagDataView)` relation. The tags are parsed from the `post_summary.tags`
	// CSV and ride inline on the post row — there is no standalone tag table. fate's
	// vite codegen builds the client type config from data views only and never
	// carries a source's id field, so it hardcodes the default `getId` (reads `.id`)
	// for every relation entity; `Tag` is keyed by `kind` (no `id`), so a
	// `list(tagDataView)` relation would throw `Missing 'id' on entity record` when
	// the client normalizes the feed/post nodes. Modeling `tags` as a scalar passes
	// the array through verbatim (server → cache) without per-`Tag` normalization.
	// See `.patterns/fate-data-views.md` (embedded-scalar note).
	tags: true,
} as const;

export const postDataView: DataViewOf<PostViewRow> = dataView<PostViewRow>("Post")({
	...postFields,
	comments: list(commentDataView, {orderBy: [{createdAt: "asc"}, {id: "asc"}]}),
});

export type Tag = EntityOf<TagViewRow, typeof tagFields, "Tag">;
export type Comment = EntityOf<CommentViewRow, typeof commentFields, "Comment">;
// `tags` is an embedded scalar array on the row; `comments` is an optional
// relation intersected on. See `.patterns/fate-data-views.md`.
export type Post = EntityOf<PostViewRow, typeof postFields, "Post"> &
	Pick<PostViewRow, "tags"> & {
		comments?: Comment[];
	};
