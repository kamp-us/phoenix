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
import {
	anonymousViewer,
	type LifecycleTag,
	lifecycleVisibilityRule,
	type SandboxViewer,
} from "./EntityLifecycle.ts";

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
 * The sandbox-dimension read arm each lifecycle state contributes for a **non-moderator**
 * viewer — the SQL half of that state's {@link lifecycleVisibilityRule}, keyed by the
 * closed {@link LifecycleTag} discriminant so the SQL encoding is tied to the SAME
 * exhaustive tag set the TS `isVisibleTo` uses (#2013). An exhaustive `switch`: a new
 * lifecycle tag has no case, so this **fails to compile** until its sandbox arm is
 * stated — closing the latent gap where a 4th state would branch on booleans and
 * silently mis-filter at the DB. Returns the predicate admitting the rows of that state
 * this viewer may see, or `undefined` when the state adds no arm (`Removed` is filtered
 * by the caller's orthogonal `isNull(removedAt)` guard, so it is not selected here):
 *
 * - `Live` (`Everyone`) — `sandboxed_at IS NULL`: the public base, visible to all.
 * - `Sandboxed` (`AuthorOrModerator`) — a signed-in viewer additionally sees their own
 *   sandboxed rows (`author_id = :viewerId`); a moderator is handled by the
 *   `canSeeSandboxed` short-circuit in {@link sandboxVisibleWhere} (no restriction).
 * - `Removed` (`NoOne`) — `undefined`: not selected in the sandbox dimension.
 */
const sandboxArm = (
	tag: LifecycleTag,
	cols: SandboxColumns,
	viewer: SandboxViewer,
): SQL | undefined => {
	switch (tag) {
		case "Live":
			return isNull(cols.sandboxedAt);
		case "Sandboxed":
			// Only the AuthorOrModerator rule's author branch survives here for a
			// non-moderator (the moderator branch is the caller's `canSeeSandboxed`
			// short-circuit): a signed-in viewer sees their OWN sandboxed rows.
			return viewer.viewerId !== null ? eq(cols.authorId, viewer.viewerId) : undefined;
		case "Removed":
			return undefined;
	}
};

/**
 * The per-viewer sandbox read filter, the SQL mirror of `isVisibleTo` for the
 * `Live`/`Sandboxed` split (the `Removed` arm is the caller's own
 * `isNull(removedAt)` guard, kept beside this). Derived from the same exhaustive
 * lifecycle discriminant `isVisibleTo` uses (#2013): a moderator sees everything, else
 * the row is visible iff any lifecycle state's {@link sandboxArm} admits it — so a new
 * lifecycle tag forces a `sandboxArm` case (and a `lifecycleVisibilityRule` entry)
 * rather than compiling clean and mis-filtering. Emits the same SQL as before:
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
	const tags = Object.keys(lifecycleVisibilityRule) as LifecycleTag[];
	const arms = tags
		.map((tag) => sandboxArm(tag, cols, viewer))
		.filter((a): a is SQL => a !== undefined);
	return arms.length === 1 ? arms[0] : or(...arms);
};

/**
 * The columns the public-live aggregate predicate filters on: the sandbox pair plus
 * the ADR 0096 `removed_at`, so the removal guard folds into the same predicate
 * rather than being hand-written beside it at every count call site.
 */
export interface PublicLiveColumns extends SandboxColumns {
	readonly removedAt: SQLWrapper;
}

/**
 * The single public-live aggregate filter (#1359 seam): removed-excluded AND
 * sandbox-masked-for-this-viewer, in one predicate. This is the `and()` of the
 * caller's former `isNull(removedAt)` guard with {@link sandboxVisibleWhere} — for an
 * anonymous viewer it reduces to exactly `removed_at IS NULL AND sandboxed_at IS NULL`,
 * the form the landing-count paths (#1407) re-derive by hand today and fold onto this.
 *
 * For the **post** table the draft dimension is excluded too — that arm is pano-local
 * (ADR 0113: `is_draft` lives only on `post_record`), so the post-aware aggregate
 * `publicLivePostWhere` in `features/pano/PostVisibility.ts` `and()`s the draft arm onto
 * this. Definition/comment reads, which have no draft concept, route through this directly.
 */
export const publicLiveWhere = (cols: PublicLiveColumns, viewer: SandboxViewer): SQL | undefined =>
	and(isNull(cols.removedAt), sandboxVisibleWhere(cols, viewer));

/** The two record fields the owner-scoped in-review flag reads. */
export interface OwnerSandboxRecord {
	readonly sandboxedAt: Date | null;
	readonly authorId: string;
}

/**
 * The in-memory owner-scoped in-review flag (#2200): `true` iff the row is still
 * sandboxed (#1205) AND the viewer is its author — the `sandboxed` wire signal a
 * çaylak sees on their OWN in-review content. Owner-only by construction: any other
 * viewer (anonymous, another member, a moderator) reads `false`, so the flag never
 * leaks review state beyond the author. The in-memory dual of {@link sandboxArm}'s
 * `Sandboxed` author branch, for the read paths that have already fetched the record.
 */
export const ownSandboxed = (
	record: OwnerSandboxRecord,
	viewerId: string | null | undefined,
): boolean => record.sandboxedAt != null && viewerId != null && record.authorId === viewerId;

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
