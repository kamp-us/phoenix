/**
 * The decision-feed's render decisions (#1704), factored DOM-free because `apps/web/src`
 * has no jsdom. `report.listResolved` is `Moderate`-gated server-side, so a forced non-mod
 * read denies the invisible `UNAUTHORIZED`.
 */
import type {Resolution} from "../../../worker/features/report/resolution";

export function decisionLabel(resolution: Resolution): string {
	switch (resolution) {
		case "removed":
			return "kaldırıldı";
		case "dismissed":
			return "yoksayıldı";
	}
}

// Never the raw account id — a UUID is not legible copy.
export function resolverLabel(handle: string | null): string {
	const trimmed = handle?.trim();
	return trimmed ? `@${trimmed}` : "moderatör";
}

// Only a removal took an action; a dismissal has nothing to bring back.
export function isRestorable(resolution: Resolution): boolean {
	return resolution === "removed";
}

export type DecisionFeedEntry =
	| {readonly kind: "single"; readonly id: string}
	| {readonly kind: "wave"; readonly waveId: string; readonly memberIds: ReadonlyArray<string>};

// A wave takes the slot of its earliest-seen member; every other row keeps its position.
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

export function waveEntryLabel(memberCount: number): string {
	return `${memberCount} hedef · dalga`;
}
