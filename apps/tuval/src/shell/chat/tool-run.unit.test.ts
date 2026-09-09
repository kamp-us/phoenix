/**
 * The run's sentence, with no DOM: bucketing, counting, and the join.
 *
 * The grammar is T3 Code's, so the cases below are the ones its own composer distinguishes — one
 * clause, two, three or more, and the distinct-file count an edit bucket carries.
 */

import {describe, expect, it} from "vitest";
import type {JsonValue, ToolItem, ToolStatus} from "../../ai-agent/ports/index.ts";
import {boundToolResult, ItemId} from "../../ai-agent/ports/index.ts";
import {runSentence, runStatus, runStatusWord} from "./tool-run.ts";

let next = 0;
const nextId = (): string => {
	next += 1;
	return `t${next}`;
};

const call = (input: JsonValue, status: ToolStatus = "ok"): ToolItem => ({
	kind: "tool",
	id: ItemId.make(nextId()),
	timestamp: 1,
	name: "whatever_the_backend_called_it",
	input,
	result: boundToolResult("done"),
	status,
});

const read = (path: string) => call({file_path: path});
const edit = (path: string) => call({path, old_string: "one", new_string: "two"});
const command = (line: string) => call({command: line});

describe("runSentence", () => {
	it("says one clause as it stands", () => {
		expect(runSentence([read("a.ts"), read("b.ts"), read("c.ts")])).toBe("Read 3 files");
		expect(runSentence([command("ls"), command("pwd")])).toBe("Ran 2 commands");
	});

	it("singularizes a bucket of one", () => {
		expect(runSentence([read("a.ts"), command("ls")])).toBe("Read 1 file and ran 1 command");
	});

	it("joins two clauses with `and`, lowercasing the second", () => {
		expect(runSentence([read("a.ts"), read("b.ts"), command("ls")])).toBe(
			"Read 2 files and ran 1 command",
		);
	});

	it("joins three or more with commas and a final `and`, lowercasing every clause after the first", () => {
		const line = runSentence([read("a.ts"), edit("b.ts"), command("ls"), call({pattern: "TODO"})]);
		expect(line).toBe("Read 1 file, changed 1 file, ran 1 command, and used 1 tool");
	});

	it("buckets in first-seen order, not in the order the clauses are declared", () => {
		expect(runSentence([command("ls"), read("a.ts")])).toBe("Ran 1 command and read 1 file");
	});

	// Three edits to one file changed one file, which is what a reader counts.
	it("counts distinct files for edits, and calls for everything else", () => {
		expect(runSentence([edit("a.ts"), edit("a.ts"), edit("a.ts")])).toBe("Changed 1 file");
		expect(runSentence([edit("a.ts"), edit("b.ts"), edit("a.ts")])).toBe("Changed 2 files");
		// A read is a call, not a file: the same file read twice is two reads.
		expect(runSentence([read("a.ts"), read("a.ts")])).toBe("Read 2 files");
	});

	it("falls into the generic clause for a shape it does not recognise, inventing no target", () => {
		const line = runSentence([call({pattern: "TODO", glob: "**/*.ts"}), call(null)]);
		expect(line).toBe("Used 2 tools");
		expect(line).not.toContain("TODO");
	});

	it("reads the action off the input shape, whatever the tool is called", () => {
		expect(runSentence([call({filePath: "a.ts"}), call({cmd: "pwd"})])).toBe(
			"Read 1 file and ran 1 command",
		);
	});
});

describe("runStatus", () => {
	it("carries a failure out of the run rather than hiding it behind the calls that worked", () => {
		expect(runStatus([read("a.ts"), call({file_path: "b.ts"}, "error")])).toBe("error");
		// A failure outranks a call still in flight, so a run never settles into `running` on one.
		expect(runStatus([call({file_path: "a.ts"}, "running"), call({cmd: "ls"}, "error")])).toBe(
			"error",
		);
	});

	it("is running while any call is, and ok only when every one of them settled", () => {
		expect(runStatus([read("a.ts"), call({file_path: "b.ts"}, "running")])).toBe("running");
		expect(runStatus([read("a.ts"), read("b.ts")])).toBe("ok");
	});
});

describe("runStatusWord", () => {
	it("names the two states that are not simply finished, and says nothing about the one that is", () => {
		expect(runStatusWord("error")).toBe("failed");
		expect(runStatusWord("running")).toBe("running");
		expect(runStatusWord("ok")).toBeNull();
	});
});
