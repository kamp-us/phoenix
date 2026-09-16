import {ALPHABET} from "../components/sozluk/Sozluk";

/**
 * The `/sozluk/harf/:letter` route value, narrowed to a letter the strip actually indexes.
 * Turkish-locale lowercasing is the load-bearing step: `/sozluk/harf/I` is the dotless `ı`'s
 * page and `/sozluk/harf/İ` is `i`'s, which ASCII lowercasing gets backwards. Anything else —
 * a digit, `q`, an empty segment — resolves to `null`, and the route sends that reader home
 * rather than rendering a letter page for a letter there is no page of.
 */
export function sozlukLetterParam(raw: string | undefined): string | null {
	if (!raw) return null;
	const letter = raw.toLocaleLowerCase("tr");
	return ALPHABET.includes(letter) ? letter : null;
}
