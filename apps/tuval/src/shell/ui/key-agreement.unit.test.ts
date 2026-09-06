/**
 * The guard ADR 0353 puts under the page's reading of the kernel's grammar, walked over **every**
 * entry of the prefix table.
 *
 * What it compares changed with #8274. The page runs no router any more: the desk sends the key and
 * does what the kernel's answer says (`./press.ts`), so the walk drives the path the desk actually
 * takes, and there are exactly two things left for the two ends to disagree about.
 *
 * 1. **What the kernel did**, stated twice inside one fold — as the Cmds it asks its host for, and
 *    as the answer it records for the page on `lastPress`. The desk acts on the second; the process
 *    receives the first. A fold whose two statements part company is a key the window's renderer and
 *    the window's process see differently.
 * 2. **Whose key it is**, which the desk decides at the press because a default action cannot wait
 *    for a round trip (`shellOwnsKey`). That is the one reading of the grammar left on the page, and
 *    it must agree with the kernel about every key of every gesture.
 *
 * The walk takes the core's table and the page's table separately, because the failure it exists to
 * catch is the two being handed different grammars — pass one table twice and it proves agreement,
 * pass two and it reports the entries they part on. That second call is what gives the first its
 * teeth (`.patterns/unconditional-test-assertions.md`).
 */

import {Result} from "effect";
import {describe, expect, it} from "vitest";
import {applyMsg, type ShellCmd, type ShellState} from "../core/index.ts";
import type {Binding, Key, PrefixTable} from "../keys/index.ts";
import {applyKeysConfig, defaultPrefixTable, normalizeSequence, parse} from "../keys/index.ts";
import {threeWindowDesk} from "./fixtures.ts";
import {COMMAND_LINE_COMMAND, routerPrefix, shellOwnsKey} from "./frame.ts";
import {replyIn} from "./press.ts";

/** One decision about a key, as far as a surface is concerned. */
type Routed =
	| {readonly _tag: "OpenCommandLine"}
	| {readonly _tag: "ToWindow"; readonly key: string};

const keysOf = (sequence: string): ReadonlyArray<Key> =>
	Result.getOrThrow(normalizeSequence(sequence)).map((one) => Result.getOrThrow(parse(one)));

/** What the kernel asked its host to do, and the repeat window it asked it to time. */
const asCmds = (cmds: ReadonlyArray<ShellCmd>): readonly [ReadonlyArray<Routed>, number | null] => {
	const routed: Array<Routed> = [];
	let repeatTimer: number | null = null;
	for (const cmd of cmds) {
		if (cmd.type === "forwardKey") routed.push({_tag: "ToWindow", key: cmd.key});
		if (cmd.type === "openCommandLine") routed.push({_tag: "OpenCommandLine"});
		if (cmd.type === "startRepeatTimer") repeatTimer = cmd.timeoutMs;
	}
	return [routed, repeatTimer];
};

/**
 * The same decision as the desk reads it: off `lastPress`, out of the state the acknowledgement
 * carried back, under the page's own stamp. `Consumed` and a command the page does not implement
 * are both "nothing for the surface to do", which is the empty list.
 */
const asAnswer = (state: ShellState, pressId: string): ReadonlyArray<Routed> => {
	const reply = replyIn(pressId, state);
	if (reply._tag === "ToWindow") return [{_tag: "ToWindow", key: reply.key}];
	if (reply._tag === "Command" && reply.name === COMMAND_LINE_COMMAND) {
		return [{_tag: "OpenCommandLine"}];
	}
	return [];
};

/** One line per press the two ends answered differently, naming the binding it was typing. */
const disagreements = (core: PrefixTable, page: PrefixTable): ReadonlyArray<string> => {
	const found: Array<string> = [];
	for (const binding of core.bindings) {
		// The prefix first, then the sequence — the whole gesture a user types for this entry.
		const gesture = [...keysOf(core.prefix), ...keysOf(binding.sequence)];
		// The focused window holds a process, so `forwardKey` is emitted where the surface forwards.
		let state = threeWindowDesk();
		let press = 0;
		for (const key of gesture) {
			press += 1;
			const pressId = `page-${press}`;
			// Whose key it is, decided on the page at the press, over the table this page was sent.
			const pageOwns = shellOwnsKey(page, routerPrefix(state), key);
			const [next, cmds] = applyMsg(core, state, {type: "keys.press", key, pressId});
			const [asked, repeatTimer] = asCmds(cmds);
			const derived = asAnswer(next, pressId);
			// The kernel took the key whenever it did not hand it to the window.
			const coreOwns = !asked.some((one) => one._tag === "ToWindow");
			if (pageOwns !== coreOwns) {
				found.push(
					`${binding.sequence}: core owns ${String(coreOwns)} vs page owns ${String(pageOwns)}`,
				);
			}
			if (JSON.stringify(asked) !== JSON.stringify(derived)) {
				found.push(
					`${binding.sequence}: cmds ${JSON.stringify(asked)} vs answer ${JSON.stringify(derived)}`,
				);
			}
			// The desk runs its countdown off `repeatWindowMs` rather than off the Cmd, so the two
			// producers of that window have to answer the same number.
			const shown = next.prefix.armed ? next.prefix.repeatWindowMs : null;
			if (repeatTimer !== null && repeatTimer !== shown) {
				found.push(
					`${binding.sequence}: repeat timer ${repeatTimer}ms vs snapshot ${String(shown)}ms`,
				);
			}
			state = next;
		}
	}
	return found;
};

const bindingFor = (sequence: string): Binding => {
	const binding = defaultPrefixTable.bindings.find((one) => one.sequence === sequence);
	if (binding === undefined) throw new Error(`no default binding for ${sequence}`);
	return binding;
};

describe("the core and the page answer one prefix table alike", () => {
	it("walks every entry of the default table with no disagreement", () => {
		expect(defaultPrefixTable.bindings.length).toBeGreaterThan(0);
		expect(disagreements(defaultPrefixTable, defaultPrefixTable)).toEqual([]);
	});

	it("walks every entry of a config-supplied table with no disagreement", () => {
		const table = Result.getOrThrow(
			applyKeysConfig(defaultPrefixTable, {
				prefix: "<c-a>",
				bindings: [{...bindingFor(":"), sequence: "<c-p>"}],
			}),
		);
		expect(table.bindings.some((one) => one.sequence === "<c-p>")).toBe(true);
		expect(disagreements(table, table)).toEqual([]);
	});

	it("reports the entries a page reading another table parts on", () => {
		const core = Result.getOrThrow(applyKeysConfig(defaultPrefixTable, {prefix: "<c-a>"}));
		const parted = disagreements(core, defaultPrefixTable);
		// The gesture's first key is the prefix, and the page holding another table does not know it
		// is one — so every entry of the table parts on its first press.
		expect(parted.length).toBeGreaterThanOrEqual(core.bindings.length);
		expect(parted[0]).toContain("core owns true vs page owns false");
	});
});
