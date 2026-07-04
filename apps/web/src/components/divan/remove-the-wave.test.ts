/**
 * remove-the-wave's interaction + copy contract (#1855, ADR 0138) — the pure
 * grouping / safe-selection / blast-radius / batch-key / partial-failure decisions
 * asserted without a DOM, per the `triage-loop.test.ts` precedent. The AC the wave
 * lives or dies on: `Shift-X` grabs an author's reported targets; the manifest
 * auto-deselects zero-report targets while `T`/`Space` select; `⌥R` opens a
 * blast-radius confirm naming target-count + reports-collapsed + reversibility;
 * `Enter`/`Esc` apply/cancel; a partial failure surfaces which targets did not resolve.
 */
import {describe, expect, it} from "vitest";
import {
	batchVerdict,
	blastRadiusLabel,
	buildWaveManifest,
	canApplyWave,
	initialWaveSelection,
	isWaveSelected,
	selectAllWave,
	selectedWaveTargets,
	summarizeWaveBatch,
	toggleWaveRow,
	type WaveRow,
	type WaveTarget,
	waveConfirmKey,
	waveFailureLabel,
	waveKeyToAction,
	waveManifestLabel,
	waveResolveInputs,
	waveTargetKey,
} from "./remove-the-wave";

const row = (over: Partial<WaveRow> = {}): WaveRow => ({
	targetKind: "post",
	targetId: "a",
	title: "içerik",
	reportCount: 3,
	authorId: "actor-1",
	...over,
});

const target = (over: Partial<WaveTarget> = {}): WaveTarget => ({
	targetKind: "post",
	targetId: "a",
	title: "içerik",
	reportCount: 3,
	...over,
});

describe("buildWaveManifest — the same-author grouping (Shift-X grabs the author)", () => {
	it("collects only the given actor's targets, in queue order", () => {
		const rows = [
			row({targetId: "a", authorId: "actor-1"}),
			row({targetId: "b", authorId: "actor-2"}),
			row({targetId: "c", authorId: "actor-1"}),
		];
		expect(buildWaveManifest(rows, "actor-1").map((t) => t.targetId)).toEqual(["a", "c"]);
	});

	it("carries kind, title, and report count per target (the scannable manifest)", () => {
		const rows = [row({targetId: "a", title: "spam", reportCount: 4, targetKind: "definition"})];
		expect(buildWaveManifest(rows, "actor-1")).toEqual([
			{targetKind: "definition", targetId: "a", title: "spam", reportCount: 4},
		]);
	});

	it("groups nothing for an unresolved actor (no join key, never lumps anonymized rows)", () => {
		const rows = [row({authorId: null}), row({targetId: "b", authorId: null})];
		expect(buildWaveManifest(rows, null)).toEqual([]);
	});
});

describe("initialWaveSelection — safe-by-default (auto-deselect zero-report targets)", () => {
	it("pre-selects every reported target", () => {
		const targets = [
			target({targetId: "a", reportCount: 3}),
			target({targetId: "b", reportCount: 1}),
		];
		expect(initialWaveSelection(targets)).toEqual(["post:a", "post:b"]);
	});

	it("auto-deselects a zero-report target (removes reported content, never censors)", () => {
		const targets = [
			target({targetId: "a", reportCount: 3}),
			target({targetId: "b", reportCount: 0}),
			target({targetId: "c", reportCount: 2}),
		];
		expect(initialWaveSelection(targets)).toEqual(["post:a", "post:c"]);
	});
});

describe("selectAllWave / toggleWaveRow — T selects all, Space toggles a row", () => {
	it("T selects every target including the zero-report ones (explicit override)", () => {
		const targets = [
			target({targetId: "a", reportCount: 3}),
			target({targetId: "b", reportCount: 0}),
		];
		expect(selectAllWave(targets)).toEqual(["post:a", "post:b"]);
	});

	it("Space adds an absent row and removes a present one", () => {
		expect(toggleWaveRow(["post:a"], "post:b")).toEqual(["post:a", "post:b"]);
		expect(toggleWaveRow(["post:a", "post:b"], "post:a")).toEqual(["post:b"]);
	});

	it("isWaveSelected reflects membership", () => {
		expect(isWaveSelected(["post:a"], "post:a")).toBe(true);
		expect(isWaveSelected(["post:a"], "post:b")).toBe(false);
	});
});

describe("selectedWaveTargets / canApplyWave — the batch fan-out domain", () => {
	it("resolves the selected targets in manifest order", () => {
		const targets = [target({targetId: "a"}), target({targetId: "b"}), target({targetId: "c"})];
		expect(selectedWaveTargets(targets, ["post:a", "post:c"]).map((t) => t.targetId)).toEqual([
			"a",
			"c",
		]);
	});

	it("requires a non-empty selection before a batch verdict applies", () => {
		expect(canApplyWave([])).toBe(false);
		expect(canApplyWave(["post:a"])).toBe(true);
	});
});

describe("blastRadiusLabel — the plain-Turkish magnitude confirm (not a noise prompt)", () => {
	it("names target count + total reports collapsed + reversibility", () => {
		const targets = [
			target({targetId: "a", reportCount: 4}),
			target({targetId: "b", reportCount: 5}),
			target({targetId: "c", reportCount: 2}),
		];
		expect(blastRadiusLabel(targets, ["post:a", "post:b"])).toBe(
			"2 hedef · 9 raporu kapatır · geri alınabilir",
		);
	});

	it("restates the real magnitude off the current selection (a toggle changes it)", () => {
		const targets = [
			target({targetId: "a", reportCount: 4}),
			target({targetId: "b", reportCount: 5}),
		];
		expect(blastRadiusLabel(targets, ["post:a"])).toBe(
			"1 hedef · 4 raporu kapatır · geri alınabilir",
		);
	});
});

