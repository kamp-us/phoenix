/**
 * Pano fate data views — `Post`, `Comment`, `Tag`. Data views are the schema
 * (ADR 0018): each view's static `view` is the kernel `dataView()` output and
 * `Entity<>` derives the client type. See `.patterns/fate-effect-data-views.md`.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import {viewOrderBy} from "../../db/ordering.ts";
import type {ViewRow} from "../fate/view-types.ts";
import {type CommentRow, commentViewFields} from "./comment-fields.ts";
import {COMMENT_ORDERING} from "./ordering.ts";
import {type PostSummaryRow, type PostTagRow, postViewFields} from "./post-fields.ts";

// `Record<string, unknown>`-assignable restatements of the service rows. Exported so
// `Fate.source` declarations can name the row type (TS2883 portability).
export type TagViewRow = ViewRow<PostTagRow>;
export type CommentViewRow = ViewRow<CommentRow>;
export type PostViewRow = ViewRow<PostSummaryRow>;

/**
 * The per-viewer scalar slice (#2322), keyed by post id. A distinct entity rather than
 * a `PostView` field set so the viewer-invariant base projection and the per-viewer
 * read stay separately cacheable and session-gated.
 */
export interface PostOverlayRow {
	id: string;
	myVote: boolean | null;
	isSaved: boolean | null;
}
export type PostOverlayViewRow = ViewRow<PostOverlayRow>;

// `Tag` is an embedded scalar on the post row, keyed by `kind` — not a table.
export class TagView extends FateDataView<TagViewRow>()("Tag")({
	kind: true,
	label: true,
}) {}

// The field list derives from `comment-fields.ts`'s column→field map, so it cannot
// drift from the row mapper / wire shaper (#1166).
export class CommentView extends FateDataView<CommentViewRow>()("Comment")(commentViewFields) {}

/**
 * `tags` is an embedded scalar array, NOT a `FateDataView.list(TagView)` relation:
 * fate's vite codegen hardcodes the default `getId` (reads `.id`) for every relation
 * entity, but `Tag` is keyed by `kind`, so a list relation throws
 * `Missing 'id' on entity record` when the client normalizes feed/post nodes. See
 * `.patterns/fate-data-views.md`.
 */
export class PostView extends FateDataView<PostViewRow>()("Post")({
	...postViewFields,
	tags: true,
	comments: FateDataView.list(CommentView, {orderBy: viewOrderBy(COMMENT_ORDERING)}),
}) {}

// The per-viewer overlay view (#2322): three scalars, no relation.
export class PostOverlayView extends FateDataView<PostOverlayViewRow>()("PostOverlay")({
	id: true,
	myVote: true,
	isSaved: true,
}) {}

export const tagDataView = TagView.view;
export const commentDataView = CommentView.view;
export const postDataView = PostView.view;
export const postOverlayDataView = PostOverlayView.view;

export type Tag = WorkerEntity<typeof TagView>;
export type PostOverlay = WorkerEntity<typeof PostOverlayView>;
// `deletedAt` is an `Override`, not a `DateKeys` member: a `DateKeys` member would
// preserve the source row's optional and widen to `Date | null | undefined`.
export type Comment = WorkerEntity<
	typeof CommentView,
	"createdAt" | "updatedAt",
	{deletedAt: Date | null}
>;
// `updatedAt` rides the `Override` slot for the same reason: the source row types it
// optional, the corrected worker type pins it non-optional `Date`.
export type Post = WorkerEntity<
	typeof PostView,
	"createdAt",
	{updatedAt: Date; comments?: Comment[]}
>;
