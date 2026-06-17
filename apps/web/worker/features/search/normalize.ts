/**
 * Turkish-aware search normalization (ADR 0080). Folds a title into the ASCII
 * token stream the FTS5 `norm` column is indexed on — applied SYMMETRICALLY at
 * write time (when syncing the FTS row) and at query time (when building the
 * MATCH string), so search is both diacritic-insensitive and dotted-`i`
 * insensitive.
 *
 * Why an app-side fold and not `unicode61` alone: `unicode61` case-folds ASCII
 * the English way (`I → i`), which is wrong for Turkish — `I` is the dotless `ı`
 * and `İ` is the dotted `i`. We lowercase Turkish-correctly first, then strip the
 * five Turkish diacritics + circumflex to ASCII, so `İstanbul`/`ISTANBUL`/
 * `istanbul` and `Şişli`/`sisli` all collapse to one token form.
 */

/** Turkish-correct lowercase: `İ → i`, `I → ı` before the locale-blind fold. */
const turkishLower = (s: string): string => s.replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase();

const DIACRITIC_FOLD: Record<string, string> = {
	ı: "i",
	ş: "s",
	ğ: "g",
	ç: "c",
	ö: "o",
	ü: "u",
	â: "a",
	î: "i",
	û: "u",
};

/**
 * Fold one piece of text to its normalized search form: Turkish-correct
 * lowercase, then the five Turkish diacritics + circumflex → ASCII, then strip
 * any residual combining marks (NFKD). Collapses internal whitespace so the token
 * stream is stable.
 */
export const normalizeSearchText = (input: string): string =>
	turkishLower(input)
		.replace(/[ışğçöüâîû]/g, (c) => DIACRITIC_FOLD[c] ?? c)
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** Minimum query length below which search returns an empty connection (ADR 0080). */
export const MIN_QUERY_LENGTH = 2;

/**
 * Build the FTS5 `MATCH` expression for a user query, or `null` when the
 * normalized query is below the min length (the caller returns an empty page).
 *
 * Each token is wrapped in double quotes (so FTS5 operator words like `OR`/`NOT`
 * and punctuation become literal string tokens — no MATCH-grammar injection) and
 * suffixed with `*` for prefix matching (the poor-man's stemmer for Turkish
 * agglutination, ADR 0080). Embedded quotes are doubled per FTS5 string-literal
 * escaping.
 */
export const toMatchExpression = (query: string): string | null => {
	const normalized = normalizeSearchText(query);
	if (normalized.length < MIN_QUERY_LENGTH) return null;
	const tokens = normalized.split(" ").filter((t) => t.length > 0);
	if (tokens.length === 0) return null;
	return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
};
