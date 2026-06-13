// Turkish date / relative-time helpers. Formatters are cached at module scope
// to avoid reconstructing an `Intl` formatter per call site.

const dateFmt = new Intl.DateTimeFormat("tr-TR", {
	day: "numeric",
	month: "short",
	year: "numeric",
});

const dateTimeFmt = new Intl.DateTimeFormat("tr-TR", {
	day: "numeric",
	month: "short",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

// Edits within this window of createdAt count as the initial submission, not an
// edit — defends against sub-second server-side updatedAt drift after insert.
export const EDITED_GRACE_MS = 60 * 1000;

/* numeric: 'auto' lets the formatter say "şimdi" / "dün" instead of
   "0 saniye önce" / "1 gün önce" where the locale supports it. */
const relFmt = new Intl.RelativeTimeFormat("tr-TR", {numeric: "auto"});

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	["year", 365 * 24 * 3600 * 1000],
	["month", 30 * 24 * 3600 * 1000],
	["day", 24 * 3600 * 1000],
	["hour", 3600 * 1000],
	["minute", 60 * 1000],
	["second", 1000],
];

export function formatDateTR(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return dateFmt.format(d);
}

export function formatAgoTR(iso: string | null | undefined): string {
	if (!iso) return "";
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return "";

	/* Negative for past, positive for future — RelativeTimeFormat
	   handles both directions ("3 saat önce" vs "3 saat sonra"). */
	const diff = t - Date.now();
	for (const [unit, ms] of UNITS) {
		if (Math.abs(diff) >= ms || unit === "second") {
			return relFmt.format(Math.round(diff / ms), unit);
		}
	}
	return "";
}

export function formatEditedTooltipTR(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return dateTimeFmt.format(d);
}

/**
 * `true` when `updatedAt` is more than `EDITED_GRACE_MS` after `createdAt` —
 * backs the "düzenlendi" indicator. Defensively `false` on missing / invalid
 * inputs so the indicator stays hidden when timestamps are unavailable.
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
