import type {Translate} from "../i18n";

/**
 * The letter filter runs over the loaded FIRST PAGE only, never the corpus, so both messages name
 * that scope and neither may say "<letter> harfinde terim yok" — a reader filtering "k" over five
 * loaded rows may sit atop fifty un-loaded k-terms (#1669). The copy itself is in the catalog;
 * this picks the arm.
 */
export function sozlukPageEmptyLabel(t: Translate, letter: string | undefined): string {
	if (letter) return t("sozluk.home.letterEmpty", {letter});
	return t("sozluk.home.pageEmpty");
}
