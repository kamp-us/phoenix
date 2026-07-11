/**
 * mecmua's post-visibility seam — the draft/publish mask (epic #2467, #2463).
 *
 * Deliberately SIMPLER than pano's `PostVisibility`: mecmua has no çaylak sandbox,
 * so there is NO sandbox arm and no moderator exemption to compose. Visibility is a
 * single axis — published vs. draft. A post is public once `published_at` is set;
 * while it is null the post is a draft, private to its author and no one else.
 *
 * Two pure layers (no service), mirroring the pano pair:
 * - {@link mecmuaPostVisibleTo} — the in-memory decision.
 * - {@link mecmuaPostVisibleWhere} — its SQL mirror.
 */
import {eq, or, type SQL, type SQLWrapper, sql} from "drizzle-orm";

/**
 * The viewer a mecmua visibility decision is made against — just the signed-in
 * account id (null = anonymous/public). No `canSeeSandboxed`: mecmua has no
 * sandbox, so the draft gate is author-only with no moderator branch.
 */
export interface MecmuaPostViewer {
	readonly viewerId: string | null;
}

/** An anonymous/public viewer — sees only published posts. The safe default. */
export const anonymousMecmuaViewer: MecmuaPostViewer = {viewerId: null};

/**
 * The in-memory visibility decision: a post is visible to `viewer` iff it is
 * published (`publishedAt !== null`) OR the viewer authored it. A null
 * `publishedAt` (draft) is masked from everyone but its author.
 */
export const mecmuaPostVisibleTo = (
	publishedAt: Date | null,
	authorId: string,
	viewer: MecmuaPostViewer,
): boolean => publishedAt !== null || viewer.viewerId === authorId;

/** The `published_at` + `author_id` columns {@link mecmuaPostVisibleWhere} reads. */
export interface MecmuaPostVisibleColumns {
	readonly publishedAt: SQLWrapper;
	readonly authorId: SQLWrapper;
}

/**
 * The per-row SQL mirror of {@link mecmuaPostVisibleTo}. `published_at IS NOT NULL`
 * is the null-safe published test — a null draft yields false, correctly masking it,
 * with no `= 1`-style comparison that a NULL would defeat. A signed-in viewer
 * additionally sees their own drafts via `author_id = :viewerId`; an anonymous read
 * reduces to the bare published test.
 */
export const mecmuaPostVisibleWhere = (
	cols: MecmuaPostVisibleColumns,
	viewer: MecmuaPostViewer,
): SQL | undefined => {
	const isPublished = sql`${cols.publishedAt} is not null`;
	if (viewer.viewerId !== null) return or(isPublished, eq(cols.authorId, viewer.viewerId));
	return isPublished;
};
