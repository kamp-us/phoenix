/**
 * remove-the-wave (#1855, ADR 0138) — same-author grouping + batch resolution in the
 * triage loop, factored DOM-free because `apps/web/src` has no jsdom. The wave rides the
 * SAME `Moderate`-gated `report.listOpen` read the loop already consumes, so grouping is a
 * client-side filter on `authorId` rather than a re-fetch.
 */
import type {TargetKind} from "../../../worker/db/target-kind";
import type {Verdict} from "./triage-loop";

export interface WaveTarget {
	readonly targetKind: TargetKind;
	readonly targetId: string;
	readonly title: string;
	readonly reportCount: number;
}

export interface WaveRow extends WaveTarget {
	readonly authorId: string | null;
}

export function waveTargetKey(t: {targetKind: TargetKind; targetId: string}): string {
	return `${t.targetKind}:${t.targetId}`;
}

// An unresolved actor (`authorId === null`) groups nothing — with no join key, lumping
// every anonymized row together would be worse than an empty manifest.
export function buildWaveManifest(
	rows: ReadonlyArray<WaveRow>,
	authorId: string | null,
): ReadonlyArray<WaveTarget> {
	if (authorId === null) return [];
	return rows
		.filter((r) => r.authorId === authorId)
		.map(({targetKind, targetId, title, reportCount}) => ({
			targetKind,
			targetId,
			title,
			reportCount,
		}));
}

// See ADR 0138 — safe by default: a clean target riding along in the manifest is opt-in only.
export function initialWaveSelection(targets: ReadonlyArray<WaveTarget>): ReadonlyArray<string> {
	return targets.filter((t) => t.reportCount > 0).map(waveTargetKey);
}

export function selectAllWave(targets: ReadonlyArray<WaveTarget>): ReadonlyArray<string> {
	return targets.map(waveTargetKey);
}

export function toggleWaveRow(selected: ReadonlyArray<string>, key: string): ReadonlyArray<string> {
	return selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
}

export function isWaveSelected(selected: ReadonlyArray<string>, key: string): boolean {
	return selected.includes(key);
}

export function selectedWaveTargets(
	targets: ReadonlyArray<WaveTarget>,
	selected: ReadonlyArray<string>,
): ReadonlyArray<WaveTarget> {
	return targets.filter((t) => selected.includes(waveTargetKey(t)));
}

export interface WaveResolveInput {
	readonly targetKind: TargetKind;
	readonly targetId: string;
	readonly waveId: string;
}

// One `waveId` per gesture, shared across the batch so #1704's restore reopens it as a
// unit; a single-target loop resolve passes none, leaving its grouping null.
export function waveResolveInputs(
	targets: ReadonlyArray<WaveTarget>,
	waveId: string,
): ReadonlyArray<WaveResolveInput> {
	return targets.map((t) => ({targetKind: t.targetKind, targetId: t.targetId, waveId}));
}

export function canApplyWave(selected: ReadonlyArray<string>): boolean {
	return selected.length > 0;
}

export function waveManifestLabel(targetCount: number): string {
	const n = Math.max(0, Math.floor(targetCount));
	return `bu aktör · ${n} bildirili hedef`;
}

export function blastRadiusLabel(
	targets: ReadonlyArray<WaveTarget>,
	selected: ReadonlyArray<string>,
): string {
	const chosen = selectedWaveTargets(targets, selected);
	const reports = chosen.reduce((sum, t) => sum + Math.max(0, Math.floor(t.reportCount)), 0);
	return `${chosen.length} hedef · ${reports} raporu kapatır · geri alınabilir`;
}

export interface WaveKeyEvent {
	readonly key: string;
	readonly code: string;
	readonly altKey: boolean;
}

export type WaveAction =
	| {readonly kind: "grab"}
	| {readonly kind: "selectAll"}
	| {readonly kind: "toggleRow"}
	| {readonly kind: "batchRemove"}
	| {readonly kind: "batchDismiss"};

/**
 * The ⌥ combos match on the physical `code` (`KeyR`/`KeyY`), not `key`: on macOS an
 * Option-modified key produces a substituted glyph (`⌥R` → `key === "®"`), so `key` cannot
 * recognize the combo.
 */
export function waveKeyToAction(ev: WaveKeyEvent): WaveAction | null {
	if (ev.altKey) {
		if (ev.code === "KeyR") return {kind: "batchRemove"};
		if (ev.code === "KeyY") return {kind: "batchDismiss"};
		return null;
	}
	switch (ev.key) {
		case "X":
			return {kind: "grab"};
		case "T":
			return {kind: "selectAll"};
		case " ":
			return {kind: "toggleRow"};
		default:
			return null;
	}
}

export function batchVerdict(action: WaveAction): Verdict | null {
	switch (action.kind) {
		case "batchRemove":
			return "remove";
		case "batchDismiss":
			return "dismiss";
		default:
			return null;
	}
}

export function waveConfirmKey(key: string): "apply" | "cancel" | null {
	if (key === "Enter") return "apply";
	if (key === "Escape") return "cancel";
	return null;
}

export interface WaveOutcome {
	readonly key: string;
	readonly ok: boolean;
}

// The failed keys stay actionable — the caller keeps them queued and re-selected, so a
// partial failure is never a silent drop.
export function summarizeWaveBatch(outcomes: ReadonlyArray<WaveOutcome>): {
	readonly resolved: ReadonlyArray<string>;
	readonly failed: ReadonlyArray<string>;
} {
	const resolved: string[] = [];
	const failed: string[] = [];
	for (const o of outcomes) (o.ok ? resolved : failed).push(o.key);
	return {resolved, failed};
}

export function waveFailureLabel(failedCount: number): string | null {
	const n = Math.max(0, Math.floor(failedCount));
	if (n === 0) return null;
	return `${n} hedef çözülemedi, tekrar dene`;
}
