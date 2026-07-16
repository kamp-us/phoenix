/**
 * The honest empty-state copy for a sözlük-home column whose client-side letter filter
 * excluded every already-loaded row. That filter runs over the loaded FIRST PAGE only
 * (`HOME_PAGE_SIZE`), never the whole corpus — so the copy must name that scope
 * ("ilk sayfada"), and must never assert "<letter> harfinde terim yok" as a fact about
 * the corpus. The old copy was the alphabet-filter lie: a user who filters "k" over five
 * loaded rows and reads "k harfinde terim yok" may sit atop fifty un-loaded k-terms
 * (#1669; DESIGN-AUDIT "the alphabet/search filter lies" finding).
 */
export function sozlukPageEmptyLabel(letter: string | undefined): string {
	if (letter) return `"${letter}" harfiyle başlayan terim ilk sayfada yok.`;
	return "ilk sayfada terim yok.";
}
