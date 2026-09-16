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
 * below — the same single-declaration rule `db/ordering.ts` holds for a keyset (ADR 0019). The
 * JS fold and the SQL fold must therefore stay step-identical, which is why the JS side folds
 * `A`-`Z` by hand rather than calling `toLocaleLowerCase("tr")`: that would also fold characters
 * SQLite's `lower()` leaves alone, and the cursor would then land off the page it cut.
 */

import {type SQL, type SQLWrapper, sql} from "drizzle-orm";

/** The 29 letters of the Turkish alphabet, in order. */
export const TURKISH_ALPHABET = [
	"a",
	"b",
	"c",
	"ç",
	"d",
	"e",
	"f",
	"g",
	"ğ",
	"h",
	"ı",
	"i",
	"j",
	"k",
	"l",
	"m",
	"n",
	"o",
	"ö",
	"p",
	"r",
	"s",
	"ş",
	"t",
	"u",
	"ü",
	"v",
	"y",
	"z",
] as const;

export type TurkishLetter = (typeof TURKISH_ALPHABET)[number];

const LETTERS: readonly string[] = TURKISH_ALPHABET;

/**
 * The uppercase forms SQLite's ASCII `lower()` cannot fold, each paired with the letter it
 * belongs to. `I` → `ı` and `İ` → `i` are the Turkish pair: the dotless capital is the dotless
 * letter's, never `i`'s. Applied BEFORE `lower()` on the SQL side, or `I` would fold to `i`.
 */
const UPPERCASE_FOLD: ReadonlyArray<readonly [string, TurkishLetter]> = [
	["I", "ı"],
	["İ", "i"],
	["Ç", "ç"],
	["Ğ", "ğ"],
	["Ö", "ö"],
	["Ş", "ş"],
	["Ü", "ü"],
];

const UPPER_TO_LETTER = new Map<string, string>(UPPERCASE_FOLD);

/**
 * The key alphabet starts at `A`, so the 29 letters land on `A`..`]` — 29 consecutive ASCII code
 * points whose byte order is the Turkish order. Space, `-` and the digits all sit below `A` and
 * keep sorting ahead of every letter; `q`, `w`, `x` and any other unmapped character sit above
 * `]` and sort after `z`, which is where Turkish puts its foreign letters.
 */
const KEY_ORIGIN = "A".charCodeAt(0);

const keyChar = (index: number): string => String.fromCharCode(KEY_ORIGIN + index);

/** The one fold both sides share: the seven Turkish capitals, then plain ASCII `A`-`Z`. */
export function foldTurkishChar(char: string): string {
	const paired = UPPER_TO_LETTER.get(char);
	if (paired !== undefined) return paired;
	return char >= "A" && char <= "Z" ? char.toLowerCase() : char;
}

/**
 * The alphabet letter a headword files under, or `null` when it starts with a digit, punctuation
 * or a letter outside the Turkish alphabet — those belong to no letter page.
 */
export function turkishLetterOf(headword: string): TurkishLetter | null {
	const folded = foldTurkishChar(headword.charAt(0));
	return LETTERS.includes(folded) ? (folded as TurkishLetter) : null;
}

/** The sortable key for one headword. Compare two keys byte-wise and you get Turkish order. */
export function turkishCollationKey(text: string): string {
	let key = "";
	for (const char of text) {
		const folded = foldTurkishChar(char);
		const index = LETTERS.indexOf(folded);
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
	const index = LETTERS.indexOf(foldTurkishChar(letter.charAt(0)));
	if (index === -1) return null;
	return {start: keyChar(index), end: keyChar(index + 1)};
}

/** The SQL form of {@link turkishCollationKey}, step for step, over a text column. */
export function turkishCollateSql(column: SQLWrapper): SQL<string> {
	let expression = sql`${column}`;
	for (const [upper, lower] of UPPERCASE_FOLD) {
		expression = sql`replace(${expression}, ${upper}, ${lower})`;
	}
	expression = sql`lower(${expression})`;
	LETTERS.forEach((letter, index) => {
		expression = sql`replace(${expression}, ${letter}, ${keyChar(index)})`;
	});
	return expression as SQL<string>;
}
