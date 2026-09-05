/**
 * Desk state as data: the toggle, and the guard a checkpoint's `unknown` is recovered through. The
 * reducer's own proof — that the open inspector survives a workspace switch — is driven through the
 * core in `../core/machine.unit.test.ts`, because that is where the switch lives.
 */

import {describe, expect, it} from "vitest";
import {initialDesk, isDeskState, toggleInspector} from "./state.ts";

describe("desk state", () => {
	it("starts collapsed and toggles both ways", () => {
		expect(initialDesk).toEqual({inspectorOpen: false});
		expect(toggleInspector(initialDesk).inspectorOpen).toBe(true);
		expect(toggleInspector(toggleInspector(initialDesk))).toEqual(initialDesk);
	});

	it("admits a desk it could have written and refuses anything else", () => {
		expect([isDeskState({inspectorOpen: true}), isDeskState(initialDesk)]).toEqual([true, true]);
		expect([
			isDeskState({}),
			isDeskState({inspectorOpen: "yes"}),
			isDeskState(null),
			isDeskState([]),
			isDeskState("open"),
		]).toEqual([false, false, false, false, false]);
	});
});
