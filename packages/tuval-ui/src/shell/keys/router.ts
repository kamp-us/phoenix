/**
 * The router: one table, one prefix state and one key event in; one answer out. A pure function —
 * it holds nothing between calls, reads no clock and touches no global. An armed prefix is
 * unbounded, so the only window this module dates is the repeat one, on the state it hands back;
 * firing that timer is the core's Cmd.
 *
 * Every answer carries the state that follows it, so the caller never derives the next state from
 * the answer's shape and the two can never disagree.
 */

import type {Duration} from "effect";
import {Result} from "effect";
import {type Key, normalize, stringify} from "./syntax.ts";
import {type Binding, type CommandName, normalizeSequence, type PrefixTable} from "./table.ts";

/** The prefix is unarmed: every key belongs to the focused window. */
export interface Idle {
	readonly _tag: "Idle";
}

/**
 * The prefix is armed. `pending` is the sequence typed since it armed — empty right after the
 * prefix, or after a repeatable command re-armed it.
 *
 * `repeatWindow` is `null` for an ordinary arm, and that absence is the ruling on #7842: the shell
 * waits indefinitely for the sequence, as tmux does. A duration appears only when a
 * `repeatable: true` binding re-armed the prefix — tmux's `repeat-time`, the one bounded window.
 */
export interface Armed {
	readonly _tag: "Armed";
	readonly pending: ReadonlyArray<string>;
	readonly repeatWindow: Duration.Duration | null;
}

export type PrefixState = Idle | Armed;

export const idle: PrefixState = {_tag: "Idle"};

const armed = (
	pending: ReadonlyArray<string>,
	repeatWindow: Duration.Duration | null,
): PrefixState => ({
	_tag: "Armed",
	pending,
	repeatWindow,
});

/** The key belongs to the focused window, verbatim. */
export interface ToWindow {
	readonly _tag: "ToWindow";
	readonly key: string;
	readonly next: PrefixState;
}

/** The prefix was pressed: the shell is listening for a sequence. */
export interface Arm {
	readonly _tag: "Arm";
	readonly next: PrefixState;
}

/** A bound sequence completed. The name resolves against the command rows (#7555). */
export interface Command {
	readonly _tag: "Command";
	readonly name: CommandName;
	readonly next: PrefixState;
}

/**
 * Nothing to do and nothing to forward: either the sequence so far is the start of a longer
 * binding, or the key names nothing bindable — a bare modifier press. The state is unchanged.
 */
export interface Pending {
	readonly _tag: "Pending";
	readonly next: PrefixState;
}

/** No binding starts with this sequence. The prefix disarms and the keys are dropped, never forwarded. */
export interface Unbound {
	readonly _tag: "Unbound";
	readonly sequence: string;
	readonly next: PrefixState;
}

export type RouteAnswer = ToWindow | Arm | Command | Pending | Unbound;

const keysOf = (binding: Binding): ReadonlyArray<string> =>
	Result.getOrElse(normalizeSequence(binding.sequence), () => []);

const startsWith = (keys: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean =>
	prefix.length <= keys.length && prefix.every((key, index) => keys[index] === key);

const sameKeys = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && startsWith(a, b);

/** One key event against the table and the state it arrives in. */
export const route = (table: PrefixTable, state: PrefixState, event: Key): RouteAnswer => {
	const key = stringify(event);
	// A bare modifier keydown names no key: it neither reaches the window nor disturbs an armed prefix.
	if (key === "") return {_tag: "Pending", next: state};

	if (state._tag === "Idle") {
		return key === Result.getOrElse(normalize(table.prefix), () => table.prefix)
			? {_tag: "Arm", next: armed([], null)}
			: {_tag: "ToWindow", key, next: idle};
	}

	const pending = [...state.pending, key];
	const bound = table.bindings.find((binding) => sameKeys(keysOf(binding), pending));
	if (bound !== undefined) {
		return {
			_tag: "Command",
			name: bound.command,
			// tmux `bind -r`: a repeatable command leaves the prefix armed for the repeat window.
			next: bound.repeatable ? armed([], table.repeatTimeout) : idle,
		};
	}

	// A half-typed sequence carries the repeat window forward rather than clearing it, so typing
	// into a repeat-armed prefix cannot escape the bound tmux puts on it.
	return table.bindings.some((binding) => startsWith(keysOf(binding), pending))
		? {_tag: "Pending", next: armed(pending, state.repeatWindow)}
		: {_tag: "Unbound", sequence: pending.join(""), next: idle};
};
