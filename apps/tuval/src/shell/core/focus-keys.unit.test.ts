/**
 * A config key binding fires through the path a key press takes in a running desk (#9687): the page
 * sends `keys.press`, the shell core routes it over the table its focus selects, and a binding the
 * focus's owner holds leaves as `runBinding` for the host to run. Driven through the reducer, beside
 * a live bindings source the test replaces the way a project open and close replace it.
 */

import type {Binding} from "@kampus/tuval-sdk/kernel/commands/bindings/compile";
import {defaultPrefixTable, type Key, prefixTableFor} from "@kampus/tuval-ui/keys";
import {describe, expect, it} from "vitest";
import {noOwnerBindings, type OwnerBindings} from "../../keys/scopes.ts";
import {ProjectId} from "../../project-id.ts";
import {commandIndexFor} from "../commands/index.ts";
import {findWindow, windows} from "../layout/index.ts";
import {
	applyMsg,
	initialState,
	type KeyBindingsSource,
	type ShellCmd,
	type ShellMsg,
} from "./index.ts";
import {activeWorkspace, type ShellState} from "./state.ts";

/** The board's chord is flag-gated; a desk with the board on is the one that has it to reserve. */
const table = prefixTableFor(defaultPrefixTable, {processBoard: true});
const commands = commandIndexFor({processBoard: true, processRemove: false});
const step = (state: ShellState, msg: ShellMsg, keys: KeyBindingsSource) =>
	applyMsg(table, state, msg, {commands, keys});
const alpha = ProjectId.of("/work/alpha");
const beta = ProjectId.of("/work/beta");

const bound = (key: string, ...path: [string, ...Array<string>]): Binding => ({
	key,
	path,
	args: {},
});

const alphaClose = bound("<c-g>", "window", "close");
const alphaChord = bound("<c-b>z", "spell", "list");
/** Would take the desk's reserved close chord; the load refuses it, and routing never reads it. */
const alphaReserved = bound("<c-b>x", "spell", "list");
const betaNext = bound("<c-g>", "workspace", "next");
const globalHelp = bound("<c-y>", "help");

const everyOwner: OwnerBindings = {
	global: [globalHelp],
	projects: new Map([
		[alpha.key, [alphaClose, alphaChord, alphaReserved]],
		[beta.key, [betaNext]],
	]),
};

/** A bindings source a test swaps, as `LiveKeyBindings` is swapped by a project open or close. */
const liveSource = (initial: OwnerBindings) => {
	let current = initial;
	const source: KeyBindingsSource = {current: () => current};
	return {source, replace: (next: OwnerBindings) => (current = next)};
};

const press = (key: string, modifiers: Partial<Key> = {}): ShellMsg => ({
	type: "keys.press",
	key: {key, ...modifiers},
	pressId: `press-${key}`,
});
const ctrl = (key: string) => press(key, {ctrlKey: true});
const prefix = ctrl("b");

const active = (state: ShellState) => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) throw new Error("test setup: no active workspace");
	return workspace;
};

/**
 * Three windows: an alpha program's, a beta program's, and a harness session's (a global row),
 * each bound the way the picker binds one. Focus ends on the harness window.
 */
const desk = (source: KeyBindingsSource): ShellState => {
	const apply = (state: ShellState, msg: ShellMsg) => step(state, msg, source)[0];
	let state = initialState();
	const programs = [alpha.scope("counter"), beta.scope("counter"), "claude"];
	for (const [index, program] of programs.entries()) {
		if (index > 0) state = apply(state, {type: "window.split", orientation: "horizontal"});
		state = apply(state, {
			type: "window.bind",
			processId: `process-${index}`,
			takesKeys: true,
			program,
		});
	}
	return state;
};

const windowOf = (state: ShellState, program: string) => {
	const found = [...windows(active(state).layout.root)].find(
		(window) => window.program === program,
	);
	if (found === undefined) throw new Error(`test setup: no window over ${program}`);
	return found.id;
};

const focus = (state: ShellState, program: string, source: KeyBindingsSource): ShellState =>
	step(state, {type: "window.focus", windowId: windowOf(state, program)}, source)[0];

const pressAll = (
	state: ShellState,
	source: KeyBindingsSource,
	...msgs: ReadonlyArray<ShellMsg>
): readonly [ShellState, ReadonlyArray<ShellCmd>] => {
	let current = state;
	let cmds: ReadonlyArray<ShellCmd> = [];
	for (const msg of msgs) [current, cmds] = step(current, msg, source);
	return [current, cmds];
};

const fired = (cmds: ReadonlyArray<ShellCmd>): ReadonlyArray<Binding> =>
	cmds.flatMap((cmd) => (cmd.type === "runBinding" ? [cmd.binding] : []));

