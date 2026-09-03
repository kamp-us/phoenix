/**
 * The two-arm plural helper. `Intl.PluralRules` reports exactly `one` and `other` as the
 * cardinal categories for both `tr` and `en`, which is why an ICU parser buys nothing here —
 * see `reports/2026-09-02-i18n-options.md`. A third locale with more categories is the point
 * this helper stops being enough (ADR 0347).
 */
import type {Locale} from "./locale";

export interface PluralForms {
	readonly one: string;
	readonly other: string;
}

export function plural(locale: Locale, count: number, forms: PluralForms): string {
	return new Intl.PluralRules(locale).select(count) === "one" ? forms.one : forms.other;
}
