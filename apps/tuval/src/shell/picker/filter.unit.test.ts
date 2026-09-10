/**
 * What the filter narrows, and what it refuses to read. The matcher itself is fzf's and is not
 * re-proved here — these are the two claims that are ours: both sections narrow, and only the row's
 * own label is ever matched against (#8450).
 */

import {describe, expect, it} from "vitest";
import type {PickerEntries} from "./entries.ts";
import {programEntries} from "./entries.ts";
import {visibleEntries} from "./filter.ts";
import {processId, programId, programRow} from "./fixtures.ts";

const entries: PickerEntries = {
	programs: programEntries([
		programRow("counter", {label: "Counter"}),
		programRow("claude", {label: "Claude"}),
		programRow("pi", {label: "Pi"}),
	]),
	processes: [
		{
			_tag: "Process",
			processId: processId("dead-beef-counter"),
			programId: programId("counter"),
			label: "Counter",
			parentId: null,
		},
		{
			_tag: "Process",
			processId: processId("p-2"),
			programId: programId("pi"),
			label: "Pi",
			parentId: processId("claude-parent"),
		},
	],
};

const labels = (narrowed: PickerEntries) => ({
	programs: narrowed.programs.map((entry) => entry.label),
	processes: narrowed.processes.map((entry) => entry.label),
});

describe("the picker's filter", () => {
	it("narrows the programs and the processes together, not one of them", () => {
		expect(labels(visibleEntries(entries, "pi"))).toEqual({programs: ["Pi"], processes: ["Pi"]});
	});

	it("matches a subsequence with gaps, smart-cased — which is what fzf answers", () => {
		expect(labels(visibleEntries(entries, "cur")).programs).toEqual(["Counter"]);
		// Smart case is fzf's default (`BaseOptions.casing`): an all-lowercase query ignores case, and
		// typing a capital is the operator asking for one.
		expect(labels(visibleEntries(entries, "cld")).programs).toEqual(["Claude"]);
		expect(labels(visibleEntries(entries, "CLD")).programs).toEqual([]);
	});

	it("reads the row's own label and never a program, process or parent id", () => {
		// "beef" appears only inside the process id, "claude-parent" only inside a parent id, and
		// "counter" as a program id — the labels above carry none of those spellings.
		expect(labels(visibleEntries(entries, "beef"))).toEqual({programs: [], processes: []});
		expect(labels(visibleEntries(entries, "parent"))).toEqual({programs: [], processes: []});
	});

	it("leaves a closed or empty filter the whole list, in its own order", () => {
		expect(visibleEntries(entries, null)).toBe(entries);
		expect(visibleEntries(entries, "")).toBe(entries);
	});

	it("answers a query nothing matches with two empty sections rather than the whole list", () => {
		expect(labels(visibleEntries(entries, "zzz"))).toEqual({programs: [], processes: []});
	});
});
