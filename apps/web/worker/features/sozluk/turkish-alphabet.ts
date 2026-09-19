/**
 * The sözlük's letter index, declared ONCE for both sides of it (#9267).
 *
 * The strip in the SPA and the range function in the worker have to agree letter for letter, or
 * the strip links to a letter `sozlukLetterKeyRange` answers `null` for and the reader lands on
 * a redirect. Two copies of a 32-row table cannot be kept in step by review, so there is one —
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

/**
 * The letters the sözlük indexes beyond the Turkish 29, in the place Turkish gives its foreign
 * letters: after `z` (#9425). A headword may be English — `web`, `query`, `xml` — and before
 * these rows it filed under no letter at all, so browsing could not reach it.
 *
 * They are APPENDED rather than interleaved because the index of a letter is its collation
 * position: put `q` between `p` and `r` and every key character from `r` on shifts, which
 * re-sorts every headword in the corpus for a cosmetic gain.
 */
export const FOREIGN_LETTERS = ["q", "w", "x"] as const;

/**
 * Every letter the sözlük files a headword under, in the order the strip renders and the
 * collation key numbers. The Turkish 29 keep indices 0-28, so their key characters — and with
 * them every existing headword's sort position — are unchanged by the tail.
 */
export const SOZLUK_ALPHABET = [...TURKISH_ALPHABET, ...FOREIGN_LETTERS] as const;

export type SozlukLetter = (typeof SOZLUK_ALPHABET)[number];

const LETTERS: readonly string[] = SOZLUK_ALPHABET;

/** Narrows an arbitrary string to a letter the index actually holds. */
export function isSozlukLetter(value: string): value is SozlukLetter {
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
 * The letter a headword files under, or `null` when it starts with a digit, punctuation or a
 * letter outside the index — those belong to no letter page.
 */
export function sozlukLetterOf(headword: string): SozlukLetter | null {
	const folded = foldTurkishChar(headword.charAt(0));
	return isSozlukLetter(folded) ? folded : null;
}

/**
 * The value `term_record.first_letter` stores for one headword: its index letter, or the empty
 * string when the headword starts outside the index.
 *
 * Every producer of that column goes through here — the service fold, the page shaper and the
 * preview seed — because three hand-rolled folds is how the column came to disagree with itself
 * (#9331). The empty string is the only honest encoding of "no letter" in a `NOT NULL` column:
 * `/sozluk/harf/<x>` answers an unindexed route value with no page at all
 * ({@link sozlukLetterOf} is `null`, and `sozlukLetterKeyRange` refuses it), so storing the raw
 * character would name a page that does not exist.
 */
export function storedFirstLetter(headword: string): string {
	return sozlukLetterOf(headword) ?? "";
}

/** A letter's index in the letter table, or `-1`. The collation key's origin. */
export function sozlukLetterIndex(letter: string): number {
	return LETTERS.indexOf(letter);
}
