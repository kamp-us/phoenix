/**
 * The SQL side of the çaylak sandbox (#1205): the read-query predicates that mirror
 * `EntityLifecycle.isVisibleTo` at the persisted layer — applied at the SAME place
 * the ADR 0096 `removed_at IS NULL` guard already lives in each content read, so a
 * viewer never sees sandboxed content they aren't entitled to.
 *
 * Two predicates, both pure (no service): {@link sandboxVisibleWhere} is the
 * per-viewer read filter; {@link sandboxBacklogWhere} is the moderator
 * sandbox-queue / promotion-backlog read model (#1206's read seam). Neither carries
 * the `removed_at IS NULL` clause — callers keep their own (the removal guard is
 * orthogonal), `and()`-ing this predicate beside it.
 */
import {and, eq, isNotNull, isNull, or, type SQL, type SQLWrapper} from "drizzle-orm";
import {anonymousViewer, type SandboxViewer} from "./EntityLifecycle.ts";

/**
 * Resolve the {@link SandboxViewer} a domain read applies from its options. A read
 * that was handed a fully-resolved `sandboxViewer` (the resolver probed moderator
 * authority) uses it; otherwise it degrades to a non-moderator viewer keyed by the
 * threaded `viewerId` — so an author still sees their OWN sandboxed content on a
 * plain `{viewerId}` re-read, while a missing identity safely reads as anonymous.
 */
export const resolveSandboxViewer = (opts: {
	readonly viewerId?: string | null | undefined;
	readonly sandboxViewer?: SandboxViewer | undefined;
}): SandboxViewer =>
	opts.sandboxViewer ??
	(opts.viewerId != null ? {viewerId: opts.viewerId, canSeeSandboxed: false} : anonymousViewer);

/** The two lifecycle columns a content read filters the sandbox dimension on. */
export interface SandboxColumns {
	readonly sandboxedAt: SQLWrapper;
	readonly authorId: SQLWrapper;
}

/**
 * The per-viewer sandbox read filter, the SQL mirror of `isVisibleTo` for the
 * `Live`/`Sandboxed` split (the `Removed` arm is the caller's own
 * `isNull(removedAt)` guard, kept beside this):
 *
 * - moderator (`canSeeSandboxed`) — `undefined`: no sandbox restriction, the full
 *   set is visible (drizzle `and()` drops an `undefined` term).
 * - signed-in member — `sandboxed_at IS NULL OR author_id = :viewerId`: public
 *   content plus their own sandboxed content.
 * - anonymous/public (`viewerId` null) — `sandboxed_at IS NULL`: public only.
 */
export const sandboxVisibleWhere = (
	cols: SandboxColumns,
	viewer: SandboxViewer,
): SQL | undefined => {
	if (viewer.canSeeSandboxed) return undefined;
	if (viewer.viewerId !== null) {
		return or(isNull(cols.sandboxedAt), eq(cols.authorId, viewer.viewerId));
	}
	return isNull(cols.sandboxedAt);
};

/** The lifecycle columns the moderator sandbox queue reads. */
export interface SandboxBacklogColumns {
	readonly sandboxedAt: SQLWrapper;
	readonly removedAt: SQLWrapper;
	readonly authorId: SQLWrapper;
}

/**
 * The moderator sandbox-queue / promotion-backlog read model (#1206 seam): the
 * still-sandboxed, not-removed content — optionally scoped to one author's backlog
 * (what the promotion path flips on çaylak→yazar). Carries its own `removed_at IS
 * NULL` because it is a standalone queue read, not layered on a content read.
 */
export const sandboxBacklogWhere = (
	cols: SandboxBacklogColumns,
	opts: {readonly authorId?: string | undefined} = {},
): SQL | undefined =>
	and(
		isNotNull(cols.sandboxedAt),
		isNull(cols.removedAt),
		opts.authorId ? eq(cols.authorId, opts.authorId) : undefined,
	);
