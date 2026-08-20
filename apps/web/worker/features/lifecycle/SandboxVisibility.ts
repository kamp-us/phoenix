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
	ruleVisibleTo,
	type SandboxViewer,
} from "./EntityLifecycle.ts";

/**
 * The viewer axis of a sandbox-masked read: a RESOLVED {@link SandboxViewer}, required.
 * Every masked Pano/Sözlük read's options carry this, so a call site cannot reach the
 * mask without first resolving who is asking — the omission is a compile error rather
 * than something a reviewer has to grep for (#6586).
 *
 * That mattered because omitting it was silent and wrong in one direction only: the
 * degraded viewer {@link resolveSandboxViewer} used to synthesize reads `false` on both
 * elevated axes, so a write's re-read masked out the very row the write had just
 * committed — `null` back from a landed mutation (#6473 for the author arm, #6424 for
 * the moderator/in-place arms).
 */
export interface MaskedReadOptions {
	readonly sandboxViewer: SandboxViewer;
}

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
 *
 * The Pano/Sözlük content reads no longer reach this: their viewer is
 * {@link MaskedReadOptions}-required, so there is nothing to degrade FROM. It survives
 * for `Pasaport`'s profile reads, whose options are shaped by the profile being viewed
 * rather than by a resolved reader.
 */
export const resolveSandboxViewer = (opts: {
	readonly viewerId?: string | null | undefined;
	readonly sandboxViewer?: SandboxViewer | undefined;
}): SandboxViewer =>
	opts.sandboxViewer ??
	(opts.viewerId != null
		? {viewerId: opts.viewerId, canSeeSandboxed: false, seesSandboxedInPlace: false}
		: anonymousViewer);

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
 *
 * Every aggregate over a masked read — a connection's `totalCount`, the hot-score
 * ordering, `publicLiveWhere` — is built on this predicate, so widening the viewer
 * widens the aggregates with it. That is the decision, not an oversight (#6424): a list
 * that shows a row its own count excludes is worse than either consistent answer, so
 * there is exactly one mask and the counts follow the viewer that produced the rows.
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
