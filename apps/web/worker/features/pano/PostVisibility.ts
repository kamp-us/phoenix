/**
 * The pano-local composition layer of the visibility seam (ADR 0113). `EntityLifecycle`
 * stays the closed 3-state union; draft-private-to-author is a `post_record`-only concept
 * (`is_draft`), so it layers on here rather than becoming a fourth union arm. The draft
 * gate has NO moderator exemption — unlike the sandbox arm, an unpublished draft is
 * private to its author and no one else (ADR 0113 §2).
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

export const postVisibleTo = (
	lifecycle: EntityLifecycle,
	isDraft: boolean,
	authorId: string,
	viewer: SandboxViewer,
): boolean =>
	isVisibleTo(lifecycle, authorId, viewer) && (!isDraft || viewer.viewerId === authorId);

export interface PostVisibleColumns extends SandboxColumns {
	readonly isDraft: SQLWrapper;
}

/**
 * `is_draft IS NOT 1` (not `= 0`) is the null-safe "not a draft" test: published rows
 * store `is_draft` as NULL, so `= 0` would wrongly exclude every published post (#746).
 * No moderator branch (ADR 0113).
 */
const draftArm = (cols: PostVisibleColumns, viewer: SandboxViewer): SQL | undefined => {
	const notDraft = sql`${cols.isDraft} is not 1`;
	if (viewer.viewerId !== null) return or(notDraft, eq(cols.authorId, viewer.viewerId));
	return notDraft;
};

/**
 * The SQL mirror of {@link postVisibleTo}. Carries no `removed_at IS NULL` guard — the
 * caller keeps its own beside this, or routes through {@link publicLivePostWhere}.
 */
export const postVisibleWhere = (
	cols: PostVisibleColumns,
	viewer: SandboxViewer,
): SQL | undefined => and(sandboxVisibleWhere(cols, viewer), draftArm(cols, viewer));

export interface PublicLivePostColumns extends PublicLiveColumns {
	readonly isDraft: SQLWrapper;
}

/**
 * The one predicate a post landing-count path folds its hand-written
 * removed/sandboxed/draft re-derivation onto (#1407).
 */
export const publicLivePostWhere = (
	cols: PublicLivePostColumns,
	viewer: SandboxViewer,
): SQL | undefined => and(publicLiveWhere(cols, viewer), draftArm(cols, viewer));
