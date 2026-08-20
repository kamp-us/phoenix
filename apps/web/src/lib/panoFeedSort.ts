/**
 * The pano feed sort vocabulary — one home for the sorts and each sort's lead
 * ordering column, so SPA/server drift is a type error rather than a silent ship.
 *
 * Keep this module free of React, worker and DB imports: the worker tsconfig
 * cross-includes it, so both bundles have to be able to import it.
 */

export const POST_SORTS = ["hot", "new", "top", "discuss"] as const;

export type PostSort = (typeof POST_SORTS)[number];

export const DEFAULT_POST_SORT: PostSort = "hot";

/**
 * A `post_record` column name shared by the cursor row and the Drizzle table, or `null`
 * for `new` (`id` alone). The service derives BOTH its keyset cursor predicate and its
 * `orderBy` from this one map, so the two cannot silently disagree.
 */
export const POST_SORT_LEAD_COLUMN: Record<PostSort, "score" | "commentCount" | "hotScore" | null> =
	{
		hot: "hotScore",
		new: null,
		top: "score",
		discuss: "commentCount",
	};

const ALLOWED: ReadonlySet<string> = new Set(POST_SORTS);

export function toPostSort(value: string | undefined): PostSort {
	return value !== undefined && ALLOWED.has(value) ? (value as PostSort) : DEFAULT_POST_SORT;
}
