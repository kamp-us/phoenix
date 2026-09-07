/**
 * Every row, driven to the Msg it names. A row is pure data, so a test is a parameter object in and
 * one core Msg out — no runtime, no layer, no double.
 */

import {describe, expect, it} from "vitest";
import type {ShellMsg} from "../core/machine.ts";
import {CommandName, FOCUS_LIST_KEY} from "../keys/index.ts";
import {pickerCommands} from "../picker/intent.ts";
import {commandName, isOptionalParameter, parameterNames} from "./row.ts";
import {commandFor, commandNames, msgForCommandName, resolveVerb, shellCommands} from "./table.ts";

/** Drive a row by name. Every row this file names exists, so an absent one is a failure, not a skip. */
const msgOf = (name: string, params: Record<string, string> = {}): ShellMsg => {
	const command = commandFor(name);
	if (command === undefined) throw new Error(`test setup: no row is named "${name}"`);
	return command.toMsg(params);
};

describe("the command table", () => {
	it("holds every name the epic lists, once each", () => {
		expect(commandNames.map(String)).toEqual([
			"window:split-vertical",
			"window:split-horizontal",
			"window:zoom",
			"window:close",
			"window:focus-left",
			"window:focus-right",
			"window:focus-up",
			"window:focus-down",
			"window:focus",
			"window:pick",
			"window:focus-list",
			"window:open",
			"window:attach",
			"workspace:create",
			"workspace:remove",
			"workspace:activate",
			"workspace:previous",
			"workspace:next",
			"desk:inspector-toggle",
			"command:open",
			"config:reload",
		]);
		expect(new Set(commandNames.map(String)).size).toBe(commandNames.length);
	});

	it("gives the focus-list row a key to mint, since no command name can address a renderer", () => {
		expect(msgOf("window:focus-list")).toEqual({
			type: "window.forwardKey",
			key: FOCUS_LIST_KEY,
		});
		// A bound key sequence has nowhere to carry an argument, so the chord's row must take none.
		expect(msgForCommandName(CommandName.make("window:focus-list"))).toEqual({
			type: "window.forwardKey",
			key: FOCUS_LIST_KEY,
		});
	});

	it("names every row from its own path, and every row carries a sentence", () => {
		for (const command of shellCommands) {
			expect(String(commandName(command.path))).toBe(command.path.join(":"));
			expect(command.describe.endsWith(".")).toBe(true);
		}
	});

	it("takes the two picker rows' names, sentences and arguments from the picker's own list", () => {
		expect(pickerCommands.map((command) => String(command.name))).toEqual([
			"window:open",
			"window:attach",
		]);
		for (const picker of pickerCommands) {
			const row = commandFor(picker.name);
			expect(row?.describe).toBe(picker.summary);
			const required =
				row === undefined
					? []
					: parameterNames(row).filter((name) => !isOptionalParameter(row, name));
			expect(required).toEqual([picker.argument === "program-id" ? "program" : "process"]);
		}
	});

	it("lets `window:open` name a session, and never requires one (epic #8070)", () => {
		const row = commandFor("window:open");
		expect(row === undefined ? [] : parameterNames(row)).toEqual(["program", "session", "cwd"]);
		expect(
			row === undefined ? [] : ["session", "cwd"].map((name) => isOptionalParameter(row, name)),
		).toEqual([true, true]);
	});
});

describe("each row's Msg", () => {
	it("splits name the divider the key draws, not the arrangement it produces", () => {
		expect(msgOf("window:split-vertical")).toEqual({
			type: "window.split",
			orientation: "horizontal",
		});
		expect(msgOf("window:split-horizontal")).toEqual({
			type: "window.split",
			orientation: "vertical",
		});
	});

	it("closes and focuses through the core's own window Msgs", () => {
		expect(msgOf("window:close")).toEqual({type: "window.close"});
		expect(msgOf("window:focus-left")).toEqual({type: "window.focusDirection", direction: "left"});
		expect(msgOf("window:focus-right")).toEqual({
			type: "window.focusDirection",
			direction: "right",
		});
		expect(msgOf("window:focus-up")).toEqual({type: "window.focusDirection", direction: "up"});
		expect(msgOf("window:focus-down")).toEqual({type: "window.focusDirection", direction: "down"});
	});

	it("focuses a window the caller names by id — the pointer's row, typeable and spell-visible", () => {
		expect(msgOf("window:focus", {window: "window-2"})).toEqual({
			type: "window.focus",
			windowId: "window-2",
		});
		// A row with an argument cannot ride a key sequence, so the core leaves the name for a
		// surface to open the command line over.
		expect(msgForCommandName(commandName(["window", "focus"]))).toBeNull();
	});

	it("opens and attaches by naming the thing to show, leaving the spawn to the Cmd", () => {
		expect(msgOf("window:open", {program: "counter"})).toEqual({
			type: "window.open",
			programId: "counter",
		});
		expect(msgOf("window:attach", {process: "p-1"})).toEqual({
			type: "window.attach",
			processId: "p-1",
		});
	});

	it("drives every workspace row, the two walking ones as one stepping Msg", () => {
		expect(msgOf("workspace:create")).toEqual({type: "workspace.create"});
		expect(msgOf("workspace:remove")).toEqual({type: "workspace.remove"});
		expect(msgOf("workspace:activate", {workspace: "ws-2"})).toEqual({
			type: "workspace.activate",
			workspaceId: "ws-2",
		});
		expect(msgOf("workspace:previous")).toEqual({type: "workspace.step", direction: "previous"});
		expect(msgOf("workspace:next")).toEqual({type: "workspace.step", direction: "next"});
	});

	it("carries the two surface rows as Msgs of their own", () => {
		expect(msgOf("command:open")).toEqual({type: "command.open"});
		expect(msgOf("config:reload")).toEqual({type: "config.reload"});
	});

	it("reaches the desk inspector from one row, argument-free so a key can run it", () => {
		expect(msgOf("desk:inspector-toggle")).toEqual({type: "desk.inspector.toggle"});
		expect(msgForCommandName(commandName(["desk", "inspector-toggle"]))).toEqual({
			type: "desk.inspector.toggle",
		});
	});
});

describe("resolving a name", () => {
	it("reads the full name, the window row of a bare verb, and an unambiguous last segment", () => {
		expect(resolveVerb("window:close")?.path).toEqual(["window", "close"]);
		expect(resolveVerb("open")?.path).toEqual(["window", "open"]);
		expect(resolveVerb("attach")?.path).toEqual(["window", "attach"]);
		expect(resolveVerb("reload")?.path).toEqual(["config", "reload"]);
		expect(resolveVerb("create")?.path).toEqual(["workspace", "create"]);
		expect(resolveVerb("focus")?.path).toEqual(["window", "focus"]);
	});

	it("resolves nothing for a name no row carries", () => {
		expect(resolveVerb("launch")).toBeUndefined();
		expect(commandFor("window:launch")).toBeUndefined();
	});
});

describe("the Msg a bound key runs", () => {
	it("is the row's own, for every row that takes no argument", () => {
		for (const command of shellCommands) {
			const name = commandName(command.path);
			const expected = parameterNames(command).length === 0 ? command.toMsg({}) : null;
			expect(msgForCommandName(name)).toEqual(expected);
		}
	});

	it("is nothing for a row needing an argument a key sequence cannot carry", () => {
		expect(msgForCommandName(commandName(["window", "open"]))).toBeNull();
		expect(msgForCommandName(commandName(["workspace", "activate"]))).toBeNull();
	});
});
