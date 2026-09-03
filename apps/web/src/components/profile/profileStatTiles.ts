/**
 * The one activity-tile order both profile surfaces share (#2203). `[tanım, başlık,
 * yorum]` — sözlük is definition-first, so the tanım count leads. The owner-only
 * `karma` tile is appended by `ProfileHeader` and deliberately stays out of this
 * reorderable set.
 */
import type {CatalogKey} from "../../i18n/keys";

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
	readonly labelKey: CatalogKey;
}

export function profileStatTiles(counts: ProfileActivityCounts): ProfileStatTile[] {
	return [
		{
			key: "definitions",
			testId: "stat-definitions",
			value: counts.definitionCount,
			labelKey: "profile.stat.definitions",
		},
		{key: "posts", testId: "stat-posts", value: counts.postCount, labelKey: "profile.stat.posts"},
		{
			key: "comments",
			testId: "stat-comments",
			value: counts.commentCount,
			labelKey: "profile.stat.comments",
		},
	];
}
