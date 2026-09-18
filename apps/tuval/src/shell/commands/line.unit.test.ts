/**
 * The command line, read end to end: a typed string in, one core Msg or one typed refusal out.
 * The last block drives the Msg on through the core, because "the line and the picker end in one
 * handler" is only true if the Msg the line produces is the Msg whose cell emits the picker's Cmd.
 */

import {describe, expect, it} from "vitest";
import {applyMsg, initialState, type ShellCmd} from "../core/machine.ts";
import {activeWorkspace} from "../core/state.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import type {CommandRefusal} from "./errors.ts";
import {refusalMessage} from "./errors.ts";
import {readCommandLine} from "./line.ts";
import {commandIndexFor} from "./table.ts";

/** The refusal a line was refused with. A line that read is a test-setup error, not a skip. */
const refusalOf = (line: string): CommandRefusal => {
	const read = readCommandLine(line);
	if (read._tag !== "Refused") throw new Error(`test setup: "${line}" was not refused`);
	return read.refusal;
};

describe("reading a command line", () => {
	it("decodes the epic's two worked lines to their Msgs", () => {
		expect(readCommandLine("workspace:activate ws-2")).toEqual({
			_tag: "Msg",
			command: expect.objectContaining({path: ["workspace", "activate"]}),
			msg: {type: "workspace.activate", workspaceId: "ws-2"},
		});
		expect(readCommandLine("window:open counter")).toEqual({
			_tag: "Msg",
			command: expect.objectContaining({path: ["window", "open"]}),
			msg: {type: "window.open", programId: "counter"},
		});
	});

	it("reads a bare verb as the window row of that name, which is what `prefix :` types", () => {
		const open = readCommandLine("open counter");
		const attach = readCommandLine("attach p-1");
		expect(open._tag === "Msg" ? open.msg : null).toEqual({
			type: "window.open",
			programId: "counter",
		});
		expect(attach._tag === "Msg" ? attach.msg : null).toEqual({
			type: "window.attach",
			processId: "p-1",
		});
	});

	it("lexes with the framework's own tokenizer: quotes group and whitespace around is ignored", () => {
		const quoted = readCommandLine('  workspace:activate  "my desk"  ');
		expect(quoted._tag === "Msg" ? quoted.msg : null).toEqual({
			type: "workspace.activate",
			workspaceId: "my desk",
		});
	});

	it("drives a no-argument row from its name alone", () => {
		const closed = readCommandLine("window:close");
		expect(closed._tag === "Msg" ? closed.msg : null).toEqual({type: "window.close"});
	});
});

describe("refusing a command line", () => {
	it("refuses an unknown name, naming the verb and pointing at it", () => {
		expect(refusalOf("launch counter")).toEqual({
			_tag: "UnknownCommand",
			verb: "launch",
			position: 0,
		});
	});

	it("offers the one near name a typo could have meant", () => {
		expect(refusalOf("windo:close")).toEqual({
			_tag: "UnknownCommand",
			verb: "windo:close",
			position: 0,
			didYouMean: "window:close",
		});
	});

	it("refuses a missing argument, naming the row and the parameter", () => {
		expect(refusalOf("workspace:activate")).toEqual({
			_tag: "MissingArgument",
			command: "workspace:activate",
			parameter: "workspace",
			position: "workspace:activate".length,
		});
	});

	it("refuses a wrong parameter, naming the row, the parameter and what was expected", () => {
		const refusal = refusalOf('workspace:activate ""');
		expect(refusal._tag).toBe("BadArgument");
		expect(refusal).toEqual({
			_tag: "BadArgument",
			command: "workspace:activate",
			parameter: "workspace",
			expected: "Expected a value with a length of at least 1",
			position: 19,
		});
	});

	it("refuses a token past the row's last parameter", () => {
		expect(refusalOf("window:close now")).toEqual({
			_tag: "TooManyArguments",
			command: "window:close",
			parameters: 0,
			position: 13,
		});
	});

	it("refuses a line holding nothing", () => {
		expect(refusalOf("   ")).toEqual({_tag: "EmptyCommandLine", position: 3});
	});

	it("says each refusal in one sentence a surface can show unchanged", () => {
		expect(refusalMessage(refusalOf("launch counter"))).toBe('No command row is named "launch".');
		expect(refusalMessage(refusalOf("windo:close"))).toBe(
			'No command row is named "windo:close". Did you mean "window:close"?',
		);
		expect(refusalMessage(refusalOf("workspace:activate"))).toBe(
			'"workspace:activate" needs a workspace.',
		);
		expect(refusalMessage(refusalOf("window:close now"))).toBe(
			'"window:close" takes no arguments.',
		);
	});
});

