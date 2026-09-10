import {describe, expect, it} from "vitest";
import type {PickerEntries} from "./entries.ts";
import {noEntries, programEntries} from "./entries.ts";
import {processId, programId, programRow, windowId} from "./fixtures.ts";
import {unknownProgram} from "./refusal.ts";
import {
	asPickerView,
	cursorOf,
	highlighted,
	mountPicker,
	pickerKey,
	pickerPointer,
	withFilter,
	withRefusal,
} from "./view.ts";

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
			view: {cursor: 0, refusal: null, previous: null, filter: null},
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
			view: {cursor: 2, refusal: null, previous: "p-1", filter: null},
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
			filter: null,
		});
	});

	it("a move clears the refusal, because the user has moved on from it", () => {
		const refused = withRefusal(mountPicker(), unknownProgram("nope"));
		expect(pickerKey(window, entries, refused, "j")).toEqual({
			_tag: "Moved",
			view: {cursor: 1, refusal: null, previous: null, filter: null},
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
			view: {cursor: 0, refusal: null, previous: null, filter: null},
		});
	});

	it("a cursor left past the end of a shrunken list reads as the last row", () => {
		const stale = {cursor: 9, refusal: null, previous: null, filter: null};
		expect(highlighted(entries, stale)).toEqual(entries.processes[0]);
		expect(pickerKey(window, entries, stale, "<arrowup>")).toEqual({
			_tag: "Moved",
			view: {cursor: 1, refusal: null, previous: null, filter: null},
		});
	});
});

describe("picker pointer", () => {
	it("a pointer landing on a row moves the same cursor an arrow key moves", () => {
		expect(pickerPointer(window, entries, mountPicker(), 2, "hover")).toEqual({
			_tag: "Moved",
			view: {cursor: 2, refusal: null, previous: null, filter: null},
		});
		expect(pickerPointer(window, entries, mountPicker(), 2, "hover")).toEqual(
			pickerKey(window, entries, press(mountPicker(), "j"), "j"),
		);
	});

	it("a click commits the row under it to the same intent Enter would run", () => {
		expect(pickerPointer(window, entries, mountPicker(), 0, "click")).toEqual({
			_tag: "Chose",
			intent: {_tag: "OpenProgram", windowId: window, programId: "counter"},
		});
		expect(pickerPointer(window, entries, mountPicker(), 2, "click")).toEqual({
			_tag: "Chose",
			intent: {_tag: "AttachProcess", windowId: window, processId: "p-1"},
		});
	});

	it("the row the pointer last landed on is the row Enter then chooses", () => {
		const hovered = pickerPointer(window, entries, mountPicker(), 2, "hover");
		if (hovered._tag !== "Moved") throw new Error("a hover onto a row must answer Moved");
		expect(highlighted(entries, hovered.view)).toEqual(entries.processes[0]);
		expect(pickerKey(window, entries, hovered.view, "<enter>")).toEqual({
			_tag: "Chose",
			intent: {_tag: "AttachProcess", windowId: window, processId: "p-1"},
		});
	});

	it("a pointer move onto another row clears the refusal, as a keyboard move does", () => {
		const refused = withRefusal(mountPicker(), unknownProgram("nope"));
		expect(pickerPointer(window, entries, refused, 1, "hover")).toEqual({
			_tag: "Moved",
			view: {cursor: 1, refusal: null, previous: null, filter: null},
		});
		// Landing on the row already under the cursor is not moving on from anything — the answer
		// `movedTo` gives a keyboard press that cannot move either.
		expect(pickerPointer(window, entries, refused, 0, "hover")).toEqual({
			_tag: "Moved",
			view: {cursor: 0, refusal: unknownProgram("nope"), previous: null, filter: null},
		});
	});

	it("a gesture on a row the list no longer offers is ignored, never clamped", () => {
		expect(pickerPointer(window, entries, mountPicker(), 9, "hover")).toEqual({_tag: "Ignored"});
		expect(pickerPointer(window, entries, mountPicker(), 9, "click")).toEqual({_tag: "Ignored"});
		expect(pickerPointer(window, noEntries, mountPicker(), 0, "click")).toEqual({_tag: "Ignored"});
	});
});

/**
 * The filter's half of the keyboard (#8450). Everything typed *into* the filter is the input's own —
 * the desk leaves a focused text entry its presses — so what is proved here is the keys that open
 * it, move under it, close it and commit through it.
 */
describe("picker filter", () => {
	const filtered = (text: string) => withFilter(mountPicker(), text);

	it("`/` opens the filter, and it is no longer a key the picker ignores", () => {
		expect(pickerKey(window, entries, mountPicker(), "/")).toEqual({
			_tag: "Filtering",
			view: {cursor: null, refusal: null, previous: null, filter: ""},
		});
	});

	it("keeps j, k, g and G as movement, because `/` is what takes text", () => {
		expect(press(mountPicker(), "j").cursor).toBe(1);
		expect(press(mountPicker(), "j", "j", "k").cursor).toBe(1);
		expect(press(mountPicker(), "G").cursor).toBe(2);
		expect(press(mountPicker(), "G", "g").cursor).toBe(0);
	});

	it("narrows the list the cursor addresses, so a stale cursor cannot outrun it", () => {
		// `pi` is the second row unfiltered; filtered to "pi" it is the only one. A cursor left on 2 —
		// a row the filter hides — reads as a row that survived, and Enter runs that same row.
		const stale = {...filtered("pi"), cursor: 2};
		expect(cursorOf(entries, stale)).toBe(0);
		expect(highlighted(entries, stale)).toEqual(entries.programs[1]);
		expect(pickerKey(window, entries, stale, "<enter>")).toEqual({
			_tag: "Chose",
			intent: {_tag: "OpenProgram", windowId: window, programId: "pi"},
		});
	});

	it("Escape closes the filter before it reaches `previous`, keeping the row in view", () => {
		expect(pickerKey(window, entries, filtered("counter"), "<escape>")).toEqual({
			_tag: "Filtering",
			// Row 0 of the "counter" match set is the flattened list's row 0 again, widened.
			view: {cursor: 0, refusal: null, previous: null, filter: null},
		});
		// Only a picker with no filter left goes back to the process it was showing.
		expect(pickerKey(window, entries, mountPicker("p-1"), "<escape>")._tag).toBe("Chose");
	});

	it("an edit of the filter unplaces the cursor, because index 2 is a different row now", () => {
		expect(withFilter({...mountPicker(), cursor: 2}, "co")).toEqual({
			cursor: null,
			refusal: null,
			previous: null,
			filter: "co",
		});
	});

	it("reads a filter back out of the slot, and anything that is not a string as none", () => {
		expect(asPickerView({cursor: 1, refusal: null, previous: null, filter: "pi"}).filter).toBe(
			"pi",
		);
		expect(asPickerView({cursor: 1, refusal: null, previous: null, filter: 7}).filter).toBeNull();
		expect(asPickerView({cursor: 1}).filter).toBeNull();
	});
});
