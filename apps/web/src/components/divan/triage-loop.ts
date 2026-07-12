/**
 * The triage-loop hero's render + interaction decisions (#1703, ADR 0138), factored
 * DOM-free in the `divanGating.ts` / `raporlarGating.ts` idiom so the focus-state
 * model, the verdict-key handling, the confirm gate, and the Esc de-escalation ladder
 * are unit-testable without a React runtime (`apps/web/src` has no jsdom).
 *
 * The loop is a MODE over the SAME gated `report.listOpen` read the grid (`Raporlar`,
 * #1701) consumes — never a re-fetch. It presents one reported target at a time with
 * the moderator's hands on the keyboard: `j/k` navigate, `Y` yoksay (dismiss, no
 * confirm — reversible), `R` kaldır (remove, key + confirm — it hides content), `U`
 * undo the last verdict, `O` reveal a masked excerpt, `Tab` switches chambers, `Esc`
 * walks the de-escalation ladder. The reputation-in-row (author standing + the
 * pile-on's reporter diversity) is the #1852 seam, surfaced here now.
 */
import type {TargetKind} from "../../../worker/db/target-kind";

/** The two verdicts, asymmetric by weight (ADR 0138): dismiss is one key, remove is key + confirm. */
export type Verdict = "dismiss" | "remove";

/** The two review chambers `Tab` switches between (ADR 0138): the report queue and the vouch/kefil roster. */
export type Chamber = "raporlar" | "kefil";

/**
 * The loop's focus is the single reviewable target's identity + queue position — a
 * real state (the seam #1852's drawer and #1855's wave dock into), not a derived
 * scroll offset. `null` when the queue is empty (the earned drained state).
 */
export interface Focus {
	readonly index: number;
	readonly targetKind: TargetKind;
	readonly targetId: string;
}

/**
 * Resolve the focus for a queue position, clamped into `[0, length)`. An empty queue
 * has no focus (the drained state); an out-of-range index (past a resolved tail)
 * clamps to the last item so a verdict on the final row lands on a real target.
 */
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

/** Next/prev queue position, clamped to the queue bounds (no wrap — the ends are real edges). */
export function moveFocus(index: number, delta: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index + delta, length - 1));
}

/**
 * After a verdict collapses the focused row, the queue shrinks by one. Keep the focus
 * on the SAME position so the next target slides under the cursor — except at the tail,
 * where the position clamps back to the new last row. `nextLength` is the post-collapse
 * length; a drained queue returns 0 (the caller renders the earned empty state).
 */
export function focusAfterResolve(index: number, nextLength: number): number {
	if (nextLength <= 0) return 0;
	return Math.min(index, nextLength - 1);
}

/**
 * The keys the loop binds, mapped from a raw key press. Returns `null` for an unbound
 * key (the loop ignores it, never swallowing browser shortcuts it doesn't own). Case
 * matters: the verdict keys are the founder-confirmed uppercase `Y`/`R`, so a lone
 * lowercase `y` (mid-typing) is NOT a dismiss.
 */
export type LoopAction =
	| {readonly kind: "next"}
	| {readonly kind: "prev"}
	| {readonly kind: "dismiss"}
	| {readonly kind: "remove"}
	| {readonly kind: "undo"}
	| {readonly kind: "toggleExcerpt"}
	| {readonly kind: "switchChamber"}
	| {readonly kind: "escape"};

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

/**
 * The verdict's confirm posture (ADR 0138 — asymmetric weight): dismiss commits on the
 * first keystroke (low-stakes, reopen-reversible), remove requires a confirm because it
 * hides content. `true` ⇒ the loop opens the confirm sheet instead of committing.
 */
export function needsConfirm(verdict: Verdict): boolean {
	return verdict === "remove";
}

/** The chamber `Tab` toggles to (raporlar ⇄ kefil) — a two-state switch, ADR 0138. */
export function nextChamber(current: Chamber): Chamber {
	return current === "raporlar" ? "kefil" : "raporlar";
}

/**
 * The Esc de-escalation ladder (ADR 0138): a modal sheet closes first, then a
 * selection clears, then the loop yields to the grid. Esc never jumps straight to the
 * grid while a sheet is open — one rung per press, so a moderator's muscle-memory Esc
 * dismisses exactly the innermost layer.
 */
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

/**
 * The reporter-diversity copy (ADR 0138): `N rapor · M farklı kişi`, the pile-on's
 * shape a moderator reads to tell a real wave (`9 rapor · 7 farklı kişi`) from a
 * grudge-reporter (`9 rapor · 1 kişi`). A single report drops the diversity clause
 * (`1 rapor` — there's no "1 farklı kişi" to contrast). `distinct` is clamped to
 * `[1, count]` so a malformed count never reads more distinct reporters than reports.
 */
export function reporterDiversityLabel(reportCount: number, distinctReporters: number): string {
	const count = Math.max(0, Math.floor(reportCount));
	if (count <= 1) return `${count} rapor`;
	const distinct = Math.max(1, Math.min(Math.floor(distinctReporters), count));
	return `${count} rapor · ${distinct} farklı kişi`;
}

/**
 * The author-standing copy for the row (ADR 0138): the tier, karma, and prior-removals
 * a moderator weighs — `çaylak · 3 karma · 2 kaldırma` for a repeat offender, `yazar ·
 * 240 karma` for a clean author (the removal clause drops at zero). `null` when the
 * author is unresolved (an anonymized / hidden target), so the row renders no
 * fabricated reputation.
 */
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

/**
 * The masked-excerpt gate (ADR 0138 — a mod isn't force-fed a slur to dismiss it): a
 * reported excerpt is collapsed by default and only shown when the moderator presses
 * `O` for THIS row. Returns the copy to render: the excerpt when revealed, else the
 * masked placeholder. A missing excerpt reads the neutral fallback regardless of the
 * reveal state.
 */
export function maskedExcerpt(excerpt: string | null, revealed: boolean): string {
	const trimmed = excerpt?.trim();
	if (!trimmed) return "içerik yüklenemedi";
	return revealed ? trimmed : "içerik gizli · O ile göster";
}

/**
 * The keyboard legend the HUD renders (ADR 0138): one entry per bound gesture — the
 * keycap(s) plus its lowercase-Turkish action. The founder-flagged dense strip is
 * replaced by this structured legend so a moderator can scan the loop's grammar; the
 * keycaps render as `<kbd>` chips (the manifest's key-legend rule). Copy lives here,
 * DOM-free, beside the `keyToAction` map it mirrors.
 */
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

/**
 * The earned drained-queue line (ADR 0138): `raporlar temiz` plus today's decision
 * count, so a cleared queue feels earned rather than a sad empty illustration. Zero
 * decisions today still reads clean (a queue that was already empty), just without the
 * count clause.
 */
export function drainedLabel(decisionsToday: number): string {
	const n = Math.max(0, Math.floor(decisionsToday));
	if (n === 0) return "raporlar temiz";
	return `raporlar temiz · bugün ${n} karar`;
}
