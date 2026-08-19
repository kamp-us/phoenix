/**
 * `Profile`'s one field map — the row construction site, the wire shaper, and the
 * view field declaration all derive from it, so a one-field change touches this file
 * instead of three hand-synced restatements.
 *
 * A `Profile` has no single DB record behind it (identity row + three computed
 * counts), so `ProfileRow` IS the source. The one divergence is the client
 * normalization key `id` (=== `userId`), stamped by `toProfile`: not on the row, but
 * part of the pinned view field set below.
 */

export interface ProfileRow {
	userId: string;
	username: string;
	displayName: string | null;
	image: string | null;
	totalKarma: number;
	definitionCount: number;
	postCount: number;
	commentCount: number;
}

/**
 * Must stay a static literal — fate's `FateDataView` reads the field map off it. The
 * `satisfies` pins it to exactly the row's fields plus `id`, so dropping one here (or
 * adding one to `ProfileRow` without listing it) is a compile error.
 */
export const profileViewFields = {
	id: true,
	userId: true,
	username: true,
	displayName: true,
	image: true,
	totalKarma: true,
	definitionCount: true,
	postCount: true,
	commentCount: true,
} as const satisfies Record<keyof ProfileRow | "id", true>;
