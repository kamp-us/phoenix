/**
 * `MecmuaPost`'s one column→field map — the single structure the view field declaration and
 * the record→row mapper both derive from, so a one-field change touches this map instead of
 * two hand-synced restatements.
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

// `satisfies Record<keyof MecmuaPostRow, true>` pins this to exactly the row's fields:
// dropping one (or adding one to the row without listing it) is a compile error.
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
