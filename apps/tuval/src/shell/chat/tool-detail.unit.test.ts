/**
 * The pure half of the expanded tool row: what an input's shape says the call was, the line that
 * names the call in a run, and what it discloses under that line. No DOM here — the recognition and
 * the dedupe are decisions a test can make without one, which is why they live outside the
 * component.
 */

import {describe, expect, it} from "vitest";
import {
	boundToolResult,
	ItemId,
	type JsonValue,
	type ToolItem,
} from "../../ai-agent/ports/index.ts";
import {callDisclosure, callLabel, canExpandCall, omissionLine, toolDetail} from "./tool-detail.ts";

const call = (input: ToolItem["input"], name = "a_tool"): ToolItem => ({
	kind: "tool",
	id: ItemId.make("t1"),
	timestamp: 1,
	name,
	input,
	result: boundToolResult("done"),
	status: "ok",
});

describe("toolDetail", () => {
	it("reads an edit off the shape, whatever the backend called the tool", () => {
		const inputs: ReadonlyArray<JsonValue> = [
			{path: "a.ts", old_text: "one", new_text: "two"},
			{file_path: "a.ts", oldText: "one", newText: "two"},
			{filePath: "a.ts", old_string: "one", new_string: "two"},
			{file: "a.ts", old: "one", new: "two"},
		];
		for (const input of inputs) {
			const detail = toolDetail(call(input));
			expect(detail.kind).toBe("edit");
			expect(detail.kind === "edit" ? detail.path : null).toBe("a.ts");
			// The two texts reach `Diff` as they arrived: nothing here splits them into lines.
			expect(detail.kind === "edit" ? [detail.before, detail.after] : null).toEqual(["one", "two"]);
		}
	});

	it("reads a shell call off its command", () => {
		expect(toolDetail(call({command: "ls -la"}))).toEqual({kind: "shell", command: "ls -la"});
		expect(toolDetail(call({cmd: "pwd"}))).toEqual({kind: "shell", command: "pwd"});
	});

	it("prefers the edit reading when a call carries both", () => {
		const detail = toolDetail(call({path: "a.ts", old: "x", new: "y", command: "sed -i"}));
		expect(detail.kind).toBe("edit");
	});

	it("falls back to the pretty-printed input for anything else", () => {
		const detail = toolDetail(call({pattern: "TODO", glob: "**/*.ts"}));
		expect(detail).toEqual({
			kind: "generic",
			input: '{\n  "pattern": "TODO",\n  "glob": "**/*.ts"\n}',
		});
	});

	it("renders an input that is not a record at all, rather than refusing it", () => {
		expect(toolDetail(call(null))).toEqual({kind: "generic", input: "null"});
		expect(toolDetail(call("go"))).toEqual({kind: "generic", input: '"go"'});
		expect(toolDetail(call([1, 2]))).toEqual({kind: "generic", input: "[1,2]"});
	});

	it("is not an edit when only part of the triple is there", () => {
		expect(toolDetail(call({path: "a.ts", old: "one"})).kind).toBe("generic");
		expect(toolDetail(call({old: "one", new: "two"})).kind).toBe("generic");
		expect(toolDetail(call({path: "a.ts"})).kind).toBe("generic");
	});
});

describe("omissionLine", () => {
	it("says how much a bound cut, and says nothing when it cut nothing", () => {
		expect(omissionLine(0)).toBeNull();
		expect(omissionLine(4_096)).toBe("4096 bytes omitted from this result");
	});
});

const shellCall = (command: string, output = "done"): ToolItem => ({
	...call({command}, "Bash"),
	result: boundToolResult(output),
});

describe("callLabel", () => {
	it("names the tool and what it was pointed at", () => {
		expect(callLabel(call({path: "src/rows.ts"}, "Read"))).toBe("Read src/rows.ts");
		expect(callLabel(call({path: "a.ts", old: "x", new: "y"}, "Edit"))).toBe("Edit a.ts");
		expect(callLabel(shellCall("pnpm test"))).toBe("Bash pnpm test");
	});

	it("is the tool alone when the shape carries no argument", () => {
		expect(callLabel(call({pattern: "TODO"}, "Grep"))).toBe("Grep");
		expect(callLabel(call(null, "Task"))).toBe("Task");
	});

	it("takes one line of a command, so a script does not become a ten-line label", () => {
		expect(callLabel(shellCall("pnpm build\npnpm test"))).toBe("Bash pnpm build");
	});
});

describe("callDisclosure", () => {
	it("drops a command the visible label already shows", () => {
		const disclosure = callDisclosure(shellCall("pnpm test"), "Bash pnpm test");
		expect(disclosure.blocks).toEqual([{label: "output", text: "done"}]);
	});

	it("keeps that same command when the row on screen does not show it", () => {
		// The standalone `ToolRow`'s trigger is the tool's name alone, so nothing is repeated.
		expect(callDisclosure(shellCall("pnpm test"), "Bash").blocks).toEqual([
			{label: "command", text: "pnpm test"},
			{label: "output", text: "done"},
		]);
	});

	it("shows the raw command whenever it differs from the line on screen", () => {
		const item = shellCall("pnpm build\npnpm test");
		expect(callDisclosure(item, callLabel(item)).blocks).toEqual([
			{label: "command", text: "pnpm build\npnpm test"},
			{label: "output", text: "done"},
		]);
	});

	it("hands an edit's two texts over whole, and prints no input block beside them", () => {
		const item = call({path: "a.ts", old: "one", new: "two"}, "Edit");
		const disclosure = callDisclosure(item, callLabel(item));
		expect(disclosure.edit).toEqual({path: "a.ts", before: "one", after: "two"});
		expect(disclosure.blocks).toEqual([{label: "result", text: "done"}]);
	});

	it("carries the omission line when the per-item bound cut the result", () => {
		const item: ToolItem = {...call({path: "a.ts"}, "Read"), result: boundToolResult("abcdef", 2)};
		expect(callDisclosure(item, callLabel(item)).omitted).toBe("4 bytes omitted from this result");
	});

	it("drops an empty result rather than labelling an empty box", () => {
		expect(callDisclosure(shellCall("pnpm test", ""), "Bash pnpm test").blocks).toEqual([]);
	});
});

describe("canExpandCall", () => {
	it("refuses a call whose whole content is the line already on screen", () => {
		const item = shellCall("pnpm test", "");
		expect(canExpandCall(callDisclosure(item, callLabel(item)))).toBe(false);
	});

	it("admits one with an edit, and one with a block", () => {
		const edit = call({path: "a.ts", old: "one", new: "two"}, "Edit");
		expect(canExpandCall(callDisclosure(edit, callLabel(edit)))).toBe(true);
		expect(canExpandCall(callDisclosure(shellCall("pnpm test"), "Bash pnpm test"))).toBe(true);
	});
});
