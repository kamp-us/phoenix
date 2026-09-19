/** A letter is a page of its own (#9267), not a filter on the home: `/sozluk/harf/<letter>`
 *  lists every term under that letter, server-paginated. The active letter links back to bare
 *  `/sozluk` so the strip toggles off by navigation, keeping every URL shareable. */
export function sozlukLetterHref(letter: string, isActive: boolean): string {
	return isActive ? "/sozluk" : `/sozluk/harf/${encodeURIComponent(letter)}`;
}
