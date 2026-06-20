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
 * The cursor-resolution decision, lifted above the DB read so it is pure and
 * unit-testable with no SQL engine (ADR 0082: cursor resolution is a *port*, the
 * keyset/cursor-miss decision is pure). A keyset page first resolves an opaque
 * `after` cursor to the row's keyset tuple via a thin DB-read port; this type is
 * the *outcome* of that resolution, and `resolveCursor` is the pure decision over
 * `(after, resolved-row-or-null)`:
 *
 *   - no cursor — `after` was absent: page from the head, no predicate.
 *   - miss      — `after` was present but resolved to no row: the shared
 *                 cursor-miss-empty-page semantic (the cursor no longer points at
 *                 a live row / matching doc).
 *   - hit       — `after` resolved to `row`: page strictly after it.
 */
export type CursorResolution<TRow> =
	| {readonly kind: "no-cursor"}
	| {readonly kind: "miss"}
	| {readonly kind: "hit"; readonly row: TRow};

/**
 * The pure cursor-miss decision. Given the requested `after` and the row the port
 * read for it (`null`/`undefined` when the port found none), decide the branch:
 * absent `after` → `no-cursor` (head page); present `after` + no row → `miss`
 * (caller returns the empty page); present `after` + row → `hit` (caller builds
 * the keyset predicate). The DB read that produces `resolvedRow` stays below the
 * seam as the port; this is the decision, callable with no database.
 */
export function resolveCursor<TRow>(
	after: string | null | undefined,
	resolvedRow: TRow | null | undefined,
): CursorResolution<TRow> {
	if (!after) return {kind: "no-cursor"};
	if (resolvedRow == null) return {kind: "miss"};
	return {kind: "hit", row: resolvedRow};
}

/** The page returned on a cursor miss — pure, so the miss branch carries no DB read. */
export interface EmptyKeysetPage {
	readonly rows: never[];
	readonly hasNextPage: false;
	readonly endCursor: null;
}

export const emptyKeysetPage: EmptyKeysetPage = {
	rows: [],
	hasNextPage: false,
	endCursor: null,
};

/**
 * The single assembly point for the `{rows, hasNextPage, endCursor}` forward
 * keyset page envelope — shared by all five keyset methods (each adds its own
 * `totalCount`) and by the `toConnection` adapter, which imports this same
 * declaration (`features/fate/connection.ts`) so producer and adapter agree by a
 * shared type, not by structural coincidence.
 */
export interface KeysetPage<TRow> {
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
): KeysetPage<TRow>;
export function forwardPage<TFetched, TRow>(
	fetched: ReadonlyArray<TFetched>,
	first: number,
	cursorOf: (row: TRow) => string,
	mapRow: (row: TFetched) => TRow,
): KeysetPage<TRow>;
export function forwardPage<TRow>(
	fetched: ReadonlyArray<unknown>,
	first: number,
	cursorOf: (row: TRow) => string,
	mapRow?: (row: never) => TRow,
): KeysetPage<TRow> {
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