describe("the Msg a line produces, run through the core", () => {
	const table = defaultPrefixTable;

	const cmdsOf = (line: string): ReadonlyArray<ShellCmd> => {
		const read = readCommandLine(line);
		if (read._tag !== "Msg") throw new Error(`test setup: "${line}" was refused`);
		return applyMsg(table, initialState(), read.msg)[1];
	};

	const focusedWindow = (): string => {
		const workspace = activeWorkspace(initialState());
		if (workspace === undefined) throw new Error("test setup: no active workspace");
		return workspace.focused;
	};

	it("`open <program>` reaches the picker's spawn Cmd, aimed at the focused window", () => {
		expect(cmdsOf("open counter")).toEqual([
			{type: "openProgram", windowId: focusedWindow(), programId: "counter"},
		]);
	});

	it("`attach <process>` reaches the picker's bind Cmd, spawning nothing", () => {
		expect(cmdsOf("attach p-1")).toEqual([
			{type: "attachProcess", windowId: focusedWindow(), processId: "p-1"},
		]);
	});

	it("`config:reload` reaches the reload Cmd rather than looping through runCommand", () => {
		expect(cmdsOf("config:reload")).toEqual([{type: "reloadConfig"}]);
		expect(cmdsOf("command:open")).toEqual([{type: "openCommandLine"}]);
	});

	it("a window row that only moves the desk asks the host for nothing", () => {
		expect(cmdsOf("window:split-vertical")).toEqual([]);
		expect(cmdsOf("workspace:create")).toEqual([]);
	});
});

/**
 * `process:remove <id>` off the command line (#9447). The line is the route that names a process the
 * picker's cursor is not on, and the gate is the same one the table applies: with the flag off the
 * verb reads as a verb nobody wrote.
 */
describe("reading process:remove", () => {
	const commands = commandIndexFor({processBoard: false, processRemove: true});

	it("decodes the typed line to the removal Msg", () => {
		const read = readCommandLine("process:remove p-1", {commands});
		expect(read).toEqual({
			_tag: "Msg",
			command: expect.objectContaining({path: ["process", "remove"]}),
			msg: {type: "process.remove", processId: "p-1"},
		});
	});

	it("emits the one Cmd that removal needs, over the focused window and its slot", () => {
		const read = readCommandLine("process:remove p-1", {commands});
		if (read._tag !== "Msg") throw new Error("test setup: the line was refused");
		const state = initialState();
		const workspace = activeWorkspace(state);
		if (workspace === undefined) throw new Error("test setup: no active workspace");
		const [, cmds] = applyMsg(defaultPrefixTable, state, read.msg);
		expect(cmds).toEqual([
			{
				type: "removeProcess",
				windowId: workspace.focused,
				processId: "p-1",
			} satisfies ShellCmd,
		]);
	});

	it("refuses a line with no id rather than removing something unnamed", () => {
		const read = readCommandLine("process:remove", {commands});
		expect(read._tag).toBe("Refused");
	});

	it("is unreadable with the flag off, the way any unwritten verb is", () => {
		expect(readCommandLine("process:remove p-1")._tag).toBe("Refused");
	});

	it("leaves `remove` ambiguous rather than guessing between the workspace and the process", () => {
		// `workspace:remove` and `process:remove` both claim the bare segment, and neither is a window
		// row, so the table resolves it to neither — the same rule that keeps `open` unguessable.
		expect(commands.resolveVerb("remove")).toBeUndefined();
	});
});
