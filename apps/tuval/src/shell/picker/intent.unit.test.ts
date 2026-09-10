import {describe, expect, it} from "vitest";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import {CommandName} from "../keys/table.ts";
import {windowId} from "./fixtures.ts";
import {
	ATTACH_COMMAND,
	attachProcess,
	intentOf,
	OPEN_COMMAND,
	openProgram,
	pickerCommandFor,
	pickerCommands,
} from "./intent.ts";

const window = windowId("window-1");

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

	it("each row turns its argument into the intent that row names", () => {
		expect(pickerCommandFor(OPEN_COMMAND)?.toIntent(window, "counter")).toEqual(
			openProgram(window, ProgramId.make("counter")),
		);
		expect(pickerCommandFor(ATTACH_COMMAND)?.toIntent(window, "p-1")).toEqual(
			attachProcess(window, ProcessId.make("p-1")),
		);
	});
});

describe("a highlighted row's intent", () => {
	it("is the same value the matching command row produces", () => {
		const entry = {
			_tag: "Program",
			programId: ProgramId.make("counter"),
			label: "Counter",
		} as const;
		expect(intentOf(window, entry)).toEqual(
			pickerCommandFor(OPEN_COMMAND)?.toIntent(window, "counter"),
		);
	});
});
