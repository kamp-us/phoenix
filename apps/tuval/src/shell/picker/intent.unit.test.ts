import {Result} from "effect";
import {describe, expect, it} from "vitest";
import {CommandName} from "../keys/table.ts";
import {windowId} from "./fixtures.ts";
import {
	ATTACH_COMMAND,
	OPEN_COMMAND,
	pickerCommandFor,
	pickerCommands,
	resolveCommandLine,
} from "./intent.ts";

const window = windowId("window-1");

/** The `UnreadableCommand` reason, or the tag that arrived instead — never a silent `undefined`. */
const reasonOf = (answer: ReturnType<typeof resolveCommandLine>): string =>
	Result.isFailure(answer) && answer.failure._tag === "UnreadableCommand"
		? answer.failure.reason
		: `unexpected: ${Result.isFailure(answer) ? answer.failure._tag : "success"}`;

describe("picker command rows", () => {
	it("declares one row per intent, each naming the argument a completion surface offers", () => {
		expect(pickerCommands.map((command) => [command.name, command.argument])).toEqual([
			["window:open", "program-id"],
			["window:attach", "process-id"],
		]);
	});

	it("resolves both rows by name, and nothing else", () => {
		expect(pickerCommandFor(OPEN_COMMAND)?.argument).toBe("program-id");
		expect(pickerCommandFor(ATTACH_COMMAND)?.argument).toBe("process-id");
		expect(pickerCommandFor(CommandName.make("window:close"))).toBeUndefined();
	});
});

describe("the command line behind prefix :", () => {
	it("`open <program>` and `attach <process>` resolve to the two intents", () => {
		expect(resolveCommandLine(window, "open counter")).toEqual(
			Result.succeed({_tag: "OpenProgram", windowId: window, programId: "counter"}),
		);
		expect(resolveCommandLine(window, "attach p-1")).toEqual(
			Result.succeed({_tag: "AttachProcess", windowId: window, processId: "p-1"}),
		);
	});

	it("reads the full row name too, and trims what the prompt left around it", () => {
		expect(resolveCommandLine(window, "  window:open   counter  ")).toEqual(
			Result.succeed({_tag: "OpenProgram", windowId: window, programId: "counter"}),
		);
	});

	it("refuses an unknown verb, a missing argument and an argument holding whitespace", () => {
		const unknown = resolveCommandLine(window, "launch counter");
		const missing = resolveCommandLine(window, "open");
		const spaced = resolveCommandLine(window, "attach p 1");
		expect([unknown, missing, spaced].map(Result.isFailure)).toEqual([true, true, true]);
		expect(Result.isFailure(unknown) ? unknown.failure._tag : null).toBe("UnreadableCommand");
		expect(reasonOf(missing)).toBe('"open" takes one program-id');
		expect(reasonOf(spaced)).toBe("a process-id holds no whitespace");
	});
});
