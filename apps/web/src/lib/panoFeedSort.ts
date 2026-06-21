/**
 * The pano feed **sort** vocabulary — the single home for the closed set of
 * feed sorts and each sort's lead ordering column.
 *
 * A plain-string/const module (no React, no worker, no DB import) cross-included
 * by the worker tsconfig, so the SPA chip→sort map (`PanoFeed.tsx`), the resolver
 * allow-list (`lists.ts` `toPostSort`), and the service's two keyset branches
 * (`Pano.ts`) all name the same four sorts and the same per-sort lead column.
 * One home per sort means SPA-vs-server drift — and the service's own
 * keyset-vs-`orderBy` disagreement — is a type error, not a silent ship;
 * mirroring `src/lib/panoTags.ts` / `src/lib/fateWireCodes.ts`.
 *
 * Each sort orders by an optional lead column (always descending) plus an `id`
 * desc tiebreaker; `new` has no lead column (`id` alone). The lead column key
 * names a `post_record` column shared by the cursor row and the Drizzle table,
 * so the service resolves the actual column/cursor-value from this one key —
 * this module stays DB-free so both bundles can import it.
 */

export const POST_SORTS = ["hot", "new", "top", "discuss"] as const;

/** A typed feed sort — the resolved, in-enum value (not untyped text). */
export type PostSort = (typeof POST_SORTS)[number];

/** The default sort, served when an arg is absent or unrecognized. */
export const DEFAULT_POST_SORT: PostSort = "hot";

/**
 * Each sort's lead ordering column — a `post_record` column name shared by the
 * cursor row and the Drizzle table, or `null` for `new` (ordered by `id` alone).
 * Exhaustive over `PostSort`, so adding a sort without a lead column is a compile
 * error. The service derives BOTH its keyset cursor predicate and its `orderBy`
 * from this one map, so the two can no longer silently disagree.
 */
export const POST_SORT_LEAD_COLUMN: Record<PostSort, "score" | "commentCount" | "hotScore" | null> =
	{
		hot: "hotScore",
		new: null,
		top: "score",
		discuss: "commentCount",
	};

const ALLOWED: ReadonlySet<string> = new Set(POST_SORTS);

/**
 * Narrow a raw `sort` arg to a {@link PostSort}, falling back to
 * {@link DEFAULT_POST_SORT} for an absent or unrecognized value.
 */
export function toPostSort(value: string | undefined): PostSort {
	return value !== undefined && ALLOWED.has(value) ? (value as PostSort) : DEFAULT_POST_SORT;
}
