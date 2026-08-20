/**
 * `Comment`'s one column→field map — the single structure the row mapper (`toCommentRow` /
 * `rowToCommentRow` in `Pano.ts`), the wire shaper (`toComment` in `shapers.ts`) and the view
 * field declaration (`CommentView` in `views.ts`) all derive from, instead of three hand-synced
 * restatements (#1166).
 *
 * The map absorbs the per-source naming divergence (`authorName`→`author`, nullable timestamps).
 * It does NOT carry the `Removed` tombstone override (ADR 0096 §5) or the viewer scalars — those
 * are stamped by the callers after their batched reads.
 */
import type * as schema from "../../db/drizzle/schema.ts";
import type {ReactionAggregate} from "../reaction/Reaction.ts";

type CommentRecord = typeof schema.commentRecord.$inferSelect;

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
 * `myVote` is `null` for an anonymous viewer and `undefined` when the read didn't request it —
 * never read from the record; `stampViewerScalars` adds it downstream.
 */
export interface CommentRow extends IntrinsicRow {
	myVote?: boolean | null;
	/**
	 * The owner-scoped in-review flag (#4282): stamped via `ownSandboxed`, so it is `true` only
	 * for the author's OWN still-sandboxed comment. `undefined` when unstamped; shaper defaults false.
	 */
	sandboxed?: boolean;
	/**
	 * The reader-facing çaylak marker (#6425): `true` iff this comment is still
	 * sandboxed AND the viewer is the opted-in in-place reader of #6423, stamped by the
	 * read paths via `sandboxedInPlace` off the resolved `SandboxViewer`.
	 *
	 * The twin of `sandboxed` above, and never a substitute for it. `sandboxed` is
	 * owner-scoped — the AUTHOR's "incelemede" signal about their OWN comment, rendered
	 * as `ReviewBadge`. This one marks SOMEBODY ELSE's hazırlık-stage comment for a
	 * reader who asked to see çaylak work in place. Disjoint audiences on the same row,
	 * so they cannot collapse into one field. `undefined` when a read doesn't stamp it;
	 * the shaper then defaults `false`, which is also what every viewer gets while
	 * `PHOENIX_CAYLAK_VISIBILITY` is off.
	 */
	sandboxedInPlace?: boolean;
	/**
	 * The author's LIVE handle (`user_profile.username` / `.displayName`), stamped by
	 * `stampAuthorIdentity` after the batched `getProfileIdentitiesByIds` read (#2139)
	 * so the client renders the CURRENT display name via `actorLabel`, not the write-time
	 * `authorName` snapshot (#2126's AC). `undefined` when not requested; `null` when the
	 * author has no profile/handle (or the `Removed` tombstone blanked `authorId`) —
	 * `actorLabel` then degrades to `@username` → fallback.
	 */
	authorUsername?: string | null;
	authorDisplayName?: string | null;
	/** Per-emoji counts + the viewer's own reaction (#1862); the shaper fills the empty aggregate. */
	reactions?: ReactionAggregate;
}

/**
 * The wire shaper's input, derived from the same map so its field set can't drift. `updatedAt`,
 * `deletedAt` and `myVote` ride optional because they are stamped at the call site.
 */
export type CommentFields = Omit<IntrinsicRow, "updatedAt" | "deletedAt"> & {
	updatedAt?: Date | null;
	deletedAt?: Date | null;
	myVote?: boolean | null;
	sandboxed?: boolean;
	sandboxedInPlace?: boolean;
	authorUsername?: string | null;
	authorDisplayName?: string | null;
	reactions?: ReactionAggregate;
};

export interface CommentConnectionPage {
	rows: CommentRow[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/**
 * A static literal, not a built object: fate's `FateDataView` reads the literal field map off
 * this. `satisfies Record<keyof CommentRow, true>` makes a missing field a compile error.
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
	sandboxed: true,
	sandboxedInPlace: true,
	authorUsername: true,
	authorDisplayName: true,
	reactions: true,
} as const satisfies Record<keyof CommentRow, true>;

export const toCommentRow = (c: CommentRecord): IntrinsicRow =>
	Object.fromEntries(
		(Object.keys(intrinsicFields) as Array<keyof typeof intrinsicFields>).map((f) => [
			f,
			intrinsicFields[f](c),
		]),
	) as IntrinsicRow;
