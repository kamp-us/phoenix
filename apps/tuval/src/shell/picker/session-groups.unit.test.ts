/**
 * The picker with four harnesses in ten open projects (#9694, ruling #9668 R6.3): forty session
 * entries, one group per project. What is ours to prove is that the groups survive a filter, that
 * the frame names each group by its project, that the keyboard can walk it group by group, and that
 * choosing an entry carries its project to the open.
 */

import {describe, expect, it} from "vitest";
import {groupKeyOf, type PickerEntries, programEntries} from "./entries.ts";
import {visibleEntries} from "./filter.ts";
import {programRow, windowId} from "./fixtures.ts";
import {pickerFrame} from "./frame.ts";
import {cursorOf, mountPicker, type PickerView, pickerKey, withFilter} from "./view.ts";

const window = windowId("window-1");
const HARNESSES = ["Claude", "Pi", "agy", "codex"];
const PROJECTS = Array.from({length: 10}, (_, index) => ({
	key: `key-${index}`,
	label: `project-${index}`,
}));

const entries: PickerEntries = {
	programs: programEntries(
		[
			...HARNESSES.map((label) =>
				programRow(`${label.toLowerCase()}-session`, {label, folderAtStart: true}),
			),
			programRow("counter", {label: "Counter"}),
		],
		PROJECTS,
	),
	processes: [],
};

const press = (view: PickerView, ...keys: ReadonlyArray<string>): PickerView => {
	let current = view;
	for (const key of keys) {
		const answer = pickerKey(window, entries, current, key);
		if (answer._tag === "Moved") current = answer.view;
	}
	return current;
};

describe("the picker over four harnesses in ten projects", () => {
	it("draws one group per project, named by it, then the other programs", () => {
		const frame = pickerFrame(window, entries, mountPicker());
		expect(frame.groups.map((group) => group.label)).toEqual([
			...PROJECTS.map((project) => `Sessions in ${project.label}`),
			"Programs",
			"Running processes",
		]);
		expect(frame.groups[0]?.options.map((option) => option.name)).toEqual([
			"Claude · project-0 — program claude-session",
			"Pi · project-0 — program pi-session",
			"agy · project-0 — program agy-session",
			"codex · project-0 — program codex-session",
		]);
		// Every option still indexes the one flattened list the cursor walks.
		const indices = frame.groups.flatMap((group) => group.options.map((option) => option.index));
		expect(indices).toEqual(Array.from({length: 41}, (_, index) => index));
	});

	it("names a home group when nothing is open", () => {
		const home: PickerEntries = {
			programs: programEntries([
				programRow("claude-session", {label: "Claude", folderAtStart: true}),
			]),
			processes: [],
		};
		expect(pickerFrame(window, home, mountPicker()).groups[0]?.label).toBe("Sessions in home");
	});

	it("keeps a filtered list grouped by project rather than interleaved by score", () => {
		const narrowed = visibleEntries(entries, "claude");
		expect(narrowed.programs.map((entry) => entry.label)).toEqual(
			PROJECTS.map((project) => `Claude · ${project.label}`),
		);
		const byProject = visibleEntries(entries, "project-7");
		expect(new Set(byProject.programs.map(groupKeyOf))).toEqual(new Set(["place:key-7"]));
		expect(byProject.programs).toHaveLength(4);
	});

	it("walks project by project with Page Down and Page Up, and clamps at both ends", () => {
		expect(press(mountPicker(), "<pagedown>").cursor).toBe(4);
		expect(press(mountPicker(), "<pagedown>", "<pagedown>").cursor).toBe(8);
		// Mid-group, Page Up goes to the top of the group it is in first.
		expect(press(mountPicker(), "<pagedown>", "j", "<pageup>").cursor).toBe(4);
		expect(press(mountPicker(), "<pagedown>", "<pageup>").cursor).toBe(0);
		expect(press(mountPicker(), "<pageup>").cursor).toBe(0);
		// The last group is the other programs; there is nowhere further to go.
		expect(press(mountPicker(), "<end>", "<pagedown>").cursor).toBe(40);
	});

	it("walks the filtered list by the groups the filter left", () => {
		const filtered = withFilter(mountPicker(), "claude");
		expect(cursorOf(entries, press(filtered, "<pagedown>"))).toBe(1);
	});

	it("carries the chosen entry's project into the open", () => {
		const answer = pickerKey(window, entries, press(mountPicker(), "<pagedown>"), "<enter>");
		expect(answer).toEqual({
			_tag: "Chose",
			intent: {
				_tag: "OpenProgram",
				windowId: window,
				programId: "claude-session",
				place: {_tag: "Project", key: "key-1", label: "project-1"},
			},
		});
	});
});
