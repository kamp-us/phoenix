/**
 * Turkish-aware search normalization (ADR 0080). Must be applied SYMMETRICALLY at
 * write time and at query time, or the two token streams stop matching.
 *
 * Why an app-side fold and not `unicode61` alone: `unicode61` case-folds ASCII the
 * English way (`I → i`), which is wrong for Turkish — `I` is the dotless `ı` and `İ`
 * is the dotted `i`.
 */

// Turkish-correct lowercase, run BEFORE the locale-blind fold.
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

export const normalizeSearchText = (input: string): string =>
	turkishLower(input)
		.replace(/[ışğçöüâîû]/g, (c) => DIACRITIC_FOLD[c] ?? c)
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/\s+/g, " ")
		.trim();

export const MIN_QUERY_LENGTH = 2;

/**
 * Build the FTS5 `MATCH` expression, or `null` below the min length.
 *
 * Every token is double-quoted so FTS5 operator words like `OR`/`NOT` and punctuation
 * become literal tokens — that quoting is what stops MATCH-grammar injection. The `*`
 * suffix is the poor-man's stemmer for Turkish agglutination (ADR 0080).
 */
export const toMatchExpression = (query: string): string | null => {
	const normalized = normalizeSearchText(query);
	if (normalized.length < MIN_QUERY_LENGTH) return null;
	const tokens = normalized.split(" ").filter((t) => t.length > 0);
	if (tokens.length === 0) return null;
	return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
};
