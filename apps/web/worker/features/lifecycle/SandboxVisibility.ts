/**
 * The SQL side of the çaylak sandbox — the read predicates mirroring
 * `EntityLifecycle.isVisibleTo` at the persisted layer. Neither predicate carries the
 * ADR 0096 `removed_at IS NULL` clause: removal is orthogonal, so callers `and()` their
 * own guard beside these.
 */
import {and, eq, isNotNull, isNull, or, type SQL, type SQLWrapper} from "drizzle-orm";
import {
	anonymousViewer,
	type LifecycleTag,
	lifecycleVisibilityRule,
	type SandboxViewer,
} from "./EntityLifecycle.ts";

/**
 * Without a resolved `sandboxViewer` this degrades to a NON-moderator viewer keyed by
 * `viewerId` — an author still sees their own sandboxed content on a plain re-read, and
 * a missing identity falls back to anonymous.
 */
export const resolveSandboxViewer = (opts: {
	readonly viewerId?: string | null | undefined;
	readonly sandboxViewer?: SandboxViewer | undefined;
}): SandboxViewer =>
	opts.sandboxViewer ??
	(opts.viewerId != null ? {viewerId: opts.viewerId, canSeeSandboxed: false} : anonymousViewer);

export interface SandboxColumns {
	readonly sandboxedAt: SQLWrapper;
	readonly authorId: SQLWrapper;
}

/**
 * The per-tag SQL arm for a **non-moderator** viewer. The `switch` is exhaustive on
 * purpose: a new lifecycle tag fails to compile here until its sandbox arm is stated,
 * rather than compiling clean and silently mis-filtering at the DB.
 */
export const sandboxArm = (
	tag: LifecycleTag,
	cols: SandboxColumns,
	viewer: SandboxViewer,
): SQL | undefined => {
	switch (tag) {
		case "Live":
			return isNull(cols.sandboxedAt);
		case "Sandboxed":
			// Only the author branch survives here; the moderator branch is the caller's
			// `canSeeSandboxed` short-circuit.
			return viewer.viewerId !== null ? eq(cols.authorId, viewer.viewerId) : undefined;
		case "Removed":
			return undefined;
	}
};

/**
 * The per-viewer sandbox read filter. `undefined` means NO restriction (drizzle's
 * `and()` drops an undefined term), which is how a moderator sees the full set.
 */
export const sandboxVisibleWhere = (
	cols: SandboxColumns,
	viewer: SandboxViewer,
): SQL | undefined => {
	if (viewer.canSeeSandboxed) return undefined;
	const tags = Object.keys(lifecycleVisibilityRule) as LifecycleTag[];
	const arms = tags
		.map((tag) => sandboxArm(tag, cols, viewer))
		.filter((a): a is SQL => a !== undefined);
	return arms.length === 1 ? arms[0] : or(...arms);
};

export interface PublicLiveColumns extends SandboxColumns {
	readonly removedAt: SQLWrapper;
}

/**
 * Removed-excluded AND sandbox-masked, in one predicate. Carries NO draft arm: `is_draft`
 * is pano-local (ADR 0113), so `publicLivePostWhere` `and()`s that arm onto this.
 */
export const publicLiveWhere = (cols: PublicLiveColumns, viewer: SandboxViewer): SQL | undefined =>
	and(isNull(cols.removedAt), sandboxVisibleWhere(cols, viewer));

export interface OwnerSandboxRecord {
	readonly sandboxedAt: Date | null;
	readonly authorId: string;
}

/**
 * The `sandboxed` wire signal a çaylak sees on their OWN in-review content. Owner-only
 * by construction — every other viewer, moderators included, reads `false`, so the flag
 * never leaks review state beyond the author.
 */
export const ownSandboxed = (
	record: OwnerSandboxRecord,
	viewerId: string | null | undefined,
): boolean => record.sandboxedAt != null && viewerId != null && record.authorId === viewerId;

export interface SandboxBacklogColumns {
	readonly sandboxedAt: SQLWrapper;
	readonly removedAt: SQLWrapper;
	readonly authorId: SQLWrapper;
}

/**
 * The moderator sandbox queue. Unlike the predicates above it DOES carry its own
 * `removed_at IS NULL`, because it is a standalone read and not layered on a content read.
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
