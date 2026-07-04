/**
 * remove-the-wave (#1855, ADR 0138) — same-author grouping + batch resolution living
 * IN the triage loop. The pure, DOM-free decisions — the wave manifest (an actor's
 * open-reported targets), the safe-by-default selection (auto-deselect zero-report
 * targets), the blast-radius confirm copy, the ⌥R/⌥Y batch keys, and the
 * partial-failure partition — factored out per the `triage-loop.ts` / `actor-drawer.ts`
 * idiom so they're unit-testable without a React runtime (`apps/web/src` has no jsdom).
 *
 * The wave rides the SAME `Moderate`-gated `report.listOpen` read the loop already
 * consumes (a MODE, never a re-fetch): every one of an actor's open-reported targets is
 * already a row in the queue, so grouping is a client-side filter on `authorId`. The
 * batch verdict fans the existing single-target `report.resolve` over the selection —
 * the per-target ledger event #1704 groups into the restore-as-a-unit is out of scope
 * here (this slice stays out of #1704's listResolved read + decision feed).
 */
import type {TargetKind} from "../../../worker/db/target-kind";
import type {Verdict} from "./triage-loop";

/** One reported target in the wave manifest — the actor's open-reported content. */
export interface WaveTarget {
	readonly targetKind: TargetKind;
	readonly targetId: string;
	/** A resolved title/excerpt identifying the target (the client resolves the copy). */
	readonly title: string;
	/** Open reports standing on this target — the auto-deselect gate and blast-radius addend. */
	readonly reportCount: number;
}

/** A live queue row projected to the fields the wave grouping reads. */
export interface WaveRow extends WaveTarget {
	/** The reported target author's account id — the grouping key (`null` when unresolved). */
	readonly authorId: string | null;
}

/** The stable per-target key (`<kind>:<id>`) — the same identity `report.resolve` acts on. */
export function waveTargetKey(t: {targetKind: TargetKind; targetId: string}): string {
	return `${t.targetKind}:${t.targetId}`;
}

/**
 * The wave manifest: the given actor's open-reported targets, in queue order. An
 * unresolved actor (`authorId === null`) groups nothing — there's no join key, so the
 * manifest is empty rather than lumping every anonymized row together.
 */
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

/**
 * The safe-by-default initial selection (ADR 0138): every target that carries at least
 * one open report is pre-selected; a zero-report target is auto-deselected. The mod
 * removes *reported* content, never censors an actor's whole footprint — a clean target
 * riding along in the manifest is opt-in only (via `T` or `Space`).
 */
export function initialWaveSelection(targets: ReadonlyArray<WaveTarget>): ReadonlyArray<string> {
	return targets.filter((t) => t.reportCount > 0).map(waveTargetKey);
}

/** Every target in the manifest, selected — the explicit `T` (tümü) override. */
export function selectAllWave(targets: ReadonlyArray<WaveTarget>): ReadonlyArray<string> {
	return targets.map(waveTargetKey);
}

/** Toggle one row's membership (`Space`) — add when absent, remove when present. */
export function toggleWaveRow(selected: ReadonlyArray<string>, key: string): ReadonlyArray<string> {
	return selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
}

/** Whether a row is currently selected. */
export function isWaveSelected(selected: ReadonlyArray<string>, key: string): boolean {
	return selected.includes(key);
}

/** The selected targets, in manifest order — the fan-out domain for the batch verdict. */
export function selectedWaveTargets(
	targets: ReadonlyArray<WaveTarget>,
	selected: ReadonlyArray<string>,
): ReadonlyArray<WaveTarget> {
	return targets.filter((t) => selected.includes(waveTargetKey(t)));
}

/** One target's `report.resolve` input in a wave gesture — carries the shared `waveId`. */
export interface WaveResolveInput {
	readonly targetKind: TargetKind;
	readonly targetId: string;
	readonly waveId: string;
}

/**
 * The per-target `report.resolve` inputs for ONE wave gesture (#1855, ADR 0138): every
 * selected target carries the SAME `waveId`, so the server stamps one shared grouping
 * across the batch and #1704's restore reopens it as a unit. The id is generated once per
 * gesture (a wave IS one grouping) and threaded here; a single-target loop resolve passes
 * no waveId, so its row's grouping stays null.
 */
export function waveResolveInputs(
	targets: ReadonlyArray<WaveTarget>,
	waveId: string,
): ReadonlyArray<WaveResolveInput> {
	return targets.map((t) => ({targetKind: t.targetKind, targetId: t.targetId, waveId}));
}

