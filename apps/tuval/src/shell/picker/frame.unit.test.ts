/**
 * The picker's accessibility contract, asserted as data. There is no DOM here on purpose: the frame
 * *is* the roles, names and states, so a page that binds it verbatim cannot lose them, and a
 * regression shows up as a failing equality rather than as an audit somebody has to run.
 */

import {describe, expect, it} from "vitest";
import {noEntries, type PickerEntries, programEntries} from "./entries.ts";
import {processId, programId, programRow, windowId} from "./fixtures.ts";
import {pickerFrame} from "./frame.ts";
import {processGone} from "./refusal.ts";
import {mountPicker, withRefusal} from "./view.ts";

const window = windowId("window-1");

const entries: PickerEntries = {
	programs: programEntries([programRow("counter", {label: "Counter"}), programRow("pi")]),
	processes: [
		{
			_tag: "Process",
			processId: processId("p-1"),
			programId: programId("counter"),
			label: "Counter",
			parentId: null,
		},
		{
			_tag: "Process",
			processId: processId("p-2"),
			programId: programId("counter"),
			label: "Counter",
			parentId: processId("p-1"),
		},
	],
};

describe("picker frame", () => {
	it("is a named listbox of two named groups", () => {
		const frame = pickerFrame(window, entries, mountPicker());
		expect(frame.role).toBe("listbox");
		expect(frame.label).toBe("Open a program or attach a running process");
		expect(frame.groups.map((group) => [group.role, group.label])).toEqual([
			["group", "Programs"],
			["group", "Running processes"],
		]);
	});

	it("names the active option by id, and marks exactly one option selected", () => {
		const frame = pickerFrame(window, entries, {cursor: 2, refusal: null});
		const options = frame.groups.flatMap((group) => group.options);
		expect(frame.activeDescendant).toBe("picker-window-1-option-2");
		expect(options.filter((option) => option.selected).map((option) => option.id)).toEqual([
			"picker-window-1-option-2",
		]);
		expect(options.map((option) => option.id)).toEqual([
			"picker-window-1-option-0",
			"picker-window-1-option-1",
			"picker-window-1-option-2",
			"picker-window-1-option-3",
		]);
	});

	it("carries the selection as a character too, never as colour alone", () => {
		const options = pickerFrame(window, entries, mountPicker()).groups.flatMap(
			(group) => group.options,
		);
		expect(options.map((option) => option.marker)).toEqual(["▸", " ", " ", " "]);
	});

	it("gives every option an accessible name carrying its id, label and lineage", () => {
		const [programs, processes] = pickerFrame(window, entries, mountPicker()).groups;
		expect(programs?.options.map((option) => option.name)).toEqual([
			"Counter — program counter",
			"pi — program pi",
		]);
		expect(processes?.options.map((option) => option.name)).toEqual([
			"Counter — process p-1, no parent",
			"Counter — process p-2, child of p-1",
		]);
	});

	it("announces the counts politely, and a refusal assertively", () => {
		expect(pickerFrame(window, entries, mountPicker()).announcement).toEqual({
			role: "status",
			live: "polite",
			text: "2 programs, 2 running processes.",
		});
		expect(
			pickerFrame(window, entries, withRefusal(mountPicker(), processGone("p-9"))).announcement,
		).toEqual({
			role: "alert",
			live: "assertive",
			text: 'Process "p-9" is no longer running.',
		});
	});

	it("says why an empty section is empty, and points at no active option at all", () => {
		const frame = pickerFrame(window, noEntries, mountPicker());
		expect(frame.activeDescendant).toBeNull();
		expect(frame.groups.map((group) => group.emptyMessage)).toEqual([
			"No registered program can fill a window.",
			"Nothing is running to attach to.",
		]);
		expect(frame.announcement.text).toBe("0 programs, 0 running processes.");
	});

	it("renders dark, still by default, and names colour by role token only", () => {
		const still = pickerFrame(window, entries, mountPicker());
		const moving = pickerFrame(window, entries, mountPicker(), {reducedMotion: false});
		expect(still.theme.scheme).toBe("dark");
		expect(still.theme.motion).toBe("none");
		expect(pickerFrame(window, entries, mountPicker(), {reducedMotion: true}).theme.motion).toBe(
			"none",
		);
		expect(moving.theme.motion).toBe("standard");
		expect(Object.values(still.theme.tokens).every((token) => token.startsWith("--"))).toBe(true);
		expect(Object.values(still.theme.tokens)).not.toContain("--gray-2");
	});

	it("publishes the keys it answers to, so the surface never invents its own help", () => {
		expect(pickerFrame(window, entries, mountPicker()).keyHelp.map((row) => row.action)).toEqual([
			"Move between rows",
			"Jump to the first or last row",
			"Open or attach the highlighted row",
			"Dismiss the message",
		]);
	});
});
