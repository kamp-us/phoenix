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
	ruleVisibleTo,
	type SandboxViewer,
} from "./EntityLifecycle.ts";

/**
 * Resolve the {@link SandboxViewer} a domain read applies from its options. A read
 * that was handed a fully-resolved `sandboxViewer` (the resolver probed moderator
 * authority) uses it; otherwise it degrades to a non-moderator viewer keyed by the
 * threaded `viewerId` — so an author still sees their OWN sandboxed content on a
 * plain `{viewerId}` re-read, while a missing identity safely reads as anonymous.
 *
 * The degraded path claims neither elevated class: `seesSandboxedInPlace` (#6423) is
 * resolved from the flag + the opt-in preference, which a bare `{viewerId}` cannot
 * witness, so it degrades `false` exactly as `canSeeSandboxed` does.
 */
export const resolveSandboxViewer = (opts: {
	readonly viewerId?: string | null | undefined;
	readonly sandboxViewer?: SandboxViewer | undefined;
}): SandboxViewer =>
	opts.sandboxViewer ??
	(opts.viewerId != null
		? {viewerId: opts.viewerId, canSeeSandboxed: false, seesSandboxedInPlace: false}
		: anonymousViewer);

/** The two lifecycle columns a content read filters the sandbox dimension on. */
export interface SandboxColumns {
	readonly sandboxedAt: SQLWrapper;
	readonly authorId: SQLWrapper;
}

/**
 * The reusable per-tag SQL arm builder {@link sandboxVisibleWhere} folds together — the
 * sandbox-dimension read arm each lifecycle state contributes for a **non-moderator**
 * viewer, the SQL half of that state's {@link lifecycleVisibilityRule}, keyed by the
 * closed {@link LifecycleTag} discriminant so the SQL encoding is tied to the SAME
 * exhaustive tag set the TS `isVisibleTo` uses (#2013). An exhaustive `switch`: a new
 * lifecycle tag has no case, so this **fails to compile** until its sandbox arm is
 * stated — closing the latent gap where a 4th state would branch on booleans and
 * silently mis-filter at the DB. Returns the predicate admitting the rows of that state
 * this viewer may see, or `undefined` when the state adds no arm (`Removed` is filtered
 * by the caller's orthogonal `isNull(removedAt)` guard, so it is not selected here):
 *
 * - `Live` (`Everyone`) — `sandboxed_at IS NULL`: the public base, visible to all.
 * - `Sandboxed` (`AuthorOrModeratorOrInPlaceViewer`) — an opted-in in-place viewer
 *   (#6423) sees every sandboxed row (`sandboxed_at IS NOT NULL`, author-blind); any
 *   other signed-in viewer sees only their own (`author_id = :viewerId`); a moderator is
 *   handled by the `canSeeSandboxed` short-circuit in {@link sandboxVisibleWhere}.
 * - `Removed` (`NoOne`) — `undefined`: not selected in the sandbox dimension.
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
			// The rule's moderator branch is the caller's `canSeeSandboxed` short-circuit,
			// so two branches survive here: the in-place viewer's author-blind widening
			// (#6423) and, failing that, the author's own rows.
			if (viewer.seesSandboxedInPlace) return isNotNull(cols.sandboxedAt);
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
 * - opted-in in-place viewer (#6423) — `sandboxed_at IS NULL OR sandboxed_at IS NOT
 *   NULL`: every non-removed row, since the caller's `isNull(removedAt)` guard is
 *   orthogonal and stays where it is. It rides `seesSandboxedInPlace`, not
 *   `canSeeSandboxed`, so the moderator backlog reads are untouched.
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

/**
 * The reader-facing çaylak marker (#6425): `true` iff the row is still sandboxed
 * (#1205) AND this viewer is reading it **in place** — the opted-in yazar of #6423.
 * It says "what you are looking at is hazırlık-stage work by a çaylak", to the one
 * audience that asked to be shown such rows inside the ordinary feed.
 *
 * Not {@link ownSandboxed}, and never merged with it. `sandboxed` is owner-scoped: it
 * is the author's own "incelemede" signal about their own row, and the client renders
 * it as `ReviewBadge`. This one is about somebody ELSE's row, for a reader who is not
 * its author. The two are true for disjoint viewers on the same row, so a single field
 * could not carry both meanings.
 *
 * It rides `seesSandboxedInPlace` alone, not the whole
 * `AuthorOrModeratorOrInPlaceViewer` rule. Entitlement is still structural — the
 * in-place class is one of that rule's three arms, asserted here through
 * {@link ruleVisibleTo} rather than restated — but the other two arms are deliberately
 * excluded: the author already has `sandboxed`, the moderator has the review queue, and
 * both of them reach sandboxed rows with `PHOENIX_CAYLAK_VISIBILITY` off, which would
 * strand the marker outside its containment flag. Only `seesSandboxedInPlace` is
 * flag-gated, so riding it is what makes the field structurally `false` everywhere while
 * the flag is off.
 *
 * Derived from the resolved {@link SandboxViewer} the read already carries — never from
 * anything a client supplies (#4313 is the shipped instance of that failure).
 */
export const sandboxedInPlace = (record: OwnerSandboxRecord, viewer: SandboxViewer): boolean =>
	record.sandboxedAt != null &&
	viewer.seesSandboxedInPlace &&
	ruleVisibleTo(lifecycleVisibilityRule.Sandboxed, record.authorId, viewer);

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
