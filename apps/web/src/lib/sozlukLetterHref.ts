/**
 * The per-letter sözlük index URL: `/sozluk?harf=<letter>` (canonical query-param
 * route like `/search?q=`). A letter that is already active links back to the bare
 * `/sozluk` so the active letter still toggles its filter off — now as a real,
 * shareable navigation rather than client-only state.
 */
export function sozlukLetterHref(letter: string, isActive: boolean): string {
	return isActive ? "/sozluk" : `/sozluk?harf=${encodeURIComponent(letter)}`;
}