/** A non-empty selection is required before a batch verdict can apply. */
export function canApplyWave(selected: ReadonlyArray<string>): boolean {
	return selected.length > 0;
}

/** The manifest heading (ADR 0138): `bu aktör · N bildirili hedef` — the wave's breadth. */
export function waveManifestLabel(targetCount: number): string {
	const n = Math.max(0, Math.floor(targetCount));
	return `bu aktör · ${n} bildirili hedef`;
}

/**
 * The blast-radius confirm copy (ADR 0138): `N hedef · M raporu kapatır · geri
 * alınabilir` — the magnitude in plain Turkish, not a noise "emin misiniz?". `N` is the
 * selected target count, `M` the total open reports the batch collapses; one confirm for
 * the whole batch, never N. Reads off the CURRENT selection so a toggle before confirm
 * restates the real magnitude.
 */
export function blastRadiusLabel(
	targets: ReadonlyArray<WaveTarget>,
	selected: ReadonlyArray<string>,
): string {
	const chosen = selectedWaveTargets(targets, selected);
	const reports = chosen.reduce((sum, t) => sum + Math.max(0, Math.floor(t.reportCount)), 0);
	return `${chosen.length} hedef · ${reports} raporu kapatır · geri alınabilir`;
}

/** A key-press the wave manifest interprets while it is open. */
export interface WaveKeyEvent {
	readonly key: string;
	/** The physical key code — the modifier-stable match for the ⌥ combos (see below). */
	readonly code: string;
	readonly altKey: boolean;
}

/** The actions the wave manifest binds — grab (from the loop) plus the manifest's own. */
export type WaveAction =
	| {readonly kind: "grab"}
	| {readonly kind: "selectAll"}
	| {readonly kind: "toggleRow"}
	| {readonly kind: "batchRemove"}
	| {readonly kind: "batchDismiss"};

/**
 * Map a key-press to a wave action, or `null` for a key the wave doesn't own. `Shift-X`
 * grabs the focused target's author into the manifest; `T` selects all, `Space` toggles
 * the focused row, `⌥R` batch-removes, `⌥Y` batch-dismisses.
 *
 * The ⌥ combos match on the physical `code` (`KeyR`/`KeyY`), not `key`: on macOS an
 * Option-modified key produces a substituted glyph (`⌥R` → `key === "®"`), so `key`
 * can't recognize the combo. `code` is layout- and modifier-stable, so it is the only
 * reliable match for the founder's ⌥R/⌥Y bindings.
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

/** The verdict a batch action commits — remove hides content, dismiss reopens-reversibly. */
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

/**
 * The blast-radius confirm's keys (ADR 0138 — a wave-remove is confirmed, a dismiss is
 * not): `Enter` applies the batch, `Esc` cancels it. `null` for any other key so the
 * confirm never commits on a stray press.
 */
export function waveConfirmKey(key: string): "apply" | "cancel" | null {
	if (key === "Enter") return "apply";
	if (key === "Escape") return "cancel";
	return null;
}

/** One target's batch-resolve outcome — its key and whether the `report.resolve` succeeded. */
export interface WaveOutcome {
	readonly key: string;
	readonly ok: boolean;
}

/**
 * Partition a batch's per-target outcomes into resolved vs failed (ADR 0138 — no silent
 * partial drop). The failed keys stay actionable: the caller keeps them in the queue and
 * re-selected, so a partial failure surfaces exactly which targets did not resolve rather
 * than swallowing them.
 */
export function summarizeWaveBatch(outcomes: ReadonlyArray<WaveOutcome>): {
	readonly resolved: ReadonlyArray<string>;
	readonly failed: ReadonlyArray<string>;
} {
	const resolved: string[] = [];
	const failed: string[] = [];
	for (const o of outcomes) (o.ok ? resolved : failed).push(o.key);
	return {resolved, failed};
}

/**
 * The partial-failure copy: `N hedef çözülemedi, tekrar dene` when some targets did not
 * resolve, else `null` (a fully-applied batch surfaces no error). Names the count so the
 * mod knows the wave was not fully cleared.
 */
export function waveFailureLabel(failedCount: number): string | null {
	const n = Math.max(0, Math.floor(failedCount));
	if (n === 0) return null;
	return `${n} hedef çözülemedi, tekrar dene`;
}
