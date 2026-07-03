/**
 * The raporlar (moderation-queue) surface's render decisions (#1701), factored
 * DOM-free in the `divanGating.ts` idiom so each gate is unit-testable without a
 * React runtime. The queue is a moderator-only view inside `/divan`, shipped dark
 * behind the `phoenix-mod-queue` flag.
 *
 * Visibility keys on the trusted server-side `isModerator` signal (`useMe`,
 * #1320) — never on `tier`, so a dual-role yazar+moderator still sees the entry.
 * The client gate is a courtesy only: the `report.listOpen` read stays
 * `Moderate`-gated server-side, so a forced read by a non-moderator denies the
 * invisible `UNAUTHORIZED` (rendered as the divan's "yetkin yok" state).
 */

/**
 * Show the raporlar entry iff the mod-queue flag is on AND the viewer carries the
 * trusted `isModerator` signal. Flag failure modes (loading/error/undeclared)
 * resolve to `false` upstream; a not-yet-loaded `me` reads as not-moderator —
 * both hide the entry, leaking nothing about the queue's existence.
 */
export function shouldShowRaporlar(flagOn: boolean, isModerator: boolean): boolean {
	return flagOn && isModerator;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The lowercase-Turkish first-reported age for a queue row ("az önce" /
 * "N dakika önce" / "N saat önce" / "N gün önce"), or `null` for a malformed
 * timestamp — the row then renders no age rather than lying "az önce". A clock
 * skew that puts the report in the future clamps to "az önce".
 */
export function reportAgeLabel(firstReportedAt: string, nowMs: number): string | null {
	const reportedMs = Date.parse(firstReportedAt);
	if (Number.isNaN(reportedMs)) return null;
	const elapsed = Math.max(0, nowMs - reportedMs);
	if (elapsed < MINUTE_MS) return "az önce";
	if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} dakika önce`;
	if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} saat önce`;
	return `${Math.floor(elapsed / DAY_MS)} gün önce`;
}

/** The reason cell's copy: the reporter's reason when present, else "gerekçe yok". */
export function reasonLabel(reason: string | null): string {
	const trimmed = reason?.trim();
	return trimmed ? trimmed : "gerekçe yok";
}
