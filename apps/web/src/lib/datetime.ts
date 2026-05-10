/**
 * Turkish date / relative-time helpers backed by `Intl.DateTimeFormat`
 * and `Intl.RelativeTimeFormat`. Both formatters are cached at module
 * scope — Intl constructors are cheap on call but we still create one
 * per surface use otherwise.
 */

const dateFmt = new Intl.DateTimeFormat('tr-TR', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
});

/* numeric: 'auto' lets the formatter say "şimdi" / "dün" instead of
   "0 saniye önce" / "1 gün önce" where the locale supports it. */
const relFmt = new Intl.RelativeTimeFormat('tr-TR', {numeric: 'auto'});

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	['year', 365 * 24 * 3600 * 1000],
	['month', 30 * 24 * 3600 * 1000],
	['day', 24 * 3600 * 1000],
	['hour', 3600 * 1000],
	['minute', 60 * 1000],
	['second', 1000],
];

export function formatDateTR(iso: string | null | undefined): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	return dateFmt.format(d);
}

export function formatAgoTR(iso: string | null | undefined): string {
	if (!iso) return '';
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return '';

	/* Negative for past, positive for future — RelativeTimeFormat
	   handles both directions ("3 saat önce" vs "3 saat sonra"). */
	const diff = t - Date.now();
	for (const [unit, ms] of UNITS) {
		if (Math.abs(diff) >= ms || unit === 'second') {
			return relFmt.format(Math.round(diff / ms), unit);
		}
	}
	return '';
}
