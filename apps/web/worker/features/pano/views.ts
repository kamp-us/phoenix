/**
 * Pano fate data views — `Post`, `Comment`, `Tag`. Data views are the schema
 * (ADR 0018): each view's static `view` is the kernel `dataView()` output and
 * `Entity<>` derives the client type. See `.patterns/fate-effect-data-views.md`.
 */
import {type Entity, FateDataView} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {CommentRow, PostSummaryRow, PostTagRow} from "./Pano.ts";

// `Record<string, unknown>`-assignable restatements of the service rows (the
// plain row interfaces are not). Exported so `Fate.source` declarations over
// these views can name the row type (TS2883 portability).
export type TagViewRow = ViewRow<PostTagRow>;
export type CommentViewRow = ViewRow<CommentRow>;
export type PostViewRow = ViewRow<PostSummaryRow>;

// `Tag` is an embedded scalar on the post row (parsed from `post_record.tags`
// CSV), not a standalone table; `kind` is the natural key.
export class TagView extends FateDataView<TagViewRow>()("Tag")({
	kind: true,
	label: true,
}) {}

// `myVote` is the viewer's vote, batched in one `user_vote` read
// (`Pano.getCommentsByIds` / `listCommentsKeyset`) and stamped here as a scalar
// — no per-row resolver, no N+1.
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
 * `tags` is an embedded scalar array, NOT a `FateDataView.list(TagView)`
 * relation: fate's vite codegen hardcodes the default `getId` (reads `.id`) for
 * every relation entity, but `Tag` is keyed by `kind` (no `id`), so a list
 * relation would throw `Missing 'id' on entity record` when the client
 * normalizes feed/post nodes. A scalar passes the array through verbatim. See
 * `.patterns/fate-data-views.md` (embedded-scalar note).
 *
 * `comments`'s `orderBy` MUST equal the service's comment-thread `ORDER BY`
 * (`created_at asc, id asc`) so the keyset cursors round-trip (ADR 0019).
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
	// `isSaved` is the viewer's bookmark presence, batched in one `post_bookmark`
	// read (`Pano.getPostsByIds` / `queries.post`) and stamped here as a scalar —
	// the `myVote` twin, no per-row resolver, no N+1.
	isSaved: true,
	// `isDraft` is the taslak marker, stamped here as a scalar (the `isSaved` twin —
	// no per-row resolver, no N+1). Drafts are excluded from public feeds.
	isDraft: true,
	tags: true,
	comments: FateDataView.list(CommentView, {orderBy: [{createdAt: "asc"}, {id: "asc"}]}),
}) {}

// Kernel views for cross-feature surfaces that want fate's plain `dataView()`
// value (the `fate/views.ts` `Root` map + barrel re-exports).
export const tagDataView = TagView.view;
export const commentDataView = CommentView.view;
export const postDataView = PostView.view;

// The `Entity<>` replacements restate the list relations (`comments`) and
// live-`Date` timestamps that fate's wire-facing derivation widens/narrows away
// — full rationale in `sozluk/views.ts`.
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
