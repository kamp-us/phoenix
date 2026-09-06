import {describe, expect, it} from "vitest";
import type {PickerEntries} from "./entries.ts";
import {noEntries, programEntries} from "./entries.ts";
import {processId, programId, programRow, windowId} from "./fixtures.ts";
import {unknownProgram} from "./refusal.ts";
import {highlighted, mountPicker, pickerKey, withRefusal} from "./view.ts";

const window = windowId("window-1");

const entries: PickerEntries = {
	programs: programEntries([programRow("counter"), programRow("pi")]),
	processes: [
		{
			_tag: "Process",
			processId: processId("p-1"),
			programId: programId("counter"),
			label: "counter",
			parentId: null,
		},
	],
};

const press = (view: ReturnType<typeof mountPicker>, ...keys: ReadonlyArray<string>) => {
	let current = view;
	for (const key of keys) {
		const answer = pickerKey(window, entries, current, key);
		if (answer._tag === "Moved" || answer._tag === "Cleared") current = answer.view;
	}
	return current;
};

describe("picker keyboard", () => {
	it("walks the flattened list with the arrow keys and their vim and readline spellings", () => {
		expect(press(mountPicker(), "<arrowdown>").cursor).toBe(1);
		expect(press(mountPicker(), "j", "j").cursor).toBe(2);
		expect(press(mountPicker(), "<c-n>", "<c-n>", "<c-p>").cursor).toBe(1);
		expect(press(mountPicker(), "<tab>", "<s-tab>").cursor).toBe(0);
	});

	it("clamps at both ends rather than wrapping, and Home and End jump", () => {
		expect(press(mountPicker(), "<arrowup>").cursor).toBe(0);
		expect(press(mountPicker(), "j", "j", "j", "j").cursor).toBe(2);
		expect(press(mountPicker(), "<end>").cursor).toBe(2);
		expect(press(mountPicker(), "<end>", "<home>").cursor).toBe(0);
	});

	it("moving past the programs section crosses into the processes section", () => {
		const at = press(mountPicker(), "<end>");
		expect(highlighted(entries, at)).toEqual({
			_tag: "Process",
			processId: "p-1",
			programId: "counter",
			label: "counter",
			parentId: null,
		});
	});

	it("Enter and Space commit the highlighted row to its intent", () => {
		expect(pickerKey(window, entries, mountPicker(), "<enter>")).toEqual({
			_tag: "Chose",
			intent: {_tag: "OpenProgram", windowId: window, programId: "counter"},
		});
		expect(pickerKey(window, entries, press(mountPicker(), "<end>"), "<space>")).toEqual({
			_tag: "Chose",
			intent: {_tag: "AttachProcess", windowId: window, processId: "p-1"},
		});
	});

	it("Escape clears a standing refusal and is ignored when there is none", () => {
		const refused = withRefusal(mountPicker(), unknownProgram("nope"));
		expect(pickerKey(window, entries, refused, "<escape>")).toEqual({
			_tag: "Cleared",
			view: {cursor: 0, refusal: null, previous: null},
		});
		expect(pickerKey(window, entries, mountPicker(), "<escape>")).toEqual({_tag: "Ignored"});
	});

	it("Escape on a picker with a `previous` attaches that process back (#8265)", () => {
		expect(pickerKey(window, entries, mountPicker("p-1"), "<escape>")).toEqual({
			_tag: "Chose",
			intent: {_tag: "AttachProcess", windowId: window, processId: "p-1"},
		});
	});

	it("a refusal is dismissed first, and the Escape after it returns (#8265)", () => {
		const refused = withRefusal(mountPicker("p-1"), unknownProgram("nope"));
		const cleared = pickerKey(window, entries, refused, "<escape>");
		expect(cleared).toEqual({
			_tag: "Cleared",
			view: {cursor: 2, refusal: null, previous: "p-1"},
		});
		if (cleared._tag !== "Cleared") throw new Error("test setup: Escape cleared nothing");
		expect(pickerKey(window, entries, cleared.view, "<escape>")).toEqual({
			_tag: "Chose",
			intent: {_tag: "AttachProcess", windowId: window, processId: "p-1"},
		});
	});

	it("a `previous` no row offers still chooses — liveness is the attach handler's (#8265)", () => {
		expect(highlighted(entries, mountPicker("p-gone"))).toEqual(entries.programs[0]);
		expect(pickerKey(window, entries, mountPicker("p-gone"), "<escape>")).toEqual({
			_tag: "Chose",
			intent: {_tag: "AttachProcess", windowId: window, processId: "p-gone"},
		});
	});

	it("an unplaced cursor starts on the `previous` row rather than the first (#8265)", () => {
		expect(highlighted(entries, mountPicker("p-1"))).toEqual(entries.processes[0]);
		// Once the operator moves, the cursor is theirs and `previous` only names Escape's target.
		expect(press(mountPicker("p-1"), "<home>")).toEqual({
			cursor: 0,
			refusal: null,
			previous: "p-1",
		});
	});

	it("a move clears the refusal, because the user has moved on from it", () => {
		const refused = withRefusal(mountPicker(), unknownProgram("nope"));
		expect(pickerKey(window, entries, refused, "j")).toEqual({
			_tag: "Moved",
			view: {cursor: 1, refusal: null, previous: null},
		});
	});

	it("a key the picker does not own is ignored, so the surface may pass it on", () => {
		expect(pickerKey(window, entries, mountPicker(), "q")).toEqual({_tag: "Ignored"});
		expect(pickerKey(window, entries, mountPicker(), "<c-b>")).toEqual({_tag: "Ignored"});
		expect(pickerKey(window, entries, mountPicker(), "<not a key>")).toEqual({_tag: "Ignored"});
	});

	it("an empty picker has nothing to highlight and nothing to choose", () => {
		expect(highlighted(noEntries, mountPicker())).toBeNull();
		expect(pickerKey(window, noEntries, mountPicker(), "<enter>")).toEqual({_tag: "Ignored"});
		expect(pickerKey(window, noEntries, mountPicker(), "j")).toEqual({
			_tag: "Moved",
			view: {cursor: 0, refusal: null, previous: null},
		});
	});

	it("a cursor left past the end of a shrunken list reads as the last row", () => {
		const stale = {cursor: 9, refusal: null, previous: null};
		expect(highlighted(entries, stale)).toEqual(entries.processes[0]);
		expect(pickerKey(window, entries, stale, "<arrowup>")).toEqual({
			_tag: "Moved",
			view: {cursor: 1, refusal: null, previous: null},
		});
	});
});
