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

/**
 * Full timestamp formatter used by the edited-indicator tooltip (T17).
 * Shows the user the exact moment the content was last edited so they can
 * compare against the relative "düzenlendi" label.
 */
const dateTimeFmt = new Intl.DateTimeFormat('tr-TR', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
});

/**
 * Edit window in ms — anything inside this window of the createdAt is treated
 * as part of the initial submission rather than an edit. Defends against tiny
 * server-side updatedAt drift (sub-second after insert) flagging fresh content
 * as edited.
 */
export const EDITED_GRACE_MS = 60 * 1000;

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

/**
 * Full edit-timestamp formatter for the edited-indicator tooltip (T17).
 * Renders the iso into Turkish locale day + month + year + hour:minute so the
 * tooltip carries the precise moment of last edit.
 */
export function formatEditedTooltipTR(iso: string | null | undefined): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	return dateTimeFmt.format(d);
}

/**
 * Returns `true` when `updatedAt` is more than `EDITED_GRACE_MS` after
 * `createdAt`. Powers the "düzenlendi" indicator on definitions / posts /
 * comments (T17). Both inputs are ISO 8601 strings (matches the GraphQL
 * surface). Returns `false` defensively on missing / invalid inputs so the
 * indicator stays hidden when timestamps are unavailable.
 */
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
