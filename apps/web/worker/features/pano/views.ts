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

// `Record<string, unknown>`-assignable restatements of the service rows (the
// plain row interfaces are not). Exported so `Fate.source` declarations over
// these views can name the row type (TS2883 portability).
export type TagViewRow = ViewRow<PostTagRow>;
export type CommentViewRow = ViewRow<CommentRow>;
export type PostViewRow = ViewRow<PostSummaryRow>;

/**
 * `PostOverlay` — the per-viewer scalar slice (#2322, epic #2316 leg B), keyed by the
 * post id. The GET-able base feed (`PostView` served without the viewer stamp) is
 * viewer-invariant; the client fetches this overlay by the base feed's ids and composes
 * `myVote`/`isSaved` on top (#2323). A distinct entity — not a `PostView` field set —
 * so the base projection and the per-viewer read are separately cacheable/session-gated.
 */
export interface PostOverlayRow {
	id: string;
	myVote: boolean | null;
	isSaved: boolean | null;
}
export type PostOverlayViewRow = ViewRow<PostOverlayRow>;

// `Tag` is an embedded scalar on the post row (parsed from `post_record.tags`
// CSV), not a standalone table; `kind` is the natural key.
export class TagView extends FateDataView<TagViewRow>()("Tag")({
	kind: true,
	label: true,
}) {}

// The field list derives from `comment-fields.ts`'s column→field map, so it can't
// drift from the row mapper / wire shaper (#1166). `myVote` is the viewer's vote,
// batched in one `user_vote` read and stamped as a scalar — no per-row resolver.
export class CommentView extends FateDataView<CommentViewRow>()("Comment")(commentViewFields) {}

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
	// The scalar fields derive from `post-fields.ts`'s column→field map (incl.
	// `myVote` / `isSaved` viewer scalars + the `isDraft` taslak marker), so they
	// can't drift from the row mapper / wire shaper (#1166).
	...postViewFields,
	tags: true,
	comments: FateDataView.list(CommentView, {orderBy: viewOrderBy(COMMENT_ORDERING)}),
}) {}

// The per-viewer overlay view (#2322): three scalars, no relation. `myVote`/`isSaved`
// are stamped by `Pano.readViewerOverlay` off the batched presence readers.
export class PostOverlayView extends FateDataView<PostOverlayViewRow>()("PostOverlay")({
	id: true,
	myVote: true,
	isSaved: true,
}) {}

// Kernel views for cross-feature surfaces that want fate's plain `dataView()`
// value (the `fate/views.ts` `Root` map + barrel re-exports).
export const tagDataView = TagView.view;
export const commentDataView = CommentView.view;
export const postDataView = PostView.view;
export const postOverlayDataView = PostOverlayView.view;

export type Tag = WorkerEntity<typeof TagView>;
export type PostOverlay = WorkerEntity<typeof PostOverlayView>;
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
