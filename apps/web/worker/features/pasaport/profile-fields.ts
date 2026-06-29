/**
 * `Profile`'s one field map — the single declaration of `Profile`'s wire field
 * set, which the row's construction site (`Pasaport.hydrateProfile`, pinned
 * `satisfies ProfileRow`), the wire shaper (`toProfile` in `shapers.ts`), and the
 * view field declaration (`ProfileView` in `views.ts`) all derive from, so a
 * one-field change touches this map instead of three hand-synced restatements
 * (#1545, the pasaport half of fate-wire epic #1332). Shaped on
 * `sozluk/definition-fields.ts`.
 *
 * Unlike `User`, a `Profile` row has no single DB record to read from — it is
 * assembled from a `user_profile` identity row plus three computed authored-content
 * counts — so there is no record→row reader map; `ProfileRow` IS the single source.
 * The one read-time divergence is the client normalization key `id` (=== `userId`),
 * stamped by `toProfile`; `id` is therefore not on `ProfileRow` but is part of the
 * pinned view field set below.
 */

/** The assembled profile row: the identity tuple plus the three content counts. */
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
 * The view/wire scalar field selection (`{id: true, …}`) — a static literal (fate's
 * `FateDataView` reads the literal field map off this). `satisfies Record<keyof
 * ProfileRow | "id", true>` pins it to exactly the row's fields plus the `id`
 * normalization key: dropping one here (or adding one to `ProfileRow` without
 * listing it) is a compile error, so the view stays in lockstep with the row.
 * `contributions` is the list relation, declared structurally in `views.ts`.
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
