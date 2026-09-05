/**
 * The pure half of the expanded tool row: what an input's shape says the call was, and the line
 * diff an edit renders. No DOM here — the recognition and the diff are decisions a test can make
 * without one, which is why they live outside the component.
 */

import {describe, expect, it} from "vitest";
import {
	boundToolResult,
	ItemId,
	type JsonValue,
	type ToolItem,
} from "../../ai-agent/ports/index.ts";
import {diffLines, omissionLine, toolDetail} from "./tool-detail.ts";

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

describe("diffLines", () => {
	it("keeps the unchanged surroundings and replaces the region between them", () => {
		expect(diffLines("a\nb\nc\nd", "a\nB\nC\nd")).toEqual([
			{kind: "same", text: "a"},
			{kind: "removed", text: "b"},
			{kind: "removed", text: "c"},
			{kind: "added", text: "B"},
			{kind: "added", text: "C"},
			{kind: "same", text: "d"},
		]);
	});

	it("marks nothing when the two texts are the same", () => {
		const rows = diffLines("a\nb", "a\nb");
		expect(rows.every((row) => row.kind === "same")).toBe(true);
		expect(rows.length).toBe(2);
	});

	it("reads a pure insertion as added lines and a pure deletion as removed ones", () => {
		expect(diffLines("a\nc", "a\nb\nc")).toEqual([
			{kind: "same", text: "a"},
			{kind: "added", text: "b"},
			{kind: "same", text: "c"},
		]);
		expect(diffLines("a\nb\nc", "a\nc")).toEqual([
			{kind: "same", text: "a"},
			{kind: "removed", text: "b"},
			{kind: "same", text: "c"},
		]);
	});

	it("does not invent a phantom line for a trailing newline", () => {
		expect(diffLines("a\nb\n", "a\nb")).toEqual([
			{kind: "same", text: "a"},
			{kind: "same", text: "b"},
		]);
	});

	it("never counts one line as both the common prefix and the common suffix", () => {
		// "a" is the whole of both texts' overlap. Counting it twice would emit it twice, which is
		// what a prefix scan and a suffix scan that do not bound each other do.
		expect(diffLines("a", "a\nb")).toEqual([
			{kind: "same", text: "a"},
			{kind: "added", text: "b"},
		]);
	});
});

describe("omissionLine", () => {
	it("says how much a bound cut, and says nothing when it cut nothing", () => {
		expect(omissionLine(0)).toBeNull();
		expect(omissionLine(4_096)).toBe("4096 bytes omitted from this result");
	});
});
