/**
 * The inspector's facts, from fixture `Snapshot.processes` rows and nothing else. Pure, so no jsdom
 * and no host: the three arms and the field-by-field content are decidable here, and what the
 * component does with them is `./view.unit.test.tsx`'s.
 */

import {describe, expect, it} from "vitest";
import {ProcessId} from "../../protocol/ids.ts";
import {row, twoRootForest} from "../ps/fixtures.ts";
import {processDetail} from "./detail.ts";

const withPorts = row("child-a1", {
	parent: "root-a",
	program: "shell",
	revision: 3,
	lifecycle: "stopping",
	ports: {
		transcript: {kind: "tuval/transcript", direction: "out"},
		prompt: {kind: "tuval/prompt", direction: "in"},
		cancel: {kind: "tuval/cancel", direction: "in"},
	},
});

describe("process detail", () => {
	it("names every field of the selected process, ports sorted by name", () => {
		expect(processDetail([row("root-a"), withPorts], withPorts.id)).toEqual({
			_tag: "Facts",
			processId: ProcessId.make("child-a1"),
			programId: "shell",
			parentId: ProcessId.make("root-a"),
			ports: [
				{name: "cancel", kind: "tuval/cancel", direction: "in"},
				{name: "prompt", kind: "tuval/prompt", direction: "in"},
				{name: "transcript", kind: "tuval/transcript", direction: "out"},
			],
			lifecycle: "stopping",
			revision: 3,
		});
	});

	it("reads a root's absent parent as a fact, not as a missing value", () => {
		const detail = processDetail(twoRootForest, ProcessId.make("root-a"));
		expect(detail).toMatchObject({_tag: "Facts", parentId: null, ports: []});
	});

	it("answers the named empty state when nothing is selected", () => {
		expect(processDetail(twoRootForest, null)).toEqual({_tag: "NoSelection"});
	});

	it("answers a typed gone state for a selection that has left the table, and does not throw", () => {
		const gone = ProcessId.make("child-a1");
		const remaining = twoRootForest.filter((process) => process.id !== gone);
		expect(() => processDetail(remaining, gone)).not.toThrow();
		expect(processDetail(remaining, gone)).toEqual({_tag: "SelectionGone", processId: gone});
	});

	it("answers the same gone state over an empty table", () => {
		expect(processDetail([], ProcessId.make("root-a"))).toEqual({
			_tag: "SelectionGone",
			processId: ProcessId.make("root-a"),
		});
	});
});
