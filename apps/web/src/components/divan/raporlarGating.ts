/**
 * The raporlar (moderation-queue) surface's render decisions (#1701), factored DOM-free
 * because `apps/web/src` has no jsdom. The client gate is a courtesy only: `report.listOpen`
 * stays `Moderate`-gated server-side, so a forced non-mod read denies the invisible
 * `UNAUTHORIZED`.
 */
import type {TargetKind} from "../../../worker/db/target-kind";
import type {Message} from "./divanGating";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// `null` for a malformed timestamp — the row renders no age rather than lying "az önce";
// a clock skew putting the report in the future clamps to "az önce".
export function reportAgeLabel(firstReportedAt: string, nowMs: number): Message | null {
	const reportedMs = Date.parse(firstReportedAt);
	if (Number.isNaN(reportedMs)) return null;
	const elapsed = Math.max(0, nowMs - reportedMs);
	if (elapsed < MINUTE_MS) return {key: "divan.age.now"};
	if (elapsed < HOUR_MS) return elapsedIn(Math.floor(elapsed / MINUTE_MS), "minutes");
	if (elapsed < DAY_MS) return elapsedIn(Math.floor(elapsed / HOUR_MS), "hours");
	return elapsedIn(Math.floor(elapsed / DAY_MS), "days");
}

// The `one` arm is exactly `count === 1` in both catalogs (see `i18n/plural.ts`).
function elapsedIn(count: number, unit: "minutes" | "hours" | "days"): Message {
	const arms = {
		minutes: {one: "divan.age.minutes.one", other: "divan.age.minutes.other"},
		hours: {one: "divan.age.hours.one", other: "divan.age.hours.other"},
		days: {one: "divan.age.days.one", other: "divan.age.days.other"},
	} as const;
	return {key: count === 1 ? arms[unit].one : arms[unit].other, params: {count}};
}

/** `null` when the report carries no reason — the row renders the catalog fallback. */
export function reasonText(reason: string | null): string | null {
	const trimmed = reason?.trim();
	return trimmed ? trimmed : null;
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

/** `null` when the excerpt is missing — the row renders the catalog fallback. */
export function targetExcerptText(excerpt: string | null): string | null {
	const trimmed = excerpt?.trim();
	return trimmed ? trimmed : null;
}

export function targetAuthorLabel(author: string | null): string | null {
	const trimmed = author?.trim();
	return trimmed ? `@${trimmed}` : null;
}
