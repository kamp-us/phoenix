import {describe, expect, it} from "vitest";
import {decideReadback, type ReadbackState} from "./readback";

const state = (expectedId: string, probesRemaining: number): ReadbackState => ({
	expectedId,
	probesRemaining,
});

describe("decideReadback", () => {
	it("settles immediately when the live push already landed the node", () => {
		// The whole point: if the `appendNode` won the race, never refetch.
		expect(decideReadback(new Set(["c1", "c2"]), state("c2", 3))).toEqual({action: "settled"});
	});

	it("waits while probes remain and the node is absent", () => {
		expect(decideReadback(new Set(["c1"]), state("c2", 3))).toEqual({
			action: "wait",
			next: {expectedId: "c2", probesRemaining: 2},
		});
	});

	it("counts probes down to zero across successive absent ticks", () => {
		let s = state("c2", 2);
		const empty = new Set<string>();
		const first = decideReadback(empty, s);
		expect(first).toEqual({action: "wait", next: {expectedId: "c2", probesRemaining: 1}});
		s = (first as {next: ReadbackState}).next;
		const second = decideReadback(empty, s);
		expect(second).toEqual({action: "wait", next: {expectedId: "c2", probesRemaining: 0}});
	});

	it("refetches deterministically once the probe budget is spent", () => {
		expect(decideReadback(new Set(["other"]), state("c2", 0))).toEqual({action: "refetch"});
	});

	it("settles even on the final probe if the push lands at the last moment", () => {
		// Presence is checked before the budget — a late push still wins over a refetch.
		expect(decideReadback(new Set(["c2"]), state("c2", 0))).toEqual({action: "settled"});
	});

	it("treats a negative budget as spent (refetch, not an infinite wait)", () => {
		expect(decideReadback(new Set<string>(), state("c2", -1))).toEqual({action: "refetch"});
	});
});
