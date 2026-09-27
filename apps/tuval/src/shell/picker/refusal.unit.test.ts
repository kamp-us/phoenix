/**
 * The two removal refusals (#9447), against the guard that reads them back and the function that
 * renders them.
 *
 * `isPickerRefusal` is the trust boundary and the tests are field by field for the reason the guard
 * is: a refusal lives in the window's view slot, which is checkpointed JSON, so an arm-shaped value
 * missing a field would come back off disk and render `undefined` at an operator.
 */

import {describe, expect, it} from "vitest";
import {
	isPickerRefusal,
	type PickerRefusal,
	processPlanned,
	refusalMessage,
	removeFailed,
} from "./refusal.ts";

const planned = processPlanned("p-1");
const failed = removeFailed("p-1", "store write refused");

describe("the graph-declared refusal", () => {
	it("says to edit the config, because nothing at the desk outlives the next boot", () => {
		expect(refusalMessage(planned)).toBe(
			'Process "p-1" is declared by the config graph, so boot would start it again. Edit the config to remove it.',
		);
	});

	it("reads back off the slot, and not one field short of itself", () => {
		expect(isPickerRefusal(planned)).toBe(true);
		expect(isPickerRefusal({_tag: "ProcessPlanned"})).toBe(false);
		expect(isPickerRefusal({_tag: "ProcessPlanned", processId: 7})).toBe(false);
	});
});

describe("the failed-forget refusal", () => {
	it("says the process is still running, and carries the store's own reason", () => {
		expect(refusalMessage(failed)).toBe(
			'Process "p-1" was not removed and is still running: store write refused',
		);
	});

	it("reads back off the slot, and needs both of its fields", () => {
		expect(isPickerRefusal(failed)).toBe(true);
		expect(isPickerRefusal({_tag: "RemoveFailed", processId: "p-1"})).toBe(false);
		expect(isPickerRefusal({_tag: "RemoveFailed", reason: "store write refused"})).toBe(false);
		expect(isPickerRefusal({_tag: "RemoveFailed", processId: "p-1", reason: 7})).toBe(false);
	});
});

describe("every arm", () => {
	it("renders a message, so no reader ever meets an unhandled tag", () => {
		const arms: ReadonlyArray<PickerRefusal> = [
			{_tag: "UnknownProgram", programId: "ghost"},
			{_tag: "ProgramHeadless", programId: "indexer"},
			{_tag: "ProcessGone", processId: "p-1"},
			{_tag: "SpawnFailed", programId: "counter", reason: "no"},
			{_tag: "UnreadableCommand", line: "nope", reason: "no such verb"},
			planned,
			failed,
		];
		for (const arm of arms) {
			expect(`${arm._tag}: ${isPickerRefusal(arm)}`).toBe(`${arm._tag}: true`);
			expect(refusalMessage(arm).length).toBeGreaterThan(0);
		}
		expect(isPickerRefusal({_tag: "ProcessForgotten", processId: "p-1"})).toBe(false);
	});
});
