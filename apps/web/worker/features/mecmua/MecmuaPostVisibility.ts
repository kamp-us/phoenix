/**
 * mecmua's post-visibility seam — the draft/publish mask.
 *
 * Deliberately SIMPLER than pano's `PostVisibility`: mecmua has no çaylak sandbox, so
 * there is NO sandbox arm and no moderator exemption. One axis — published vs. draft.
 */
import {eq, or, type SQL, type SQLWrapper, sql} from "drizzle-orm";

/** `viewerId` null = anonymous. No `canSeeSandboxed`: the draft gate is author-only. */
export interface MecmuaPostViewer {
	readonly viewerId: string | null;
}

export const anonymousMecmuaViewer: MecmuaPostViewer = {viewerId: null};

/** Visible iff published OR the viewer authored it — a draft is masked from everyone else. */
export const mecmuaPostVisibleTo = (
	publishedAt: Date | null,
	authorId: string,
	viewer: MecmuaPostViewer,
): boolean => publishedAt !== null || viewer.viewerId === authorId;

export interface MecmuaPostVisibleColumns {
	readonly publishedAt: SQLWrapper;
	readonly authorId: SQLWrapper;
}

/**
 * The per-row SQL mirror of {@link mecmuaPostVisibleTo}. `IS NOT NULL` is the null-safe
 * test — a `= 1`-style comparison would be defeated by a NULL.
 */
export const mecmuaPostVisibleWhere = (
	cols: MecmuaPostVisibleColumns,
	viewer: MecmuaPostViewer,
): SQL | undefined => {
	const isPublished = sql`${cols.publishedAt} is not null`;
	if (viewer.viewerId !== null) return or(isPublished, eq(cols.authorId, viewer.viewerId));
	return isPublished;
};
