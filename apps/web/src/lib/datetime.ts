import type {Locale} from "../i18n/locale";

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
	day: "numeric",
	month: "short",
	year: "numeric",
};

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
	...DATE_OPTIONS,
	hour: "2-digit",
	minute: "2-digit",
};

// Edits within this window of createdAt count as the initial submission, not an
// edit — defends against sub-second server-side updatedAt drift after insert.
const EDITED_GRACE_MS = 60 * 1000;

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	["year", 365 * 24 * 3600 * 1000],
	["month", 30 * 24 * 3600 * 1000],
	["day", 24 * 3600 * 1000],
	["hour", 3600 * 1000],
	["minute", 60 * 1000],
	["second", 1000],
];

/** The date surfaces one locale renders; `useDateFormatter` hands a component the live one. */
export interface DateFormatter {
	/** `12 Eyl 2026` / `Sep 12, 2026` */
	readonly date: (iso: string | null | undefined) => string;
	/** `3 gün önce` / `3 days ago` */
	readonly ago: (iso: string | null | undefined) => string;
	/** The date plus the time of day. */
	readonly editedTooltip: (iso: string | null | undefined) => string;
}

function parse(iso: string | null | undefined): Date | null {
	if (!iso) return null;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d;
}

function buildDateFormatter(locale: Locale): DateFormatter {
	const dateFmt = new Intl.DateTimeFormat(locale, DATE_OPTIONS);
	const dateTimeFmt = new Intl.DateTimeFormat(locale, DATE_TIME_OPTIONS);
	// numeric: 'auto' lets the formatter say "şimdi" / "dün" instead of "0 saniye önce".
	const relFmt = new Intl.RelativeTimeFormat(locale, {numeric: "auto"});

	return {
		date: (iso) => {
			const d = parse(iso);
			return d ? dateFmt.format(d) : "";
		},
		ago: (iso) => {
			const d = parse(iso);
			if (!d) return "";
			const diff = d.getTime() - Date.now();
			for (const [unit, ms] of UNITS) {
				if (Math.abs(diff) >= ms || unit === "second") {
					return relFmt.format(Math.round(diff / ms), unit);
				}
			}
			return "";
		},
		editedTooltip: (iso) => {
			const d = parse(iso);
			return d ? dateTimeFmt.format(d) : "";
		},
	};
}

const formatters = new Map<Locale, DateFormatter>();

/** One formatter set per locale, built on first use and reused after, so no render rebuilds `Intl`. */
export function dateFormatter(locale: Locale): DateFormatter {
	let formatter = formatters.get(locale);
	if (!formatter) {
		formatter = buildDateFormatter(locale);
		formatters.set(locale, formatter);
	}
	return formatter;
}

export function editedAfter(
	createdAt: string | null | undefined,
	updatedAt: string | null | undefined,
): boolean {
	if (!createdAt || !updatedAt) return false;
	const c = new Date(createdAt).getTime();
	const u = new Date(updatedAt).getTime();
	if (Number.isNaN(c) || Number.isNaN(u)) return false;
	return u - c > EDITED_GRACE_MS;
}
