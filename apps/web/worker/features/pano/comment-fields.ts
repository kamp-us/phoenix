/**
 * `Comment`'s one column→field map — the single structure the row mapper
 * (`toCommentRow` / `rowToCommentRow` in `Pano.ts`), the wire shaper (`toComment`
 * in `shapers.ts`), and the view field declaration (`CommentView` in `views.ts`)
 * all derive from, so a one-field change touches this map instead of three
 * hand-synced restatements (#1166, the Pano half of #1126 AC#1).
 *
 * The map absorbs the per-source naming divergence: the DB record calls the
 * author `authorName` and may leave the timestamps null, while the wire field is
 * `author` / a non-null `Date`. Each intrinsic reader maps a `comment_record` row
 * onto its wire value, so the divergence lives in the map, not at every call site.
 *
 * The `Removed` tombstone (`[silindi]` placeholder, author elided — ADR 0096 §5)
 * is a presentation override the map does NOT carry: `rowToCommentRow` runs this
 * map for the live shape, then substitutes the tombstone fields. `myVote` is the
 * viewer scalar — part of the view/wire field set (`commentViewFields`) but *not*
 * read from the record here: it is stamped by `stampViewerScalars` after the
 * batched `user_vote` read (#1159, `viewer-scalars.ts`).
 */
import type * as schema from "../../db/drizzle/schema.ts";

type CommentRecord = typeof schema.commentRecord.$inferSelect;

/**
 * The intrinsic (record-derived) wire fields, in `CommentView` order, each
 * mapping a `comment_record` row onto its live wire value. The keys ARE the wire
 * field names; the readers absorb the `authorName`→`author` + null-timestamp
 * divergence. `deletedAt` is the removal timestamp (`null` for a live comment);
 * the tombstone override in `rowToCommentRow` supplies it for a `Removed` row.
 */
const intrinsicFields = {
	id: (c) => c.id,
	parentId: (c) => c.parentId,
	author: (c) => c.authorName,
	authorId: (c) => c.authorId,
	body: (c) => c.body,
	score: (c) => c.score,
	createdAt: (c) => c.createdAt ?? new Date(0),
	updatedAt: (c) => c.updatedAt ?? c.createdAt ?? new Date(0),
	deletedAt: (_c) => null as Date | null,
} satisfies Record<string, (c: CommentRecord) => unknown>;

type IntrinsicRow = {[K in keyof typeof intrinsicFields]: ReturnType<(typeof intrinsicFields)[K]>};

/**
 * `CommentRow` — the record-derived row the comment reads share, plus the
 * `myVote` viewer scalar that `stampViewerScalars` adds downstream (`null` for an
 * anonymous viewer; `undefined` when not requested — never read from the record).
 */
export interface CommentRow extends IntrinsicRow {
	myVote?: boolean | null;
}

/**
 * `CommentFields` — the wire shaper's input (`toComment` in `shapers.ts`): the
 * intrinsic wire-named fields derived from this one column→field map so the wire
 * shaper's field set can't drift from the row mapper / `commentViewFields` (the third
 * hand-synced restatement #1126 AC#1 collapses). A fresh write/vote carries no
 * `updatedAt`, and `deletedAt` / `myVote` are stamped at the call site (the tombstone
 * override + the viewer scalar), so those ride as optional — the map stays the single
 * source for the field set.
 */
export type CommentFields = Omit<IntrinsicRow, "updatedAt" | "deletedAt"> & {
	updatedAt?: Date | null;
	deletedAt?: Date | null;
	myVote?: boolean | null;
};

export interface CommentConnectionPage {
	rows: CommentRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/**
 * The view/wire field selection (`{id: true, …}`) — a static literal (fate's
 * `FateDataView` reads the literal field map off this, so it can't be a
 * dynamically-built object). `satisfies Record<keyof CommentRow, true>` pins it
 * to exactly the row's fields: dropping a field here (or adding one to
 * `CommentRow` without listing it here) is a compile error, so the view stays in
 * lockstep with the row mapper.
 */
export const commentViewFields = {
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
} as const satisfies Record<keyof CommentRow, true>;

/**
 * Map a live `comment_record` row onto its intrinsic `CommentRow` fields by
 * running every reader in the column→field map — the single place the live
 * record→row mapping lives. The `Removed` tombstone override and `myVote` viewer
 * scalar are applied by the callers in `Pano.ts`, not here.
 */
export const toCommentRow = (c: CommentRecord): IntrinsicRow =>
	Object.fromEntries(
		(Object.keys(intrinsicFields) as Array<keyof typeof intrinsicFields>).map((f) => [
			f,
			intrinsicFields[f](c),
		]),
	) as IntrinsicRow;
