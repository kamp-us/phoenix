/**
 * The three boundaries this slice keeps. The first is type-level, so `tsc` over this file is the
 * proof: nothing callable can reach any corner of the shell's state, because the kernel checkpoints
 * it as JSON. The second is the Cmd vocabulary — there is no arm that stops a process, so no path
 * through the reducer can end one. The third is textual: the core runs no clock and reads no DOM.
 *
 * Every `=` probe below is a claim on the right of an assignment and each was flip-verified — see
 * `.patterns/unconditional-test-assertions.md`, "the type-level sibling".
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Duration, Effect} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {ShellCmd, ShellMsg} from "./machine.ts";
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

	it("the Cmd vocabulary has no arm that stops a process", () => {
		expectTypeOf<ShellCmd["type"]>().toEqualTypeOf<
			| "forwardKey"
			| "startRepeatTimer"
			| "cancelRepeatTimer"
			| "runCommand"
			| "openProgram"
			| "attachProcess"
			| "openCommandLine"
			| "reloadConfig"
		>();
	});

	it("every Msg the epic names has a place in the union", () => {
		expectTypeOf<ShellMsg["type"]>().toEqualTypeOf<
			| "window.split"
			| "window.close"
			| "window.focus"
			| "window.focusDirection"
			| "window.bind"
			| "window.unbind"
			| "window.setView"
			| "layout.resize"
			| "layout.zoom"
			| "window.open"
			| "window.attach"
			| "workspace.create"
			| "workspace.remove"
			| "workspace.activate"
			| "workspace.step"
			| "command.open"
			| "config.reload"
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
