/**
 * The decision-feed's render decisions (#1704, the two-person team-ledger), factored
 * DOM-free in the `raporlarGating.ts` idiom so each gate is unit-testable without a
 * React runtime. The feed is a moderator-only view inside `/divan`, dark behind the
 * same `phoenix-mod-queue` flag as the queue (`report.listResolved` is `Moderate`-gated
 * server-side, so a forced non-mod read denies the invisible `UNAUTHORIZED`).
 *
 * The feed makes moderation legible BETWEEN two humans: who decided what, when — so the
 * decision and the resolver are first-class copy, never a footnote. A `removed` decision
 * carries the `Geri getir` (restore) disagreement affordance; a `dismissed` one is
 * terminal (nothing to bring back).
 */
import type {Resolution} from "../../../worker/features/report/resolution";

/**
 * The decision cell's lowercase-Turkish copy: `removed` → "kaldırıldı" (content taken
 * down), `dismissed` → "yoksayıldı" (report found unfounded). A closed set, so the
 * switch is exhaustive.
 */
export function decisionLabel(resolution: Resolution): string {
	switch (resolution) {
		case "removed":
			return "kaldırıldı";
		case "dismissed":
			return "yoksayıldı";
	}
}

/**
 * The resolver byline — first-class, so the two-person ledger reads "who decided". The
 * server-resolved handle as `@handle` when present; a generic "moderatör" when the
 * identity couldn't be resolved (never the raw account id — a UUID isn't legible copy).
 */
export function resolverLabel(handle: string | null): string {
	const trimmed = handle?.trim();
	return trimmed ? `@${trimmed}` : "moderatör";
}

/**
 * Only a `removed` decision is restorable — restore brings content back live and
 * reopens its reports (`report.restore`). A `dismissed` decision took no action, so
 * there is nothing to bring back and the affordance is absent.
 */
export function isRestorable(resolution: Resolution): boolean {
	return resolution === "removed";
}

/**
 * One decision-feed entry: either a single decided target, or a wave-removal (rows sharing
 * a `waveId`, #1855) collapsed into ONE entry. The feed renders a wave as one row whose
 * restore reopens the whole batch (`report.restoreWave`); a lone removal keeps its single
 * "geri getir".
 */
export type DecisionFeedEntry =
	| {readonly kind: "single"; readonly id: string}
	| {readonly kind: "wave"; readonly waveId: string; readonly memberIds: ReadonlyArray<string>};

/**
 * Group the newest-first decision rows into feed entries: a row with a null `waveId` is its
 * own single entry; rows sharing a non-null `waveId` collapse into one wave entry, anchored
 * at the wave's first (newest) occurrence with its members in feed order. Every other row's
 * position is preserved — a wave simply takes the slot of its earliest-seen member.
 */
export function groupDecisionFeed(
	rows: ReadonlyArray<{readonly id: string; readonly waveId: string | null}>,
): ReadonlyArray<DecisionFeedEntry> {
	const entries: Array<
		{kind: "single"; id: string} | {kind: "wave"; waveId: string; memberIds: string[]}
	> = [];
	const waveAt = new Map<string, {kind: "wave"; waveId: string; memberIds: string[]}>();
	for (const row of rows) {
		if (row.waveId === null) {
			entries.push({kind: "single", id: row.id});
			continue;
		}
		const existing = waveAt.get(row.waveId);
		if (existing === undefined) {
			const entry = {kind: "wave" as const, waveId: row.waveId, memberIds: [row.id]};
			waveAt.set(row.waveId, entry);
			entries.push(entry);
		} else {
			existing.memberIds.push(row.id);
		}
	}
	return entries;
}

/** A wave entry's byline: "N hedef · dalga" — one feed row standing in for the batch. */
export function waveEntryLabel(memberCount: number): string {
	return `${memberCount} hedef · dalga`;
}
