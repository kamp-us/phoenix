/**
 * Shared keyset-pagination primitives (ADR 0019). Five service methods page
 * forward over a DB keyset; each used to hand-roll the lexicographic
 * "rows strictly after the cursor" predicate and the `LIMIT first+1` page
 * envelope. The mixed-direction copies (`(score desc, createdAt asc, id asc)`)
 * silently break on a field change, so the predicate is single-sourced here and
 * unit-tested.
 */

import {and, eq, gt, lt, or, type SQL, type SQLWrapper} from "drizzle-orm";

export type KeysetDir = "asc" | "desc";

/**
 * One column of a keyset tuple. A `null` `value` drops the column from the
 * comparison entirely (no inequality arm, no equality term in later arms) —
 * reproducing the term-summary `recent` fallback where a null `lastActivityAt`
 * cursor degrades to the tiebreaker-only predicate. The value type is loose
 * because keyset columns span dates, numbers, and strings.
 */
export interface KeysetKey {
	readonly column: SQLWrapper;
	readonly dir: KeysetDir;
	readonly value: unknown;
}

/**
 * Build the lexicographic "strictly after the cursor" predicate for a keyset
 * tuple ordered by `keys`. For columns `(c1 dir1, …, cn dirn)` with cursor
 * values `(v1, …, vn)` the predicate is
 *
 *   OR_i ( c1 = v1 AND … AND c_{i-1} = v_{i-1} AND cmp_i(c_i, v_i) )
 *
 * where `cmp` is `<` for `desc` and `>` for `asc`. Columns whose cursor `value`
 * is `null` are skipped. Returns `undefined` when no cursor column is usable (no
 * keys, or every value null), so callers apply only their base `WHERE`.
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
 * The single assembly point for the `{rows, hasNextPage, endCursor}` envelope
 * shared by all five keyset methods (each adds its own `totalCount`).
 */
export interface ForwardPage<TRow> {
	readonly rows: TRow[];
	readonly hasNextPage: boolean;
	readonly endCursor: string | null;
}

/**
 * Slice a `LIMIT first + 1` probe into a forward page; `first` is clamped to at
 * least 1 defensively.
 */
// Identity-default overload: when no `mapRow` is given the fetched row IS the
// page row, so `TRow` collapses to `TFetched` and the default identity is
// well-typed (no cast). The two-type-param overload is for callers that map
// `TFetched → TRow` and always pass `mapRow` explicitly.
export function forwardPage<TRow>(
	fetched: ReadonlyArray<TRow>,
	first: number,
	cursorOf: (row: TRow) => string,
): ForwardPage<TRow>;
export function forwardPage<TFetched, TRow>(
	fetched: ReadonlyArray<TFetched>,
	first: number,
	cursorOf: (row: TRow) => string,
	mapRow: (row: TFetched) => TRow,
): ForwardPage<TRow>;
export function forwardPage<TRow>(
	fetched: ReadonlyArray<unknown>,
	first: number,
	cursorOf: (row: TRow) => string,
	mapRow?: (row: never) => TRow,
): ForwardPage<TRow> {
	const limit = Math.max(1, first);
	const hasNextPage = fetched.length > limit;
	const slicedSource = hasNextPage ? fetched.slice(0, limit) : fetched;
	const rows: TRow[] = slicedSource.map((row) => (mapRow ? mapRow(row as never) : (row as TRow)));
	const last = rows.at(-1) ?? null;
	return {
		rows,
		hasNextPage,
		endCursor: last ? cursorOf(last) : null,
	};
}
