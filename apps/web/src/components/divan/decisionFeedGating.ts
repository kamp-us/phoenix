/**
 * The decision-feed's render decisions (#1704), factored DOM-free because `apps/web/src`
 * has no jsdom. `report.listResolved` is `Moderate`-gated server-side, so a forced non-mod
 * read denies the invisible `UNAUTHORIZED`.
 */
import type {Resolution} from "../../../worker/features/report/resolution";
import type {CatalogKey} from "../../i18n";
import type {Message} from "./divanGating";

export function decisionLabel(resolution: Resolution): CatalogKey {
	switch (resolution) {
		case "removed":
			return "divan.decision.removed";
		case "dismissed":
			return "divan.decision.dismissed";
	}
}

// Never the raw account id — a UUID is not legible copy. `null` falls back to the catalog's
// generic moderator noun.
export function resolverHandle(handle: string | null): string | null {
	const trimmed = handle?.trim();
	return trimmed ? `@${trimmed}` : null;
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

// The `one` arm is exactly `count === 1` in both catalogs (see `i18n/plural.ts`).
export function waveEntryLabel(memberCount: number): Message {
	return {
		key: memberCount === 1 ? "divan.decision.wave.one" : "divan.decision.wave.other",
		params: {count: memberCount},
	};
}
