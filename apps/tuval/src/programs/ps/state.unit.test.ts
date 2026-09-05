import {describe, expect, it} from "vitest";
import {processId} from "./fixtures.ts";
import {applyPsMsg, isPsState, psInitialState, psSelect, psSortBy, psStateFrom} from "./state.ts";

describe("applyPsMsg", () => {
	it("starts a newly picked column ascending", () => {
		expect(applyPsMsg(psInitialState, psSortBy("revision"))).toEqual({
			...psInitialState,
			sortColumn: "revision",
			sortDirection: "ascending",
		});
	});

	it("starts sorted by no column at all, which is the default forest order", () => {
		expect(psInitialState.sortColumn).toBeNull();
	});

	it("flips the current column, then flips it back", () => {
		const ascending = applyPsMsg(psInitialState, psSortBy("process"));
		expect(ascending.sortDirection).toBe("ascending");
		const descending = applyPsMsg(ascending, psSortBy("process"));
		expect(descending.sortDirection).toBe("descending");
		expect(applyPsMsg(descending, psSortBy("process")).sortDirection).toBe("ascending");
	});

	it("carries the selection through a sort", () => {
		const selected = applyPsMsg(psInitialState, psSelect(processId("root-a")));
		expect(applyPsMsg(selected, psSortBy("ports")).selectedProcessId).toBe(processId("root-a"));
	});

	it("clears the selection when handed none", () => {
		const selected = applyPsMsg(psInitialState, psSelect(processId("root-a")));
		expect(applyPsMsg(selected, psSelect(null)).selectedProcessId).toBeNull();
	});
});

describe("psStateFrom", () => {
	it("fills every cell from an empty checkpoint", () => {
		expect(psStateFrom(null)).toEqual(psInitialState);
		expect(psStateFrom({})).toEqual(psInitialState);
	});

	it("falls back to the default order when a checkpoint names a column this build dropped", () => {
		expect(psStateFrom({sortColumn: "capabilities" as never}).sortColumn).toBeNull();
	});

	it("keeps a checkpoint this build can read", () => {
		expect(psStateFrom({sortColumn: "revision", sortDirection: "descending"})).toEqual({
			sortColumn: "revision",
			sortDirection: "descending",
			selectedProcessId: null,
		});
	});
});

describe("isPsState", () => {
	it("admits this program's own state", () => {
		expect(isPsState(psInitialState)).toBe(true);
		expect(isPsState(applyPsMsg(psInitialState, psSelect(processId("root-a"))))).toBe(true);
	});

	it("refuses another program's state, so a foreign host renders the empty table", () => {
		expect(isPsState({count: 3})).toBe(false);
		expect(isPsState({...psInitialState, sortDirection: "sideways"})).toBe(false);
		expect(isPsState(null)).toBe(false);
	});
});
