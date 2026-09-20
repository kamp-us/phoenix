/**
 * The three boundaries this slice keeps. The first is type-level, so `tsc` over this file is the
 * proof: nothing callable can reach any corner of the shell's state, because the kernel checkpoints
 * it as JSON. The second is the Cmd vocabulary — exactly one arm ends a process and it is named for
 * doing so, so no *window* path through the reducer can end one (#9447 added `removeProcess`; before
 * it there was no such arm at all). The third is textual: the core runs no clock and reads no DOM.
 *
 * Every `=` probe below is a claim on the right of an assignment and each was flip-verified — see
 * `.patterns/unconditional-test-assertions.md`, "the type-level sibling".
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Duration, Effect} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import {defaultPrefixTable} from "../keys/index.ts";
import type {KernelCmd, PageCmd, ShellCmd, ShellMsg} from "./machine.ts";
import {applyMsg, initialState} from "./machine.ts";
import type {PrefixSnapshot, ShellState, Workspace} from "./state.ts";

/**
 * `true` when nothing reachable from `T` is callable. A function anywhere — bare, in an array, on
 * a field, behind a `Duration`'s methods or an Effect's `pipe` — collapses the whole answer to
 * `false`, which is what makes this a proof rather than a spot check.
 *
 * The depth budget is not decoration: the layout tree is recursive, so an unbounded walk is the
 * "circularly references itself in mapped type" error rather than an answer. Eight levels reaches
 * past every field of a workspace holding a stack nested seven deep, and bottoms out permissive,
 * so this is a proof about the shape of the state and not about how deeply a user splits.
 */
type Shallower = [never, 0, 1, 2, 3, 4, 5, 6, 7];
type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

type NoFunctions<T, D extends Level = 8> = [D] extends [never]
	? true
	: T extends (...args: never[]) => unknown
		? false
		: T extends ReadonlyArray<infer E>
			? NoFunctions<E, Shallower[D]>
			: T extends object
				? {[K in keyof T]-?: NoFunctions<T[K], Shallower[D]>}[keyof T] extends true
					? true
					: false
				: true;

const stateIsData: NoFunctions<ShellState> = true;
const workspaceIsData: NoFunctions<Workspace> = true;
const prefixIsData: NoFunctions<PrefixSnapshot> = true;

/** `true` when the two sides name exactly the Cmd vocabulary — no arm missing, none invented. */
type Partitions<A extends string, B extends string, W extends string> = [A | B] extends [W]
	? [W] extends [A | B]
		? true
		: false
	: false;

const armsPartition: Partitions<KernelCmd["type"], PageCmd["type"], ShellCmd["type"]> = true;
const anArmOffTheSides: Partitions<KernelCmd["type"], "openCommandLine", ShellCmd["type"]> = false;

const bareFunction: NoFunctions<{readonly onKey: () => void}> = false;
const nestedFunction: NoFunctions<{readonly views: {readonly render: () => string}}> = false;
const functionInAList: NoFunctions<{readonly cells: ReadonlyArray<() => void>}> = false;
// The one that nearly landed in state: the router's repeat window carries a `Duration`, whose
// methods make it uncheckpointable. `PrefixSnapshot` holds `repeatWindowMs` for that reason.
const durationValue: NoFunctions<{readonly timeout: Duration.Duration}> = false;
const effectValue: NoFunctions<{readonly boot: Effect.Effect<void>}> = false;

describe("shell core boundary", () => {
	it("nothing callable can enter the shell's state", () => {
		expect([stateIsData, workspaceIsData, prefixIsData]).toEqual([true, true, true]);
		expect([bareFunction, nestedFunction, functionInAList]).toEqual([false, false, false]);
		expect([durationValue, effectValue]).toEqual([false, false]);
	});

	it("the Cmd vocabulary ends a process on one arm only, and that arm says so", () => {
		expectTypeOf<ShellCmd["type"]>().toEqualTypeOf<
			| "forwardKey"
			| "startRepeatTimer"
			| "cancelRepeatTimer"
			| "runCommand"
			| "openProgram"
			| "attachProcess"
			| "removeProcess"
			| "openCommandLine"
			| "reloadConfig"
		>();
	});

	it("no window Msg reaches that arm: closing a window still stops nothing (#9447)", () => {
		const table = defaultPrefixTable;
		const state = initialState();
		// A split first, because the last window of a workspace is never closed and the no-op arm
		// would answer `NO_CMDS` for a reason that has nothing to do with process lifetime.
		const [split] = applyMsg(table, state, {type: "window.split", orientation: "horizontal"});
		for (const msg of [
			{type: "window.close"},
			{type: "window.unbind"},
		] satisfies ReadonlyArray<ShellMsg>) {
			expect(applyMsg(table, split, msg)[1]).toEqual([]);
		}
		// And the one Msg that does reach it asks for that arm and nothing else.
		const [, cmds] = applyMsg(table, split, {type: "process.remove", processId: "process-1"});
		expect(cmds.map((cmd) => cmd.type)).toEqual(["removeProcess"]);
	});

	it("every arm names the side that runs it, and the two sides are the whole vocabulary", () => {
		expectTypeOf<PageCmd["type"]>().toEqualTypeOf<
			"startRepeatTimer" | "cancelRepeatTimer" | "openCommandLine"
		>();
		expectTypeOf<KernelCmd["type"]>().toEqualTypeOf<
			| "forwardKey"
			| "runCommand"
			| "openProgram"
			| "attachProcess"
			| "removeProcess"
			| "reloadConfig"
		>();
		expect([armsPartition, anArmOffTheSides]).toEqual([true, false]);
	});

	it("every Msg the epic names has a place in the union", () => {
		expectTypeOf<ShellMsg["type"]>().toEqualTypeOf<
			| "window.split"
			| "window.close"
			| "window.focus"
			| "window.focusDirection"
			| "window.bind"
			| "window.unbind"
			| "window.forwardKey"
			| "window.setView"
			| "layout.resize"
			| "layout.zoom"
			| "window.open"
			| "window.attach"
			| "process.remove"
			| "workspace.create"
			| "workspace.remove"
			| "workspace.activate"
			| "workspace.step"
			| "command.open"
			| "config.reload"
			| "desk.inspector.toggle"
			| "desk.board.toggle"
			| "desk.board.close"
			| "keys.press"
			| "prefix.repeatLapsed"
		>();
	});

	it("runs no clock and reads no host: the repeat timer is the host's, asked for by Cmd", () => {
		const dir = import.meta.dirname;
		const sources = readdirSync(dir).filter(
			(name) => name.endsWith(".ts") && !name.endsWith(".unit.test.ts"),
		);
		expect(sources.length).toBeGreaterThan(0);

		for (const name of sources) {
			// Comments go first: "window" and "timer" are this slice's own domain nouns.
			const code = readFileSync(join(dir, name), "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			for (const forbidden of [
				"document",
				"globalThis",
				"addEventListener",
				"setTimeout",
				"setInterval",
				"Date.now",
				"Math.random",
			]) {
				expect(`${name}: ${code.includes(forbidden)}`).toBe(`${name}: false`);
			}
		}
	});
});
