/**
 * The saved-posts reconcile contract (#1417) — the one saved-ness rule asserted
 * without a DOM (the pure-extraction idiom of `divanGating` / `searchTarget`). These
 * are the AC the page lives or dies on: count + empty-state must track live `isSaved`,
 * not edge-`node` truthiness, so an in-list un-save decrements the count and un-saving
 * the last loaded row trips the empty state.
 */
import {describe, expect, it} from "vitest";
import {countSavedRows, isRowSaved} from "./savedReconcile";

describe("isRowSaved — the one saved-ness rule", () => {
	it("treats explicit false as unsaved", () => {
		expect(isRowSaved(false)).toBe(false);
	});

	it("treats true as saved", () => {
		expect(isRowSaved(true)).toBe(true);
	});

	it("treats null/undefined (unresolved) as saved, matching SavedRow's drop-on-===false rule", () => {
		expect(isRowSaved(null)).toBe(true);
		expect(isRowSaved(undefined)).toBe(true);
	});
});

describe("countSavedRows — list count + empty-state off the same rule", () => {
	it("counts every id as saved when none reported (default-saved before rows resolve)", () => {
		expect(countSavedRows(["a", "b", "c"], new Map())).toBe(3);
	});

	it("excludes rows whose live isSaved flipped false (the in-list un-save)", () => {
		const reads = new Map<string, boolean>([
			["a", true],
			["b", false],
			["c", true],
		]);
		expect(countSavedRows(["a", "b", "c"], reads)).toBe(2);
	});

	it("is 0 (empty-state) when the last loaded saved row un-saves", () => {
		expect(countSavedRows(["a"], new Map([["a", false]]))).toBe(0);
	});

	it("ignores a stale report for an id no longer in the connection", () => {
		const reads = new Map<string, boolean>([
			["a", true],
			["gone", false],
		]);
		expect(countSavedRows(["a"], reads)).toBe(1);
	});
});
