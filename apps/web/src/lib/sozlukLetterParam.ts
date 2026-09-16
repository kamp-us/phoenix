import {isTurkishLetter, type TurkishLetter} from "../../worker/features/sozluk/turkish-alphabet";

/**
 * The `/sozluk/harf/:letter` route value, narrowed to a letter the strip actually indexes.
 * Turkish-locale lowercasing is the load-bearing step: `/sozluk/harf/I` is the dotless `ı`'s
 * page and `/sozluk/harf/İ` is `i`'s, which ASCII lowercasing gets backwards. Anything else —
 * a digit, `q`, an empty segment — resolves to `null`, and the route sends that reader home
 * rather than rendering a letter page for a letter there is no page of.
 *
 * The set it checks against is the worker's own alphabet table, so the strip can never link to a
 * letter the server's range function refuses (#9267).
 */
export function sozlukLetterParam(raw: string | undefined): TurkishLetter | null {
	if (!raw) return null;
	const letter = raw.toLocaleLowerCase("tr");
	return isTurkishLetter(letter) ? letter : null;
}
