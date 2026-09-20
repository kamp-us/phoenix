/**
 * Desk state as data: the two toggles, and the guard a checkpoint's `unknown` is recovered through.
 * The reducer's own proof — that the open inspector survives a workspace switch — is driven through
 * the core in `../core/machine.unit.test.ts`, because that is where the switch lives.
 */

import {describe, expect, it} from "vitest";
import {closeBoard, initialDesk, isDeskState, toggleBoard, toggleInspector} from "./state.ts";

describe("desk state", () => {
	it("starts collapsed and toggles both ways", () => {
		expect(initialDesk).toEqual({inspectorOpen: false, boardOpen: false});
		expect(toggleInspector(initialDesk).inspectorOpen).toBe(true);
		expect(toggleInspector(toggleInspector(initialDesk))).toEqual(initialDesk);
	});

	it("pulls the board up and puts it away, and a close from either side is closed", () => {
		expect(toggleBoard(initialDesk).boardOpen).toBe(true);
		expect(toggleBoard(toggleBoard(initialDesk))).toEqual(initialDesk);
		expect(closeBoard(toggleBoard(initialDesk))).toEqual(initialDesk);
		expect(closeBoard(initialDesk)).toEqual(initialDesk);
	});

	it("moves one surface without touching the other", () => {
		const open = toggleInspector(initialDesk);
		expect(toggleBoard(open).inspectorOpen).toBe(true);
		expect(toggleInspector(toggleBoard(initialDesk)).boardOpen).toBe(true);
	});

	it("admits a desk it could have written and refuses anything else", () => {
		expect([isDeskState({inspectorOpen: true, boardOpen: true}), isDeskState(initialDesk)]).toEqual(
			[true, true],
		);
		expect([
			isDeskState({}),
			isDeskState({inspectorOpen: "yes", boardOpen: false}),
			// A desk written before the board existed. Refused rather than defaulted: `SHELL_VERSION`
			// is what refuses a checkpoint under the old shape, and a guard that filled the gap in
			// would be a second, quieter answer to the same question (`../program.ts`).
			isDeskState({inspectorOpen: false}),
			isDeskState(null),
			isDeskState([]),
			isDeskState("open"),
		]).toEqual([false, false, false, false, false, false]);
	});
});