describe("waveManifestLabel — the manifest heading", () => {
	it("names the actor's reported-target breadth", () => {
		expect(waveManifestLabel(3)).toBe("bu aktör · 3 bildirili hedef");
	});
});

describe("waveKeyToAction — Shift-X grab, T/Space select, ⌥R/⌥Y batch", () => {
	const ev = (over: Partial<Parameters<typeof waveKeyToAction>[0]> = {}) => ({
		key: "X",
		code: "KeyX",
		altKey: false,
		...over,
	});

	it("Shift-X grabs, T selects all, Space toggles the focused row", () => {
		expect(waveKeyToAction(ev({key: "X"}))).toEqual({kind: "grab"});
		expect(waveKeyToAction(ev({key: "T", code: "KeyT"}))).toEqual({kind: "selectAll"});
		expect(waveKeyToAction(ev({key: " ", code: "Space"}))).toEqual({kind: "toggleRow"});
	});

	it("matches ⌥R / ⌥Y on the physical code (macOS Option remaps the glyph)", () => {
		expect(waveKeyToAction(ev({key: "®", code: "KeyR", altKey: true}))).toEqual({
			kind: "batchRemove",
		});
		expect(waveKeyToAction(ev({key: "´", code: "KeyY", altKey: true}))).toEqual({
			kind: "batchDismiss",
		});
	});

	it("ignores an unbound key and an unrelated Option combo", () => {
		expect(waveKeyToAction(ev({key: "q", code: "KeyQ"}))).toBeNull();
		expect(waveKeyToAction(ev({key: "π", code: "KeyP", altKey: true}))).toBeNull();
	});
});

describe("batchVerdict — the verdict a batch action commits", () => {
	it("maps batchRemove → remove and batchDismiss → dismiss", () => {
		expect(batchVerdict({kind: "batchRemove"})).toBe("remove");
		expect(batchVerdict({kind: "batchDismiss"})).toBe("dismiss");
	});

	it("returns null for a non-verdict action", () => {
		expect(batchVerdict({kind: "grab"})).toBeNull();
		expect(batchVerdict({kind: "selectAll"})).toBeNull();
	});
});

describe("waveConfirmKey — Enter applies, Esc cancels the blast-radius confirm", () => {
	it("maps Enter to apply and Escape to cancel", () => {
		expect(waveConfirmKey("Enter")).toBe("apply");
		expect(waveConfirmKey("Escape")).toBe("cancel");
	});

	it("never commits on a stray key", () => {
		expect(waveConfirmKey("R")).toBeNull();
		expect(waveConfirmKey(" ")).toBeNull();
	});
});

describe("summarizeWaveBatch / waveFailureLabel — no silent partial drop", () => {
	it("partitions per-target outcomes into resolved and failed, preserving order", () => {
		expect(
			summarizeWaveBatch([
				{key: "post:a", ok: true},
				{key: "post:b", ok: false},
				{key: "post:c", ok: true},
			]),
		).toEqual({resolved: ["post:a", "post:c"], failed: ["post:b"]});
	});

	it("surfaces which targets did not resolve, or null on a fully-applied batch", () => {
		expect(waveFailureLabel(2)).toBe("2 hedef çözülemedi, tekrar dene");
		expect(waveFailureLabel(0)).toBeNull();
	});
});

describe("waveTargetKey — the <kind>:<id> identity report.resolve acts on", () => {
	it("joins kind and id", () => {
		expect(waveTargetKey({targetKind: "definition", targetId: "x"})).toBe("definition:x");
	});
});

describe("waveResolveInputs — ONE shared waveId across the batch (#1855, AC4)", () => {
	it("stamps the SAME generated waveId on every selected target's resolve input", () => {
		const targets = [
			target({targetKind: "post", targetId: "a"}),
			target({targetKind: "comment", targetId: "b"}),
			target({targetKind: "definition", targetId: "c"}),
		];
		const inputs = waveResolveInputs(targets, "wave-42");
		expect(inputs.map((i) => i.waveId)).toEqual(["wave-42", "wave-42", "wave-42"]);
		expect(new Set(inputs.map((i) => i.waveId)).size).toBe(1);
		expect(inputs.map((i) => waveTargetKey(i))).toEqual(["post:a", "comment:b", "definition:c"]);
	});

	it("preserves the partial-failure surfacing — the wave groups only the successes (AC5)", () => {
		// The fan-out threads one waveId; each call's outcome partitions independently, so a
		// failed target stays actionable (its write never landed ⇒ it carries no grouping).
		const targets = [target({targetId: "a"}), target({targetId: "b"}), target({targetId: "c"})];
		const inputs = waveResolveInputs(targets, "wave-9");
		const outcomes = inputs.map((i, idx) => ({key: waveTargetKey(i), ok: idx !== 1}));
		const {resolved, failed} = summarizeWaveBatch(outcomes);
		expect(resolved).toEqual(["post:a", "post:c"]);
		expect(failed).toEqual(["post:b"]);
		expect(waveFailureLabel(failed.length)).toBe("1 hedef çözülemedi, tekrar dene");
	});
});
