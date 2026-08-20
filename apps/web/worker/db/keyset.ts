/** Shared keyset-pagination primitives. See ADR 0019. */

import {and, eq, gt, lt, or, type SQL, type SQLWrapper} from "drizzle-orm";

export type KeysetDir = "asc" | "desc";

/**
 * One column of a keyset tuple. A `null` `value` drops the column from the comparison
 * entirely — no inequality arm, and no equality term in the later arms either.
 */
export interface KeysetKey {
	readonly column: SQLWrapper;
	readonly dir: KeysetDir;
	readonly value: unknown;
}

/**
 * The lexicographic "strictly after the cursor" predicate. Returns `undefined` when no
 * cursor column is usable, so the caller applies only its base `WHERE`.
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

/** The cursor-resolution outcome, lifted above the DB read so it stays pure (ADR 0082). */
export type CursorResolution<TRow> =
	| {readonly kind: "no-cursor"}
	| {readonly kind: "miss"}
	| {readonly kind: "hit"; readonly row: TRow};

/** A present `after` that resolves to no row is a `miss`, not a head page. */
export function resolveCursor<TRow>(
	after: string | null | undefined,
	resolvedRow: TRow | null | undefined,
): CursorResolution<TRow> {
	if (!after) return {kind: "no-cursor"};
	if (resolvedRow == null) return {kind: "miss"};
	return {kind: "hit", row: resolvedRow};
}

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
 * The forward page envelope. `features/fate/connection.ts` imports this same
 * declaration, so producer and adapter agree by type, not structural coincidence.
 */
export interface KeysetPage<TRow> {
	readonly rows: TRow[];
	readonly hasNextPage: boolean;
	readonly endCursor: string | null;
}

/**
 * Slice a `LIMIT first + 1` probe into a forward page. Two overloads: without `mapRow`
 * the fetched row IS the page row, so `TRow` collapses to `TFetched` and the identity
 * default stays well-typed with no cast.
 */
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
