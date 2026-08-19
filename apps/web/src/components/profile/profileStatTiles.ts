/**
 * The one activity-tile order both profile surfaces share (#2203). `[tanım, başlık,
 * yorum]` — sözlük is definition-first, so the tanım count leads. The owner-only
 * `karma` tile is appended by `ProfileHeader` and deliberately stays out of this
 * reorderable set.
 */

export interface ProfileActivityCounts {
	readonly definitionCount: number;
	readonly postCount: number;
	readonly commentCount: number;
}

export interface ProfileStatTile {
	readonly key: "definitions" | "posts" | "comments";
	/** The `data-testid` the profile e2e keys on. */
	readonly testId: string;
	readonly value: number;
	readonly label: string;
}

export function profileStatTiles(counts: ProfileActivityCounts): ProfileStatTile[] {
	return [
		{key: "definitions", testId: "stat-definitions", value: counts.definitionCount, label: "tanım"},
		{key: "posts", testId: "stat-posts", value: counts.postCount, label: "başlık"},
		{key: "comments", testId: "stat-comments", value: counts.commentCount, label: "yorum"},
	];
}
