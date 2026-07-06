/**
 * The canonical profile activity-tile order (#2203) — factored DOM-free so the ONE
 * ordering shared by both profile surfaces (`/profile` and `/u/:username`) is
 * unit-testable without a DOM (the pure-extraction idiom of `profileStandingLabel`
 * / `shouldShowCaylakStatus`). Before this the two hand-derived headers rendered
 * the same activity scalars in two different orders (`ProfilePage` had
 * `[başlık, yorum, tanım]`, `UserProfileHeader` had `[tanım, başlık, yorum]`); this
 * is the single source they now share.
 *
 * Canonical order is `[tanım, başlık, yorum]` — sözlük is definition-first, so the
 * tanım count leads. The flag-gated `karma` tile is appended by `ProfileHeader`
 * (via the shared `Karma` atom, `PHOENIX_AUTHORSHIP_LOOP` seam), so it stays
 * structurally last and never enters this reorderable set.
 */

export interface ProfileActivityCounts {
	readonly definitionCount: number;
	readonly postCount: number;
	readonly commentCount: number;
}

export interface ProfileStatTile {
	/** Stable React key + the tile's identity. */
	readonly key: "definitions" | "posts" | "comments";
	/** The `data-testid` the profile e2e keys on. */
	readonly testId: string;
	readonly value: number;
	/** Lowercase-Turkish tile label. */
	readonly label: string;
}

export function profileStatTiles(counts: ProfileActivityCounts): ProfileStatTile[] {
	return [
		{key: "definitions", testId: "stat-definitions", value: counts.definitionCount, label: "tanım"},
		{key: "posts", testId: "stat-posts", value: counts.postCount, label: "başlık"},
		{key: "comments", testId: "stat-comments", value: counts.commentCount, label: "yorum"},
	];
}
