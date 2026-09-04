/**
 * Every Msg the shell core takes, driven through the reducer with no runtime: the cells are pure,
 * so a test is a state in, a state and a Cmd list out.
 */

import {describe, expect, it} from "vitest";
import {defaultPrefixTable, type Key} from "../keys/index.ts";
import {findWindow, windows} from "../layout/index.ts";
import {applyMsg, cellsFor, initialState, type ShellCmd, type ShellMsg} from "./machine.ts";
import {activeWorkspace, type ShellState, windowIds} from "./state.ts";

const table = defaultPrefixTable;

const apply = (state: ShellState, msg: ShellMsg): readonly [ShellState, readonly ShellCmd[]] =>
	applyMsg(table, state, msg);

/** Fold a run of Msgs, keeping only the last Cmd list — what a caller drives the shell with. */
const fold = (state: ShellState, ...msgs: readonly ShellMsg[]): ShellState =>
	msgs.reduce((acc, msg) => apply(acc, msg)[0], state);

const active = (state: ShellState) => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) throw new Error("test setup: no active workspace");
	return workspace;
};

const focusedProcess = (state: ShellState): string | null => {
	const workspace = active(state);
	return findWindow(workspace.layout, workspace.focused)?.processId ?? null;
};

const press = (key: string, modifiers: Partial<Key> = {}): ShellMsg => ({
	type: "keys.press",
	key: {key, ...modifiers},
});

const prefix = press("b", {ctrlKey: true});

describe("shell core: the reducer's cells", () => {
	it("has one cell per Msg, and the list is exactly the shell's vocabulary", () => {
		expect(Object.keys(cellsFor(table)).sort()).toEqual([
			"keys.press",
			"prefix.timeout",
			"window.bind",
			"window.close",
			"window.focus",
			"window.focusDirection",
			"window.setView",
			"window.split",
			"window.unbind",
			"workspace.activate",
			"workspace.create",
			"workspace.remove",
		]);
	});

	it("starts on one workspace holding one empty focused window", () => {
		const state = initialState();
		const workspace = active(state);
		expect(windowIds(workspace)).toEqual([workspace.focused]);
		expect(focusedProcess(state)).toBeNull();
		expect(state.order).toEqual([state.activeWorkspace]);
		expect(state.prefix).toEqual({armed: false});
	});
});

describe("shell core: windows", () => {
	it("window.split gives the focused window a new empty neighbour and focuses it", () => {
		const before = initialState();
		const first = active(before).focused;
		const [after, cmds] = apply(before, {type: "window.split", orientation: "horizontal"});

		const workspace = active(after);
		expect(windowIds(workspace)).toHaveLength(2);
		expect(workspace.focused).not.toBe(first);
		expect(focusedProcess(after)).toBeNull();
		expect(cmds).toEqual([]);
	});

	it("window.split leaves an unknown window alone and spends no id", () => {
		const before = initialState();
		const [after] = apply(before, {
			type: "window.split",
			orientation: "vertical",
			windowId: "window-does-not-exist",
		});
		expect(after).toEqual(before);
	});

	it("window.close on the last window of a process leaves the process running", () => {
		const two = fold(
			initialState(),
			{type: "window.split", orientation: "horizontal"},
			{type: "window.bind", processId: "process-chat"},
		);
		const [firstWindow, secondWindow] = windowIds(active(two));
		if (firstWindow === undefined || secondWindow === undefined) throw new Error("test setup");
		const both = fold(two, {type: "window.bind", processId: "process-chat", windowId: firstWindow});

		const [after, cmds] = apply(both, {type: "window.close", windowId: secondWindow});

		// The one Cmd arm that would end a process does not exist, so the list can only be empty here.
		expect(cmds).toEqual([]);
		expect(windowIds(active(after))).toEqual([firstWindow]);
		expect([...windows(active(after).layout.root)].map((window) => window.processId)).toEqual([
			"process-chat",
		]);
	});

	it("window.close moves focus to the next window and drops that window's view", () => {
		const two = fold(initialState(), {type: "window.split", orientation: "horizontal"});
		const [first, second] = windowIds(active(two));
		if (first === undefined || second === undefined) throw new Error("test setup");
		const viewed = fold(two, {type: "window.setView", view: {scroll: 12}});
		expect(viewed.views).toEqual({[second]: {scroll: 12}});

		const [after] = apply(viewed, {type: "window.close"});
		expect(active(after).focused).toBe(first);
		expect(after.views).toEqual({});
	});

	it("window.close refuses the last window of a workspace", () => {
		const before = initialState();
		const [after, cmds] = apply(before, {type: "window.close"});
		expect(after).toEqual(before);
		expect(cmds).toEqual([]);
	});

	it("window.focus takes a window the workspace holds and ignores one it does not", () => {
		const two = fold(initialState(), {type: "window.split", orientation: "horizontal"});
		const [first] = windowIds(active(two));
		if (first === undefined) throw new Error("test setup");

		expect(active(apply(two, {type: "window.focus", windowId: first})[0]).focused).toBe(first);
		expect(apply(two, {type: "window.focus", windowId: "window-nope"})[0]).toEqual(two);
	});

	it("window.focusDirection walks to the neighbour and stops at the edge", () => {
		const two = fold(initialState(), {type: "window.split", orientation: "horizontal"});
		const [first, second] = windowIds(active(two));
		if (first === undefined || second === undefined) throw new Error("test setup");

		const left = apply(two, {type: "window.focusDirection", direction: "left"})[0];
		expect(active(left).focused).toBe(first);
		expect(active(apply(left, {type: "window.focusDirection", direction: "left"})[0]).focused).toBe(
			first,
		);
		expect(
			active(apply(left, {type: "window.focusDirection", direction: "right"})[0]).focused,
		).toBe(second);
	});

	it("window.bind attaches a process and window.unbind detaches it, stopping nothing", () => {
		const bound = apply(initialState(), {type: "window.bind", processId: "process-pi"});
		expect(focusedProcess(bound[0])).toBe("process-pi");
		expect(bound[1]).toEqual([]);

		const [unbound, cmds] = apply(bound[0], {type: "window.unbind"});
		expect(focusedProcess(unbound)).toBeNull();
		expect(cmds).toEqual([]);
	});

	it("window.setView writes the focused window's slot and refuses an unknown window", () => {
		const state = initialState();
		const [viewed] = apply(state, {type: "window.setView", view: {scroll: 3, wrap: true}});
		expect(viewed.views[active(state).focused]).toEqual({scroll: 3, wrap: true});
		expect(apply(state, {type: "window.setView", view: null, windowId: "window-nope"})[0]).toEqual(
			state,
		);
	});
});

