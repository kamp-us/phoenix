/**
 * The two boundaries this slice keeps. The first is type-level, so `tsc` over this file is the
 * proof: a row's `toMsg` answers with a core Msg and never with a Promise, so nothing awaits a
 * command row and no row can smuggle an async handler in the way a Spellbook spell's `execute`
 * could. The second is behavioural and textual: a row reads its parameters and nothing else.
 *
 * Every `=` probe below is a claim on the right of an assignment and each was flip-verified — see
 * `.patterns/unconditional-test-assertions.md`, "the type-level sibling".
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import type {ShellMsg} from "../core/machine.ts";
import type {AnyShellCommand, ShellCommand} from "./row.ts";
import {shellCommands} from "./table.ts";

/** `true` when this row's `toMsg` answers with a core Msg. A Promise anywhere collapses it. */
type ReturnsMsg<C> = C extends {readonly toMsg: (...args: never[]) => infer R}
	? [R] extends [ShellMsg]
		? [R] extends [Promise<unknown>]
			? false
			: true
		: false
	: false;

const tableRowReturnsMsg: ReturnsMsg<AnyShellCommand> = true;
const declaredRowReturnsMsg: ReturnsMsg<ShellCommand> = true;
const promiseDoesNot: ReturnsMsg<{readonly toMsg: () => Promise<ShellMsg>}> = false;
const someOtherValueDoesNot: ReturnsMsg<{readonly toMsg: () => {readonly type: "nope"}}> = false;

describe("command row boundary", () => {
	it("every row's toMsg answers with a core Msg, never a Promise", () => {
		expect([tableRowReturnsMsg, declaredRowReturnsMsg]).toEqual([true, true]);
		expect([promiseDoesNot, someOtherValueDoesNot]).toEqual([false, false]);
	});

	it("no row captures context: it reads its parameters, and nothing beyond them", () => {
		expect(shellCommands.length).toBeGreaterThan(0);
		for (const command of shellCommands) {
			// A `toMsg` reading a second argument would have arity 2 — there is nowhere for one to
			// come from, since the command line and a bound key both call it with parameters alone.
			expect(`${command.path.join(":")}: ${command.toMsg.length <= 1}`).toBe(
				`${command.path.join(":")}: true`,
			);
			const params = Object.fromEntries(
				Object.keys(command.params.fields).map((name) => [name, "x"]),
			);
			// Same parameters, same Msg, however many times and in whatever order — a row holding
			// state of its own could not keep that.
			expect(command.toMsg(params)).toEqual(command.toMsg(params));
			expect(JSON.parse(JSON.stringify(command.toMsg(params)))).toEqual(command.toMsg(params));
		}
	});

	it("the row and table modules reach no runtime, no clock and no host", () => {
		const dir = import.meta.dirname;
		for (const name of ["row.ts", "table.ts", "errors.ts"]) {
			// Comments go first: "window" and "process" are this slice's own domain nouns.
			const code = readFileSync(join(dir, name), "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			for (const forbidden of ["Effect", "async ", "await ", "Date.now", "Math.random"]) {
				expect(`${name}: ${code.includes(forbidden)}`).toBe(`${name}: false`);
			}
		}
	});

	it("leaves no module of this slice unread by the checks above", () => {
		const sources = readdirSync(import.meta.dirname).filter(
			(name) => name.endsWith(".ts") && !name.endsWith(".unit.test.ts"),
		);
		expect(sources.sort()).toEqual([
			"dispatch.ts",
			"errors.ts",
			"index.ts",
			"kernel.ts",
			"line.ts",
			"row.ts",
			"spells.ts",
			"table.ts",
		]);
	});
});
