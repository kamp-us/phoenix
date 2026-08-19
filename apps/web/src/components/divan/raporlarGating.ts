/**
 * The raporlar (moderation-queue) surface's render decisions (#1701), factored DOM-free
 * because `apps/web/src` has no jsdom. The client gate is a courtesy only: `report.listOpen`
 * stays `Moderate`-gated server-side, so a forced non-mod read denies the invisible
 * `UNAUTHORIZED`.
 */
import type {TargetKind} from "../../../worker/db/target-kind";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// `null` for a malformed timestamp — the row renders no age rather than lying "az önce";
// a clock skew putting the report in the future clamps to "az önce".
export function reportAgeLabel(firstReportedAt: string, nowMs: number): string | null {
	const reportedMs = Date.parse(firstReportedAt);
	if (Number.isNaN(reportedMs)) return null;
	const elapsed = Math.max(0, nowMs - reportedMs);
	if (elapsed < MINUTE_MS) return "az önce";
	if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} dakika önce`;
	if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} saat önce`;
	return `${Math.floor(elapsed / DAY_MS)} gün önce`;
}

export function reasonLabel(reason: string | null): string {
	const trimmed = reason?.trim();
	return trimmed ? trimmed : "gerekçe yok";
}

// A comment's routing `ref` is its parent post id, so post and comment both open /pano/<ref>.
export function targetHref(kind: TargetKind, ref: string | null): string | null {
	const trimmed = ref?.trim();
	if (!trimmed) return null;
	switch (kind) {
		case "post":
		case "comment":
			return `/pano/${trimmed}`;
		case "definition":
			return `/sozluk/${trimmed}`;
	}
}

export function targetExcerptLabel(excerpt: string | null): string {
	const trimmed = excerpt?.trim();
	return trimmed ? trimmed : "içerik yüklenemedi";
}

export function targetAuthorLabel(author: string | null): string | null {
	const trimmed = author?.trim();
	return trimmed ? `@${trimmed}` : null;
}
