/**
 * Turkish letter identity and collation for the sözlük letter index.
 *
 * SQLite's `lower()` and its default BINARY collation are both ASCII-only: `Ç` never folds to
 * `ç`, and `ı` (U+0131) sorts AFTER `i` because UTF-8 compares bytes. Both answers are wrong for
 * a Turkish reader, so the letter filter and the letter page's ordering run over a *collation
 * key* instead — every Turkish letter rewritten to the ASCII character its alphabet position
 * earns, so the database's own byte order IS the Turkish order.
 *
 * The key is a pure function of the headword, so the cursor's key ({@link turkishCollationKey})
 * and the page's `ORDER BY` ({@link turkishCollateSql}) both derive from the ONE alphabet table
 * in `turkish-alphabet.ts` — the same single-declaration rule `db/ordering.ts` holds for a
 * keyset (ADR 0019). The JS fold and the SQL fold must therefore stay step-identical, which is
 * why the JS side folds `A`-`Z` by hand rather than calling `toLocaleLowerCase("tr")`: that
 * would also fold characters SQLite's `lower()` leaves alone, and the cursor would then land off
 * the page it cut.
 */

import {type SQL, type SQLWrapper, sql} from "drizzle-orm";
import {
	foldTurkishChar,
	TURKISH_ALPHABET,
	turkishLetterIndex,
	UPPERCASE_FOLD,
} from "./turkish-alphabet.ts";

export {
	foldTurkishChar,
	isTurkishLetter,
	storedFirstLetter,
	TURKISH_ALPHABET,
	type TurkishLetter,
	turkishLetterOf,
} from "./turkish-alphabet.ts";

/**
 * The key alphabet starts at `A`, so the 29 letters land on `A`..`]` — 29 consecutive ASCII code
 * points whose byte order is the Turkish order. Space, `-` and the digits all sit below `A` and
 * keep sorting ahead of every letter; `q`, `w`, `x` and any other unmapped character sit above
 * `]` and sort after `z`, which is where Turkish puts its foreign letters.
 */
const KEY_ORIGIN = "A".charCodeAt(0);

const keyChar = (index: number): string => String.fromCharCode(KEY_ORIGIN + index);

/** The sortable key for one headword. Compare two keys byte-wise and you get Turkish order. */
export function turkishCollationKey(text: string): string {
	let key = "";
	for (const char of text) {
		const folded = foldTurkishChar(char);
		const index = turkishLetterIndex(folded);
		key += index === -1 ? folded : keyChar(index);
	}
	return key;
}

/** Turkish-order comparison of two headwords. */
export function compareTurkish(left: string, right: string): number {
	const a = turkishCollationKey(left);
	const b = turkishCollationKey(right);
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The half-open key range every headword starting with `letter` falls in. Filtering and ordering
 * then share one expression: the letter page is `key >= start AND key < end`, and its keyset
 * walks that same key.
 */
export function turkishLetterKeyRange(
	letter: string,
): {readonly start: string; readonly end: string} | null {
	const index = turkishLetterIndex(foldTurkishChar(letter.charAt(0)));
	if (index === -1) return null;
	return {start: keyChar(index), end: keyChar(index + 1)};
}

/**
 * A SQL text literal for one character of the fold table.
 *
 * The fold is INLINED rather than bound, and that is load-bearing: D1 caps a statement at 100
 * bound parameters, and the expression below nests 36 `replace()` calls, each of which would
 * bind two. One instance costs 72 parameters, and the letter page embeds the expression in its
 * `ORDER BY`, in both bounds of the letter range and inside the keyset predicate — 219 bound
 * parameters on a first page and 366 on a cursor page, so D1 rejected every letter read and the
 * page served neither rows nor an empty state (#9267).
 *
 * Inlining is safe because the operand is never user input: every character comes from this
 * module's own compile-time alphabet table or from {@link keyChar}'s ASCII output. Quote-doubling
 * keeps that safety a property of the function rather than of the table's current contents.
 */
const foldLiteral = (value: string): SQL => sql.raw(`'${value.replaceAll("'", "''")}'`);

/** The SQL form of {@link turkishCollationKey}, step for step, over a text column. */
export function turkishCollateSql(column: SQLWrapper): SQL<string> {
	let expression = sql`${column}`;
	for (const [upper, lower] of UPPERCASE_FOLD) {
		expression = sql`replace(${expression}, ${foldLiteral(upper)}, ${foldLiteral(lower)})`;
	}
	expression = sql`lower(${expression})`;
	TURKISH_ALPHABET.forEach((letter, index) => {
		expression = sql`replace(${expression}, ${foldLiteral(letter)}, ${foldLiteral(keyChar(index))})`;
	});
	return expression as SQL<string>;
}
