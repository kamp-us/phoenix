/**
 * The pano-local composition layer of the visibility seam (ADR 0113). `EntityLifecycle`
 * stays the closed 3-state union (Live | Sandboxed | Removed); the fourth content state,
 * draft-private-to-author, is a `post_record`-only concept (`is_draft`), so it composes
 * HERE — layered on the shared lifecycle decision — rather than as a fourth union arm.
 *
 * Two layers, both pure (no service), mirroring the shared `EntityLifecycle.isVisibleTo`
 * / `SandboxVisibility.sandboxVisibleWhere` pair:
 *
 * - {@link postVisibleTo} — the in-memory decision, the shared `isVisibleTo` `&&`'d with
 *   the author-only draft gate.
 * - {@link postVisibleWhere} — its SQL mirror, `sandboxVisibleWhere` `and()`'d with the
 *   draft arm; like the sandbox predicate it carries NO `removed_at IS NULL` guard (the
 *   caller `and()`s its own, or uses {@link publicLivePostWhere}).
 * - {@link publicLivePostWhere} — the post-aware public-live aggregate: `publicLiveWhere`
 *   (removed + sandbox) `and()`'d with the draft arm, the single predicate #1407's post
 *   landing-count paths fold their hand-written removed/sandboxed/draft re-derivations onto.
 *
 * The draft gate has NO moderator exemption — unlike the sandbox arm, an unpublished draft
 * is not moderation-relevant, so it is private to its author and no one else (ADR 0113 §2).
 */
import {and, eq, or, type SQL, type SQLWrapper, sql} from "drizzle-orm";
import {
	type EntityLifecycle,
	isVisibleTo,
	type SandboxViewer,
} from "../lifecycle/EntityLifecycle.ts";
import {
	type PublicLiveColumns,
	publicLiveWhere,
	type SandboxColumns,
	sandboxVisibleWhere,
} from "../lifecycle/SandboxVisibility.ts";

/**
 * The in-memory post visibility decision (ADR 0113): the shared 3-state lifecycle
 * decision composed with the author-only draft gate. A post is visible to `viewer` iff
 * its lifecycle is visible to them AND (it is not a draft OR they authored it) — drafts
 * are author-only with NO moderator exemption, the one place this diverges from the
 * sandbox arm's author-or-moderator rule.
 */
export const postVisibleTo = (
	lifecycle: EntityLifecycle,
	isDraft: boolean,
	authorId: string,
	viewer: SandboxViewer,
): boolean =>
	isVisibleTo(lifecycle, authorId, viewer) && (!isDraft || viewer.viewerId === authorId);

/** The sandbox columns plus the `post_record`-only `is_draft` marker. */
export interface PostVisibleColumns extends SandboxColumns {
	readonly isDraft: SQLWrapper;
}

/**
 * The SQL draft arm — the `is_draft` half of {@link postVisibleTo}. `is_draft IS NOT 1`
 * (not `= 0`) is the null-safe "not a draft" test: published rows store `is_draft` as
 * NULL (the taslak marker is nullable, no default), so `= 0` would wrongly exclude every
 * published post — `IS NOT 1` is the exact form the pre-seam public feed already used
 * (post-operations.ts, #746), keeping behavior unchanged. No moderator branch (ADR 0113).
 *
 * - anonymous (`viewerId === null`) → `is_draft IS NOT 1`
 * - signed-in → `is_draft IS NOT 1 OR author_id = :viewerId`
 */
const draftArm = (cols: PostVisibleColumns, viewer: SandboxViewer): SQL | undefined => {
	const notDraft = sql`${cols.isDraft} is not 1`;
	if (viewer.viewerId !== null) return or(notDraft, eq(cols.authorId, viewer.viewerId));
	return notDraft;
};

/**
 * The per-row SQL mirror of {@link postVisibleTo}: {@link sandboxVisibleWhere} `and()`'d
 * with the draft arm. Carries no `removed_at IS NULL` guard — the caller keeps its own
 * beside this (like `sandboxVisibleWhere`), or routes through {@link publicLivePostWhere}.
 */
export const postVisibleWhere = (
	cols: PostVisibleColumns,
	viewer: SandboxViewer,
): SQL | undefined => and(sandboxVisibleWhere(cols, viewer), draftArm(cols, viewer));

/** The public-live aggregate columns plus the `post_record`-only `is_draft` marker. */
export interface PublicLivePostColumns extends PublicLiveColumns {
	readonly isDraft: SQLWrapper;
}

/**
 * The post-aware public-live aggregate (#1407 seam): {@link publicLiveWhere} (removed +
 * sandbox) `and()`'d with the draft arm — the single predicate a post landing-count path
 * folds its hand-written `removed_at IS NULL AND sandboxed_at IS NULL AND is_draft IS NOT 1`
 * re-derivation onto. For an anonymous viewer it reduces to exactly that conjunction.
 */
export const publicLivePostWhere = (
	cols: PublicLivePostColumns,
	viewer: SandboxViewer,
): SQL | undefined => and(publicLiveWhere(cols, viewer), draftArm(cols, viewer));
