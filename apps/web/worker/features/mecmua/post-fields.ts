/**
 * `MecmuaPost`'s one column→field map — the single structure the view field
 * declaration (`MecmuaPostView` in `views.ts`) and the record→row mapper
 * (`toMecmuaPostRow`) both derive from, so a one-field change touches this map
 * instead of two hand-synced restatements (the pano `post-fields.ts` idiom, #1166).
 *
 * mecmua carries none of pano's link-sharing / viewer-scalar fields — it is a lean
 * long-form row: identity + başlık + markdown body + the `publishedAt` lifecycle
 * marker.
 */
import type * as schema from "../../db/drizzle/schema.ts";

type MecmuaPostRecord = typeof schema.mecmuaPost.$inferSelect;

export interface MecmuaPostRow {
	id: string;
	slug: string | null;
	title: string;
	body: string;
	authorId: string;
	/** null ⇒ draft, non-null ⇒ published — the mecmua lifecycle marker. */
	publishedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * The view/wire field selection — a static literal fate reads off `MecmuaPostView`.
 * `satisfies Record<keyof MecmuaPostRow, true>` pins it to exactly the row's fields:
 * dropping one here (or adding one to the row without listing it) is a compile
 * error, so the view can't drift from the row mapper.
 */
export const mecmuaPostViewFields = {
	id: true,
	slug: true,
	title: true,
	body: true,
	authorId: true,
	publishedAt: true,
	createdAt: true,
	updatedAt: true,
} as const satisfies Record<keyof MecmuaPostRow, true>;

/** Map a `mecmua_post` record onto its wire row — the single record→row seam. */
export const toMecmuaPostRow = (p: MecmuaPostRecord): MecmuaPostRow => ({
	id: p.id,
	slug: p.slug,
	title: p.title,
	body: p.body,
	authorId: p.authorId,
	publishedAt: p.publishedAt,
	createdAt: p.createdAt,
	updatedAt: p.updatedAt,
});
