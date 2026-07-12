/**
 * The triage-loop hero's interaction contract (#1703, ADR 0138) — the pure focus /
 * verdict-key / confirm-gate / Esc-ladder decisions asserted without a DOM, per the
 * `raporlarGating.test.ts` precedent. The AC the loop lives or dies on: one target at
 * a time with a real focus-state; `j/k` navigate; `Y` dismisses in one keystroke while
 * `R` gates on a confirm; `U`/`O`/`Esc` bindings; the reputation-in-row + reporter
 * diversity copy.
 */
import {describe, expect, it} from "vitest";
import type {TargetKind} from "../../../worker/db/target-kind";
import {
	authorReputationLabel,
	drainedLabel,
	escapeTo,
	focusAfterResolve,
	focusAt,
	keyToAction,
	maskedExcerpt,
	moveFocus,
	needsConfirm,
	nextChamber,
	reporterDiversityLabel,
	triageLegend,
} from "./triage-loop";

const q = (...ids: string[]): ReadonlyArray<{targetKind: TargetKind; targetId: string}> =>
	ids.map((targetId) => ({targetKind: "post" as const, targetId}));

describe("focusAt — the single-target focus state", () => {
	it("resolves the target at a valid index", () => {
		expect(focusAt(q("a", "b", "c"), 1)).toEqual({index: 1, targetKind: "post", targetId: "b"});
	});

	it("clamps an out-of-range index to the last row (a verdict on the tail lands real)", () => {
		expect(focusAt(q("a", "b"), 9)).toEqual({index: 1, targetKind: "post", targetId: "b"});
	});

	it("has no focus for an empty queue (the drained state)", () => {
		expect(focusAt(q(), 0)).toBeNull();
	});
});

describe("moveFocus — j/k navigation, clamped (no wrap)", () => {
	it("advances with j (delta +1) inside bounds", () => {
		expect(moveFocus(0, 1, 3)).toBe(1);
	});

	it("retreats with k (delta -1) inside bounds", () => {
		expect(moveFocus(2, -1, 3)).toBe(1);
	});

	it("clamps at the top edge (k on the first row stays)", () => {
		expect(moveFocus(0, -1, 3)).toBe(0);
	});

	it("clamps at the bottom edge (j on the last row stays)", () => {
		expect(moveFocus(2, 1, 3)).toBe(2);
	});
});

describe("focusAfterResolve — where the cursor lands after a verdict collapses the row", () => {
	it("keeps the same position so the next target slides under the cursor", () => {
		expect(focusAfterResolve(1, 3)).toBe(1);
	});

	it("clamps back to the new last row when the tail was resolved", () => {
		expect(focusAfterResolve(3, 3)).toBe(2);
	});

	it("returns 0 when the queue drained", () => {
		expect(focusAfterResolve(0, 0)).toBe(0);
	});
});

describe("keyToAction — the loop's keybindings (case-sensitive verdicts)", () => {
	it("maps j / ArrowDown to next and k / ArrowUp to prev", () => {
		expect(keyToAction("j")).toEqual({kind: "next"});
		expect(keyToAction("ArrowDown")).toEqual({kind: "next"});
		expect(keyToAction("k")).toEqual({kind: "prev"});
		expect(keyToAction("ArrowUp")).toEqual({kind: "prev"});
	});

	it("maps the founder-confirmed uppercase verdict keys Y and R", () => {
		expect(keyToAction("Y")).toEqual({kind: "dismiss"});
		expect(keyToAction("R")).toEqual({kind: "remove"});
	});

	it("does NOT treat a lowercase y/r as a verdict (mid-typing safety)", () => {
		expect(keyToAction("y")).toBeNull();
		expect(keyToAction("r")).toBeNull();
	});

	it("maps U undo, O reveal, Tab chamber-switch, Escape ladder", () => {
		expect(keyToAction("U")).toEqual({kind: "undo"});
		expect(keyToAction("O")).toEqual({kind: "toggleExcerpt"});
		expect(keyToAction("Tab")).toEqual({kind: "switchChamber"});
		expect(keyToAction("Escape")).toEqual({kind: "escape"});
	});

	it("ignores an unbound key (never swallows a shortcut it doesn't own)", () => {
		expect(keyToAction("x")).toBeNull();
		expect(keyToAction("Enter")).toBeNull();
	});
});

