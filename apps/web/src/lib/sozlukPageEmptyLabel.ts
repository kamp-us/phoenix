/**
 * The letter filter runs over the loaded FIRST PAGE only, never the corpus, so this copy
 * must name that scope ("ilk sayfada") and must never say "<letter> harfinde terim yok" —
 * a reader filtering "k" over five loaded rows may sit atop fifty un-loaded k-terms (#1669).
 */
export function sozlukPageEmptyLabel(letter: string | undefined): string {
	if (letter) return `"${letter}" harfiyle başlayan terim ilk sayfada yok.`;
	return "ilk sayfada terim yok.";
}