describe("shell core: workspaces", () => {
	it("workspace.create adds a desk with its own empty window and activates it", () => {
		const before = initialState();
		const [after] = apply(before, {type: "workspace.create"});

		expect(after.order).toHaveLength(2);
		expect(after.activeWorkspace).toBe(after.order[1]);
		expect(after.activeWorkspace).not.toBe(before.activeWorkspace);
		expect(windowIds(active(after))).toHaveLength(1);
	});

	it("workspace.activate takes a known id and ignores an unknown one", () => {
		const two = fold(initialState(), {type: "workspace.create"});
		const first = two.order[0];
		if (first === undefined) throw new Error("test setup");

		expect(apply(two, {type: "workspace.activate", workspaceId: first})[0].activeWorkspace).toBe(
			first,
		);
		expect(apply(two, {type: "workspace.activate", workspaceId: "workspace-nope"})[0]).toEqual(two);
	});

	it("workspace.remove activates the nearest workspace and drops that desk's views", () => {
		const three = fold(initialState(), {type: "workspace.create"}, {type: "workspace.create"});
		const [first, second, third] = three.order;
		if (first === undefined || second === undefined || third === undefined) {
			throw new Error("test setup");
		}
		const middle = fold(
			three,
			{type: "workspace.activate", workspaceId: second},
			{type: "window.setView", view: {scroll: 1}},
		);
		expect(Object.keys(middle.views)).toHaveLength(1);

		const [after] = apply(middle, {type: "workspace.remove"});
		expect(after.order).toEqual([first, third]);
		expect(after.activeWorkspace).toBe(third);
		expect(after.views).toEqual({});
	});

	it("workspace.remove falls back to the previous workspace when the last one goes", () => {
		const two = fold(initialState(), {type: "workspace.create"});
		const [first, second] = two.order;
		if (first === undefined || second === undefined) throw new Error("test setup");

		const [after] = apply(two, {type: "workspace.remove", workspaceId: second});
		expect(after.order).toEqual([first]);
		expect(after.activeWorkspace).toBe(first);
	});

	it("workspace.remove refuses the last workspace", () => {
		const before = initialState();
		const [after, cmds] = apply(before, {type: "workspace.remove"});
		expect(after).toEqual(before);
		expect(cmds).toEqual([]);
	});
});

