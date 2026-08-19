/**
 * The triage-loop hero's render + interaction decisions (#1703, ADR 0138), factored
 * DOM-free because `apps/web/src` has no jsdom.
 */
import type {TargetKind} from "../../../worker/db/target-kind";

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
export function reporterDiversityLabel(reportCount: number, distinctReporters: number): string {
	const count = Math.max(0, Math.floor(reportCount));
	if (count <= 1) return `${count} rapor`;
	const distinct = Math.max(1, Math.min(Math.floor(distinctReporters), count));
	return `${count} rapor · ${distinct} farklı kişi`;
}

export function authorReputationLabel(
	tier: string | null,
	karma: number | null,
	priorRemovals: number | null,
): string | null {
	if (tier === null || karma === null) return null;
	const parts = [tier, `${karma} karma`];
	if (priorRemovals !== null && priorRemovals > 0) {
		parts.push(`${priorRemovals} kaldırma`);
	}
	return parts.join(" · ");
}

// See ADR 0138 — a moderator is not force-fed the excerpt in order to dismiss it.
export function maskedExcerpt(excerpt: string | null, revealed: boolean): string {
	const trimmed = excerpt?.trim();
	if (!trimmed) return "içerik yüklenemedi";
	return revealed ? trimmed : "içerik gizli · O ile göster";
}

export interface LegendEntry {
	readonly keys: ReadonlyArray<string>;
	readonly label: string;
}

export const triageLegend: ReadonlyArray<LegendEntry> = [
	{keys: ["j", "k"], label: "gez"},
	{keys: ["Y"], label: "yoksay"},
	{keys: ["R"], label: "kaldır"},
	{keys: ["U"], label: "geri al"},
	{keys: ["O"], label: "göster"},
	{keys: ["A"], label: "künye"},
	{keys: ["V", "M"], label: "bölme"},
	{keys: ["X"], label: "dalga"},
];

export function drainedLabel(decisionsToday: number): string {
	const n = Math.max(0, Math.floor(decisionsToday));
	if (n === 0) return "raporlar temiz";
	return `raporlar temiz · bugün ${n} karar`;
}
