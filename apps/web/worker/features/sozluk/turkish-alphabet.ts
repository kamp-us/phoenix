/**
 * The Turkish alphabet, declared ONCE for both sides of the letter index (#9267).
 *
 * The strip in the SPA and the range function in the worker have to agree letter for letter, or
 * the strip links to a letter `turkishLetterKeyRange` answers `null` for and the reader lands on
 * a redirect. Two copies of a 29-row table cannot be kept in step by review, so there is one —
 * the same single-declaration rule ADR 0019 holds for a keyset's ordering.
 *
 * This module is deliberately a LEAF: it imports nothing, so the SPA can read the table without
 * `drizzle-orm` (and the rest of the query layer) following it into the client bundle. The SQL
 * and cursor halves of the collation live in `turkish-collation.ts`, which imports this.
 */

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

/** Narrows an arbitrary string to a letter the alphabet actually indexes. */
export function isTurkishLetter(value: string): value is TurkishLetter {
	return LETTERS.includes(value);
}

/**
 * The uppercase forms SQLite's ASCII `lower()` cannot fold, each paired with the letter it
 * belongs to. `I` → `ı` and `İ` → `i` are the Turkish pair: the dotless capital is the dotless
 * letter's, never `i`'s. Applied BEFORE `lower()` on the SQL side, or `I` would fold to `i`.
 */
export const UPPERCASE_FOLD: ReadonlyArray<readonly [string, TurkishLetter]> = [
	["I", "ı"],
	["İ", "i"],
	["Ç", "ç"],
	["Ğ", "ğ"],
	["Ö", "ö"],
	["Ş", "ş"],
	["Ü", "ü"],
];

const UPPER_TO_LETTER = new Map<string, string>(UPPERCASE_FOLD);

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
	return isTurkishLetter(folded) ? folded : null;
}

/**
 * The value `term_record.first_letter` stores for one headword: its alphabet letter, or the
 * empty string when the headword starts outside the alphabet.
 *
 * Every producer of that column goes through here — the service fold, the page shaper and the
 * preview seed — because three hand-rolled folds is how the column came to disagree with itself
 * (#9331). The empty string is the only honest encoding of "no letter" in a `NOT NULL` column:
 * `/sozluk/harf/<x>` answers a non-alphabet route value with no page at all
 * ({@link turkishLetterOf} is `null`, and `turkishLetterKeyRange` refuses it), so storing the raw
 * character would name a page that does not exist.
 */
export function storedFirstLetter(headword: string): string {
	return turkishLetterOf(headword) ?? "";
}

/** A letter's index in the alphabet, or `-1`. The collation key's origin. */
export function turkishLetterIndex(letter: string): number {
	return LETTERS.indexOf(letter);
}
