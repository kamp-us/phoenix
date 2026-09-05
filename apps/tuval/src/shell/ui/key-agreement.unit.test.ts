/**
 * The guard ADR 0353 puts under the deliberate duplicate routing: the core answers a key with Cmds
 * and the surface derives the page-run ones again through `surfaceKey`, and this walks **every**
 * entry of the prefix table asserting the two name the same act.
 *
 * The walk takes the core's table and the page's table separately, because the failure it exists to
 * catch is the two being handed different grammars — pass one table twice and it proves agreement,
 * pass two and it reports the entries they part on. That second call is what gives the first its
 * teeth (`.patterns/unconditional-test-assertions.md`).
 */

import {Result} from "effect";
import {describe, expect, it} from "vitest";
import {applyMsg, type ShellState} from "../core/index.ts";
import type {Binding, Key, PrefixTable} from "../keys/index.ts";
import {applyKeysConfig, defaultPrefixTable, normalizeSequence, parse} from "../keys/index.ts";
import {threeWindowDesk} from "./fixtures.ts";
import {routerPrefix, surfaceKey} from "./frame.ts";

/**
 * One routing decision about a key. The core states it as a Cmd and the surface derives it again
 * through `surfaceKey`; the two deliver it differently — the kernel dispatches `forwardKey` into the
 * process, the page hands the key to that window's renderer — but they must decide it alike.
 */
type Routed =
	| {readonly _tag: "OpenCommandLine"}
	| {readonly _tag: "ToWindow"; readonly key: string};

const keysOf = (sequence: string): ReadonlyArray<Key> =>
	Result.getOrThrow(normalizeSequence(sequence)).map((one) => Result.getOrThrow(parse(one)));

/** How the core routed the key, and the repeat window it asked the host to time. */
const coreRouted = (
	state: ShellState,
	table: PrefixTable,
	key: Key,
): readonly [ShellState, ReadonlyArray<Routed>, number | null] => {
	const [next, cmds] = applyMsg(table, state, {type: "keys.press", key});
	const routed: Array<Routed> = [];
	let repeatTimer: number | null = null;
	for (const cmd of cmds) {
		if (cmd.type === "forwardKey") routed.push({_tag: "ToWindow", key: cmd.key});
		if (cmd.type === "openCommandLine") routed.push({_tag: "OpenCommandLine"});
		if (cmd.type === "startRepeatTimer") repeatTimer = cmd.timeoutMs;
	}
	return [next, routed, repeatTimer];
};

/** The same decision, derived on the page from the snapshot and the table it was sent. */
const surfaceRouted = (state: ShellState, table: PrefixTable, key: Key): ReadonlyArray<Routed> => {
	const answer = surfaceKey(table, routerPrefix(state), key);
	if (answer._tag === "Shell") return [];
	return [
		answer._tag === "OpenCommandLine"
			? {_tag: "OpenCommandLine"}
			: {_tag: "ToWindow", key: answer.key},
	];
};

/** One line per press the two sides answered differently, naming the binding it was typing. */
const disagreements = (core: PrefixTable, page: PrefixTable): ReadonlyArray<string> => {
	const found: Array<string> = [];
	for (const binding of core.bindings) {
		// The prefix first, then the sequence — the whole gesture a user types for this entry.
		const gesture = [...keysOf(core.prefix), ...keysOf(binding.sequence)];
		// The focused window holds a process, so `forwardKey` is emitted where the surface forwards.
		let state = threeWindowDesk();
		for (const key of gesture) {
			const derived = surfaceRouted(state, page, key);
			const [next, asked, repeatTimer] = coreRouted(state, core, key);
			if (JSON.stringify(asked) !== JSON.stringify(derived)) {
				found.push(
					`${binding.sequence}: core ${JSON.stringify(asked)} vs page ${JSON.stringify(derived)}`,
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

	it("reports the entries a page routing over another table parts on", () => {
		const core = Result.getOrThrow(applyKeysConfig(defaultPrefixTable, {prefix: "<c-a>"}));
		const parted = disagreements(core, defaultPrefixTable);
		expect(parted.length).toBe(core.bindings.length);
		expect(parted[0]).toContain("core []");
	});
});