describe("needsConfirm — asymmetric verdict weight", () => {
	it("dismiss commits without a confirm (reversible, low-stakes)", () => {
		expect(needsConfirm("dismiss")).toBe(false);
	});

	it("remove requires a confirm (it hides content)", () => {
		expect(needsConfirm("remove")).toBe(true);
	});
});

describe("nextChamber — Tab toggles raporlar ⇄ kefil", () => {
	it("switches from raporlar to kefil and back", () => {
		expect(nextChamber("raporlar")).toBe("kefil");
		expect(nextChamber("kefil")).toBe("raporlar");
	});
});

describe("escapeTo — the Esc de-escalation ladder (one rung per press)", () => {
	it("closes a sheet before clearing a selection", () => {
		expect(escapeTo("sheet")).toBe("selection");
	});

	it("clears the selection before yielding to the grid", () => {
		expect(escapeTo("selection")).toBe("grid");
	});

	it("stays at the grid (the outermost rung)", () => {
		expect(escapeTo("grid")).toBe("grid");
	});
});

describe("reporterDiversityLabel — the pile-on shape (a real wave vs a grudge)", () => {
	it("surfaces the diversity contrast for a multi-report target", () => {
		expect(reporterDiversityLabel(9, 7)).toBe("9 rapor · 7 farklı kişi");
		expect(reporterDiversityLabel(9, 1)).toBe("9 rapor · 1 farklı kişi");
	});

	it("drops the diversity clause for a single report (nothing to contrast)", () => {
		expect(reporterDiversityLabel(1, 1)).toBe("1 rapor");
	});

	it("clamps distinct to [1, count] so it never exceeds the report count", () => {
		expect(reporterDiversityLabel(3, 9)).toBe("3 rapor · 3 farklı kişi");
	});
});

describe("authorReputationLabel — the reputation-in-row copy", () => {
	it("renders tier · karma · removals for a repeat offender", () => {
		expect(authorReputationLabel("çaylak", 3, 2)).toBe("çaylak · 3 karma · 2 kaldırma");
	});

	it("drops the removal clause for a clean author (zero removals)", () => {
		expect(authorReputationLabel("yazar", 240, 0)).toBe("yazar · 240 karma");
	});

	it("returns null when the author is unresolved (no fabricated reputation)", () => {
		expect(authorReputationLabel(null, null, null)).toBeNull();
		expect(authorReputationLabel("çaylak", null, 1)).toBeNull();
	});
});

describe("maskedExcerpt — the reveal-on-O gate (never force-fed a slur)", () => {
	it("masks the excerpt by default, hinting O to reveal", () => {
		expect(maskedExcerpt("kötü söz", false)).toBe("içerik gizli · O ile göster");
	});

	it("shows the excerpt once revealed", () => {
		expect(maskedExcerpt("kötü söz", true)).toBe("kötü söz");
	});

	it("reads the neutral fallback for a missing excerpt regardless of reveal", () => {
		expect(maskedExcerpt(null, true)).toBe("içerik yüklenemedi");
		expect(maskedExcerpt("  ", false)).toBe("içerik yüklenemedi");
	});
});

describe("drainedLabel — the earned empty state", () => {
	it("counts today's decisions when there were any", () => {
		expect(drainedLabel(12)).toBe("raporlar temiz · bugün 12 karar");
	});

	it("reads clean without a count for an already-empty queue", () => {
		expect(drainedLabel(0)).toBe("raporlar temiz");
	});
});

describe("triageLegend — the HUD key legend (#2726)", () => {
	it("names every bound gesture with keycap(s) + a lowercase action", () => {
		const byLabel = new Map(triageLegend.map((e) => [e.label, e.keys]));
		expect(byLabel.get("gez")).toEqual(["j", "k"]);
		expect(byLabel.get("yoksay")).toEqual(["Y"]);
		expect(byLabel.get("kaldır")).toEqual(["R"]);
		expect(byLabel.get("bölme")).toEqual(["V", "M"]);
		expect(byLabel.get("dalga")).toEqual(["X"]);
	});

	it("carries a keycap for every verdict/undo/reveal binding keyToAction maps", () => {
		const legendKeys = new Set(triageLegend.flatMap((e) => e.keys));
		for (const k of ["j", "k", "Y", "R", "U", "O"]) {
			expect(keyToAction(k)).not.toBeNull();
			expect(legendKeys.has(k)).toBe(true);
		}
	});
});