describe("shell core: keys", () => {
	it("an unarmed press forwards exactly one key to the focused window's process", () => {
		const bound = fold(initialState(), {type: "window.bind", processId: "process-pi"});
		const [after, cmds] = apply(bound, press("j"));

		expect(cmds).toEqual([
			{
				type: "forwardKey",
				processId: "process-pi",
				windowId: active(bound).focused,
				key: "j",
			},
		]);
		expect(after.prefix).toEqual({armed: false});
	});

	it("an unarmed press over an empty window forwards nothing", () => {
		const [after, cmds] = apply(initialState(), press("j"));
		expect(cmds).toEqual([]);
		expect(after.prefix).toEqual({armed: false});
	});

	it("the prefix arms and asks the host for one timer", () => {
		const [after, cmds] = apply(initialState(), prefix);
		expect(after.prefix).toEqual({armed: true, pending: [], timeoutMs: 1000});
		expect(cmds).toEqual([{type: "startPrefixTimer", timeoutMs: 1000}]);
	});

	it("prefix.timeout disarms, and does nothing when the prefix is already down", () => {
		const armed = fold(initialState(), prefix);
		const [after, cmds] = apply(armed, {type: "prefix.timeout"});
		expect(after.prefix).toEqual({armed: false});
		expect(cmds).toEqual([]);
		expect(apply(after, {type: "prefix.timeout"})[0]).toEqual(after);
	});

	it("a bound sequence runs that command's Msg in the same transition", () => {
		const armed = fold(initialState(), prefix);
		const [after, cmds] = apply(armed, press("|"));

		// `|` is `window:split-vertical`, the divider tmux draws; the two windows sit side by side,
		// which this repo's layout vocabulary calls "horizontal".
		const direct = apply(armed, {type: "window.split", orientation: "horizontal"})[0];
		expect(after.workspaces).toEqual(direct.workspaces);
		expect(after.nextId).toBe(direct.nextId);
		expect(after.prefix).toEqual({armed: false});
		expect(cmds).toEqual([{type: "cancelPrefixTimer"}]);
	});

	it("a repeatable command re-arms the prefix on the repeat timeout", () => {
		const two = fold(initialState(), {type: "workspace.create"});
		const armed = fold(two, prefix);
		const [after, cmds] = apply(armed, press("l", {ctrlKey: true}));

		expect(after.activeWorkspace).toBe(two.order[0]);
		expect(after.prefix).toEqual({armed: true, pending: [], timeoutMs: 500});
		expect(cmds).toEqual([{type: "startPrefixTimer", timeoutMs: 500}]);
	});

	it("a command this core does not own leaves as a runCommand Cmd", () => {
		const armed = fold(initialState(), prefix);
		const [after, cmds] = apply(armed, press("r"));

		expect(after.workspaces).toEqual(armed.workspaces);
		expect(cmds).toEqual([
			{type: "cancelPrefixTimer"},
			{type: "runCommand", name: "config:reload"},
		]);
	});

	it("an unbound sequence disarms and forwards nothing", () => {
		const bound = fold(initialState(), {type: "window.bind", processId: "process-pi"}, prefix);
		const [after, cmds] = apply(bound, press("z"));

		expect(after.prefix).toEqual({armed: false});
		expect(cmds).toEqual([{type: "cancelPrefixTimer"}]);
	});

	it("a partial sequence keeps the prefix armed with what has been typed", () => {
		const armed = fold(initialState(), prefix);
		const [after, cmds] = apply(armed, press("Control"));
		expect(after.prefix).toEqual({armed: true, pending: [], timeoutMs: 1000});
		expect(cmds).toEqual([{type: "startPrefixTimer", timeoutMs: 1000}]);
	});
});

describe("shell core: the state is a checkpoint", () => {
	it("round-trips through JSON byte-equal after a run of every Msg", () => {
		const state = fold(
			initialState(),
			{type: "window.split", orientation: "horizontal"},
			{type: "window.split", orientation: "vertical"},
			{type: "window.bind", processId: "process-pi"},
			{type: "window.setView", view: {scroll: 40, marks: ["a", "b"]}},
			{type: "window.focusDirection", direction: "left"},
			{type: "window.unbind"},
			{type: "workspace.create"},
			{type: "window.bind", processId: "process-claude"},
			{type: "workspace.remove"},
			prefix,
			press("|"),
			{type: "prefix.timeout"},
			{type: "window.close"},
		);

		const once = JSON.stringify(state);
		expect(JSON.stringify(JSON.parse(once) as ShellState)).toBe(once);
		expect(JSON.parse(once)).toEqual(state);
	});

	it("keeps minting where a restored desk left off", () => {
		const state = fold(initialState(), {type: "window.split", orientation: "horizontal"});
		const restored = JSON.parse(JSON.stringify(state)) as ShellState;
		const [after] = apply(restored, {type: "window.split", orientation: "horizontal"});

		expect(new Set(windowIds(active(after))).size).toBe(3);
		expect(after.nextId).toBe(state.nextId + 1);
	});
});
