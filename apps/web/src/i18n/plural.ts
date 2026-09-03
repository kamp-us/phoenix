/**
 * The two-arm plural helper. `Intl.PluralRules` reports exactly `one` and `other` as the
 * cardinal categories for both `tr` and `en`, which is why an ICU parser buys nothing here —
 * see `reports/2026-09-02-i18n-options.md`. A third locale with more categories is the point
 * this helper stops being enough (ADR 0347).
 */
import type {Locale} from "./locale";

export interface PluralForms<T extends string = string> {
	readonly one: T;
	readonly other: T;
}

// Generic in the form type so a caller passing two `CatalogKey`s gets a `CatalogKey` back and
// can feed it straight to `t` — the arms are picked, never concatenated.
export function plural<T extends string>(locale: Locale, count: number, forms: PluralForms<T>): T {
	return new Intl.PluralRules(locale).select(count) === "one" ? forms.one : forms.other;
}