describe("keys follow focus through the shell core (#9687)", () => {
	const {source} = liveSource(everyOwner);
	const start = desk(source);

	it("records the bound program on the window the picker binds", () => {
		expect(findWindow(active(start).layout, windowOf(start, "claude"))?.program).toBe("claude");
	});

	it("fires a project's binding in that project's window, and tells the page it is consumed", () => {
		const onAlpha = focus(start, alpha.scope("counter"), source);
		const [after, cmds] = pressAll(onAlpha, source, ctrl("g"));
		expect(cmds).toEqual([
			{
				type: "runBinding",
				binding: alphaClose,
				workspace: onAlpha.activeWorkspace,
				windowId: active(onAlpha).focused,
			},
		]);
		expect(after.lastPress).toEqual({pressId: "press-g", outcome: {_tag: "Consumed"}});
	});

	it("fires the other project's own binding on the same key in its window", () => {
		const onBeta = focus(start, beta.scope("counter"), source);
		expect(fired(pressAll(onBeta, source, ctrl("g"))[1])).toEqual([betaNext]);
	});

	it("never fires a project's binding on the board: the key goes where it did before", () => {
		const onAlpha = focus(start, alpha.scope("counter"), source);
		const [board] = pressAll(onAlpha, source, {type: "desk.board.toggle"});
		const [after, cmds] = pressAll(board, source, ctrl("g"));
		expect(fired(cmds)).toEqual([]);
		expect(after.lastPress?.outcome).toEqual({_tag: "ToWindow", key: "<c-g>"});
	});

	it("gives the board the global config's bindings, with no window as the subject", () => {
		const [board] = pressAll(start, source, {type: "desk.board.toggle"});
		const [, cmds] = pressAll(board, source, ctrl("y"));
		expect(cmds).toEqual([
			{type: "runBinding", binding: globalHelp, workspace: board.activeWorkspace, windowId: null},
		]);
	});

	it("keeps a harness window on the global config's bindings, never a project's", () => {
		expect(fired(pressAll(start, source, ctrl("y"))[1])).toEqual([globalHelp]);
		const [after, cmds] = pressAll(start, source, ctrl("g"));
		expect(fired(cmds)).toEqual([]);
		expect(after.lastPress?.outcome).toEqual({_tag: "ToWindow", key: "<c-g>"});
	});

	it("keeps the global config's bare keys out of a project's window", () => {
		const onAlpha = focus(start, alpha.scope("counter"), source);
		expect(fired(pressAll(onAlpha, source, ctrl("y"))[1])).toEqual([]);
	});

	it("lets a project's chord shadow a shell chord in its own window only", () => {
		const onAlpha = focus(start, alpha.scope("counter"), source);
		const [, alphaCmds] = pressAll(onAlpha, source, prefix, press("z"));
		expect(fired(alphaCmds)).toEqual([alphaChord]);

		const onBeta = focus(start, beta.scope("counter"), source);
		const [zoomed, betaCmds] = pressAll(onBeta, source, prefix, press("z"));
		expect(fired(betaCmds)).toEqual([]);
		expect(active(zoomed).layout.zoomed).toBe(active(onBeta).focused);
	});

	it("runs every reserved desk key from the board and from every window", () => {
		const onAlpha = focus(start, alpha.scope("counter"), source);
		const [board] = pressAll(start, source, {type: "desk.board.toggle"});
		for (const state of [board, start, onAlpha, focus(start, beta.scope("counter"), source)]) {
			// `<c-b> w` puts the picker in the focused window, `<c-b> x` closes it: neither is a
			// binding's, even in alpha's window, whose config names `<c-b>x`.
			const [, pick] = pressAll(state, source, prefix, press("w"));
			expect(fired(pick)).toEqual([]);
			const [closed, close] = pressAll(state, source, prefix, press("x"));
			expect(fired(close)).toEqual([]);
			expect(closed.lastPress?.outcome).toEqual({_tag: "Command", name: "window:close"});
			const [next] = pressAll(state, source, prefix, ctrl("l"));
			expect(next.lastPress?.outcome).toEqual({_tag: "Command", name: "workspace:next"});
			const [toggled] = pressAll(state, source, prefix, press("p"));
			expect(toggled.desk.boardOpen).toBe(!state.desk.boardOpen);
		}
	});

	it("stops firing a project's bindings the moment its bindings leave the source", () => {
		const live = liveSource(everyOwner);
		const onAlpha = focus(desk(live.source), alpha.scope("counter"), live.source);
		expect(fired(pressAll(onAlpha, live.source, ctrl("g"))[1])).toEqual([alphaClose]);

		live.replace({global: everyOwner.global, projects: new Map()});
		const [after, cmds] = pressAll(onAlpha, live.source, ctrl("g"));
		expect(fired(cmds)).toEqual([]);
		expect(after.lastPress?.outcome).toEqual({_tag: "ToWindow", key: "<c-g>"});

		live.replace(noOwnerBindings);
		expect(fired(pressAll(onAlpha, live.source, ctrl("y"))[1])).toEqual([]);
	});
});
