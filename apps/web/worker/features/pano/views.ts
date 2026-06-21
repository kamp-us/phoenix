/**
 * Pano fate data views — `Post`, `Comment`, `Tag`. Data views are the schema
 * (ADR 0018): each view's static `view` is the kernel `dataView()` output and
 * `Entity<>` derives the client type. See `.patterns/fate-effect-data-views.md`.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import {viewOrderBy} from "../../db/ordering.ts";
import type {ViewRow} from "../fate/view-types.ts";
import {COMMENT_ORDERING} from "./ordering.ts";
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
 * `comments`'s `orderBy` derives from `COMMENT_ORDERING` (`ordering.ts`), so it
 * can't drift from the service's comment-thread keyset (ADR 0019).
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
	comments: FateDataView.list(CommentView, {orderBy: viewOrderBy(COMMENT_ORDERING)}),
}) {}

// Kernel views for cross-feature surfaces that want fate's plain `dataView()`
// value (the `fate/views.ts` `Root` map + barrel re-exports).
export const tagDataView = TagView.view;
export const commentDataView = CommentView.view;
export const postDataView = PostView.view;

export type Tag = WorkerEntity<typeof TagView>;
// `deletedAt` is `Date | null` (the source row types it `deletedAt?: Date | null`, but
// the corrected worker type drops the unset `undefined`) — an `Override`, not a `DateKeys`
// member, which would preserve the optional and widen to `Date | null | undefined`.
export type Comment = WorkerEntity<
	typeof CommentView,
	"createdAt" | "updatedAt",
	{deletedAt: Date | null}
>;
// `updatedAt` is `Date` for the same reason: `PostSummaryRow.updatedAt?: Date` is optional,
// the corrected type pins it non-optional `Date`, so it rides the `Override` slot.
export type Post = WorkerEntity<
	typeof PostView,
	"createdAt",
	{updatedAt: Date; comments?: Comment[]}
>;
