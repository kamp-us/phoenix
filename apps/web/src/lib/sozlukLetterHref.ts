/** An active letter links back to bare `/sozluk` so the filter toggles off by navigation,
 *  keeping the URL shareable instead of holding the filter in client-only state. */
export function sozlukLetterHref(letter: string, isActive: boolean): string {
	return isActive ? "/sozluk" : `/sozluk?harf=${encodeURIComponent(letter)}`;
}
