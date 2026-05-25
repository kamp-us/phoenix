/**
 * Shared keyset-pagination primitives.
 *
 * Five service methods page forward over a DB keyset — `Sozluk`'s
 * `listDefinitionsKeyset` / `listTermSummariesConnection`, `Pano`'s
 * `listPostsConnection` / `listCommentsKeyset`, and `Pasaport.listContributions`.
 * Each used to hand-roll the same two pieces: a lexicographic `or(lt, and(eq,
 * gt), …)` "rows strictly after the cursor" predicate, and a `LIMIT first+1` →
 * `slice(0, first)` → `{rows, hasNextPage, endCursor}` page envelope. The
 * mixed-direction copies (`(score desc, createdAt asc, id asc)`) are the ones
 * that silently break on a field change, so the predicate is single-sourced
 * here and unit-tested.
 *
 * Two exports:
 *   - `keysetAfter(keys)` — builds the lexicographic predicate from a list of
 *     `{column, dir, value}` so direction is declared per column.
 *   - `forwardPage(fetched, first, cursorOf)` — slices the `first+1` probe and
 *     assembles the page envelope. The only place the envelope is built.
 */

import {and, eq, gt, lt, or, type SQL, type SQLWrapper} from "drizzle-orm";

/** Sort direction for one keyset column. */
export type KeysetDir = "asc" | "desc";

/**
 * One column of a keyset tuple: the drizzle column to compare, its sort
 * direction, and the cursor row's value for that column.
 *
 * A `null` `value` drops the column from the comparison entirely (no inequality
 * arm, no equality term in later arms) — this reproduces the term-summary
 * `recent` fallback where a null `lastActivityAt` cursor degrades to the
 * tiebreaker-only predicate. `column` is the drizzle column / SQL expression;
 * the value type is intentionally loose because keyset columns span dates,
 * numbers, and strings.
 */
export interface KeysetKey {
	readonly column: SQLWrapper;
	readonly dir: KeysetDir;
	readonly value: unknown;
}

/**
 * Build the lexicographic "strictly after the cursor" predicate for a keyset
 * tuple ordered by `keys`.
 *
 * For columns `(c1 dir1, …, cn dirn)` with cursor values `(v1, …, vn)` the
 * predicate is the disjunction
 *
 *   OR_i ( c1 = v1 AND … AND c_{i-1} = v_{i-1} AND cmp_i(c_i, v_i) )
 *
 * where `cmp` is `<` for a `desc` column and `>` for an `asc` column — exactly
 * the row that follows the cursor in `ORDER BY c1 dir1, …, cn dirn`. Columns
 * whose cursor `value` is `null` are skipped (both their inequality arm and
 * their equality contribution), matching the legacy null-cursor fallback.
 *
 * Returns `undefined` when there is no usable cursor column (no keys, or every
 * value is null), so callers apply only their base `WHERE`.
 */
export function keysetAfter(keys: ReadonlyArray<KeysetKey>): SQL | undefined {
	const usable = keys.filter((k) => k.value !== null && k.value !== undefined);
	if (usable.length === 0) return undefined;

	const cmp = (key: KeysetKey): SQL =>
		key.dir === "desc" ? lt(key.column, key.value as never) : gt(key.column, key.value as never);

	const arms: SQL[] = usable.map((key, i) => {
		const equalities = usable.slice(0, i).map((k) => eq(k.column, k.value as never));
		const strict = cmp(key);
		return equalities.length === 0 ? strict : (and(...equalities, strict) as SQL);
	});

	if (arms.length === 1) return arms[0];
	return or(...arms) as SQL;
}

/**
 * The forward page after slicing the `first + 1` probe.
 *
 * `rows` is at most `first` long; `hasNextPage` reflects whether the probe row
 * existed; `endCursor` is `cursorOf(lastRow)` or `null` for an empty page. This
 * is the single assembly point for the `{rows, hasNextPage, endCursor}`
 * envelope shared by all five keyset methods (each adds its own `totalCount`).
 */
export interface ForwardPage<TRow> {
	readonly rows: TRow[];
	readonly hasNextPage: boolean;
	readonly endCursor: string | null;
}

/**
 * Slice a `LIMIT first + 1` probe into a forward page.
 *
 * Callers fetch `first + 1` rows; this trims the probe row, sets `hasNextPage`
 * from whether it was present, and derives `endCursor` from the last surviving
 * row via `cursorOf`. `first` is clamped to at least 1 defensively.
 */
export function forwardPage<TFetched, TRow = TFetched>(
	fetched: ReadonlyArray<TFetched>,
	first: number,
	cursorOf: (row: TRow) => string,
	mapRow: (row: TFetched) => TRow = (row) => row as unknown as TRow,
): ForwardPage<TRow> {
	const limit = Math.max(1, first);
	const hasNextPage = fetched.length > limit;
	const slicedSource = hasNextPage ? fetched.slice(0, limit) : fetched;
	const rows = slicedSource.map(mapRow);
	const last = rows.at(-1) ?? null;
	return {
		rows,
		hasNextPage,
		endCursor: last ? cursorOf(last) : null,
	};
}
