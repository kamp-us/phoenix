/**
 * The triage-loop hero's render + interaction decisions (#1703, ADR 0138), factored
 * DOM-free because `apps/web/src` has no jsdom.
 */
import type {TargetKind} from "../../../worker/db/target-kind";
import type {CatalogKey} from "../../i18n";
import type {Message} from "./divanGating";

export type Verdict = "dismiss" | "remove";

export type Chamber = "raporlar" | "kefil";

export interface Focus {
	readonly index: number;
	readonly targetKind: TargetKind;
	readonly targetId: string;
}

// An out-of-range index (past a resolved tail) clamps to the last item, so a verdict on
// the final row still lands on a real target.
export function focusAt(
	items: ReadonlyArray<{targetKind: TargetKind; targetId: string}>,
	index: number,
): Focus | null {
	if (items.length === 0) return null;
	const clamped = Math.max(0, Math.min(index, items.length - 1));
	const item = items[clamped];
	if (item === undefined) return null;
	return {index: clamped, targetKind: item.targetKind, targetId: item.targetId};
}

export function moveFocus(index: number, delta: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index + delta, length - 1));
}

export function focusAfterResolve(index: number, nextLength: number): number {
	if (nextLength <= 0) return 0;
	return Math.min(index, nextLength - 1);
}

export type LoopAction =
	| {readonly kind: "next"}
	| {readonly kind: "prev"}
	| {readonly kind: "dismiss"}
	| {readonly kind: "remove"}
	| {readonly kind: "undo"}
	| {readonly kind: "toggleExcerpt"}
	| {readonly kind: "switchChamber"}
	| {readonly kind: "escape"};

// The verdict keys are the uppercase `Y`/`R`: a lone lowercase `y` mid-typing must never
// commit a verdict.
export function keyToAction(key: string): LoopAction | null {
	switch (key) {
		case "j":
		case "ArrowDown":
			return {kind: "next"};
		case "k":
		case "ArrowUp":
			return {kind: "prev"};
		case "Y":
			return {kind: "dismiss"};
		case "R":
			return {kind: "remove"};
		case "U":
			return {kind: "undo"};
		case "O":
			return {kind: "toggleExcerpt"};
		case "Tab":
			return {kind: "switchChamber"};
		case "Escape":
			return {kind: "escape"};
		default:
			return null;
	}
}

// See ADR 0138 — asymmetric weight: remove is confirmed because it hides content.
export function needsConfirm(verdict: Verdict): boolean {
	return verdict === "remove";
}

export function nextChamber(current: Chamber): Chamber {
	return current === "raporlar" ? "kefil" : "raporlar";
}

export type LoopLayer = "sheet" | "selection" | "grid";

export function escapeTo(current: LoopLayer): LoopLayer {
	switch (current) {
		case "sheet":
			return "selection";
		case "selection":
			return "grid";
		case "grid":
			return "grid";
	}
}

// `distinct` clamps into `[1, count]` so a malformed count never reads more distinct
// reporters than reports.
export function reporterDiversityLabel(reportCount: number, distinctReporters: number): Message {
	const count = Math.max(0, Math.floor(reportCount));
	if (count <= 1) {
		return {
			key: count === 1 ? "divan.report.count.one" : "divan.report.count.other",
			params: {count},
		};
	}
	const distinct = Math.max(1, Math.min(Math.floor(distinctReporters), count));
	return {key: "divan.triage.diversity", params: {count, distinct}};
}

export function authorReputationLabel(
	tier: string | null,
	karma: number | null,
	priorRemovals: number | null,
): Message | null {
	if (tier === null || karma === null) return null;
	if (priorRemovals !== null && priorRemovals > 0) {
		return {key: "divan.triage.reputationRemovals", params: {tier, karma, removals: priorRemovals}};
	}
	return {key: "divan.triage.reputation", params: {tier, karma}};
}

/** Either the excerpt's own text or a catalog stand-in for it. */
export type ExcerptLabel = {readonly text: string} | Message;

// See ADR 0138 — a moderator is not force-fed the excerpt in order to dismiss it.
export function maskedExcerpt(excerpt: string | null, revealed: boolean): ExcerptLabel {
	const trimmed = excerpt?.trim();
	if (!trimmed) return {key: "divan.excerpt.unavailable"};
	return revealed ? {text: trimmed} : {key: "divan.triage.excerptHidden"};
}

export interface LegendEntry {
	readonly keys: ReadonlyArray<string>;
	readonly labelKey: CatalogKey;
}

export const triageLegend: ReadonlyArray<LegendEntry> = [
	{keys: ["j", "k"], labelKey: "divan.triage.legend.navigate"},
	{keys: ["Y"], labelKey: "divan.triage.legend.dismiss"},
	{keys: ["R"], labelKey: "divan.triage.legend.remove"},
	{keys: ["U"], labelKey: "divan.triage.legend.undo"},
	{keys: ["O"], labelKey: "divan.triage.legend.reveal"},
	{keys: ["A"], labelKey: "divan.triage.legend.kunye"},
	{keys: ["V", "M"], labelKey: "divan.triage.legend.chamber"},
	{keys: ["X"], labelKey: "divan.triage.legend.wave"},
];

// The `one` arm is exactly `count === 1` in both catalogs (see `i18n/plural.ts`).
export function drainedLabel(decisionsToday: number): Message {
	const n = Math.max(0, Math.floor(decisionsToday));
	if (n === 0) return {key: "divan.triage.drained"};
	return {
		key: n === 1 ? "divan.triage.drainedToday.one" : "divan.triage.drainedToday.other",
		params: {count: n},
	};
}
