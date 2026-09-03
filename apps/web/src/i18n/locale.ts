/**
 * The locale axis: `tr` is the default, `en` the opt-in (ADR 0347). Import-free on purpose —
 * the storage helper, the catalog and the plural helper each name `Locale` without pulling a
 * catalog in behind it.
 */

export type Locale = "tr" | "en";

export const LOCALES: readonly Locale[] = ["tr", "en"];

export const DEFAULT_LOCALE: Locale = "tr";

export function isLocale(value: unknown): value is Locale {
	return value === "tr" || value === "en";
}

/** The endonym each locale is offered under — a language names itself, in either interface. */
export const LOCALE_LABELS: Readonly<Record<Locale, string>> = {
	tr: "Türkçe",
	en: "English",
};
