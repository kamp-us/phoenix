/**
 * The desk's reserved keys (#9687, ruling #9668 R4.2 R1): the prefix, and the chords after it that
 * switch workspace, open the picker, pull up the board and close a window. They work whatever has
 * focus, and a project config that binds one is refused at load. A key is named the way the key
 * grammar spells it, so `<C-b>x` and `<c-b>x` are one key however a config writes it.
 */

import {
	type CommandName,
	normalizeSequence,
	type PrefixTable,
	prefixTableFor,
} from "@kampus/tuval-ui/keys";
import {Result} from "effect";

/** The commands whose chords no project may bind. */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set([
	"workspace:previous",
	"workspace:next",
	"window:pick",
	"desk:board-toggle",
	"window:close",
]);

/** A key in its one spelling, or `undefined` when the key grammar cannot read it. */
export const keyOf = (key: string): string | undefined =>
	Result.match(normalizeSequence(key), {
		onFailure: () => undefined,
		onSuccess: (keys) => keys.join(""),
	});

/** What a reserved key does: arm the prefix, or run one of the reserved commands. */
export type ReservedAction =
	| {readonly _tag: "Prefix"}
	| {readonly _tag: "Command"; readonly command: CommandName};

export class ReservedDeskKeys {
	private readonly byKey: ReadonlyMap<string, ReservedAction>;

	private constructor(byKey: ReadonlyMap<string, ReservedAction>) {
		this.byKey = byKey;
	}

	/**
	 * The reserved keys of the grammar the desk's shell routes. Read with every flag-gated chord in,
	 * so a project binding does not start or stop loading when a global flag flips.
	 */
	static of(table: PrefixTable): ReservedDeskKeys {
		const gated = prefixTableFor(table, {processBoard: true});
		const byKey = new Map<string, ReservedAction>();
		const prefix = keyOf(gated.prefix);
		if (prefix !== undefined) byKey.set(prefix, {_tag: "Prefix"});
		for (const binding of gated.bindings) {
			if (!RESERVED_COMMANDS.has(binding.command)) continue;
			const key = keyOf(`${gated.prefix}${binding.sequence}`);
			if (key !== undefined) byKey.set(key, {_tag: "Command", command: binding.command});
		}
		return new ReservedDeskKeys(byKey);
	}

	/** What `key` does as a reserved key, or `undefined` when it is not one. */
	actionOf(key: string): ReservedAction | undefined {
		const normalized = keyOf(key);
		return normalized === undefined ? undefined : this.byKey.get(normalized);
	}

	/** Every reserved key in its one spelling, beside what it does. */
	get entries(): ReadonlyArray<readonly [string, ReservedAction]> {
		return [...this.byKey];
	}

	/**
	 * A project layer's `keys` block as it runs, or why it may not: the first key it binds that is
	 * reserved, named as the config wrote it.
	 */
	refuseIn(keys: Readonly<Record<string, unknown>>): Result.Result<void, string> {
		for (const key of Object.keys(keys)) {
			const action = this.actionOf(key);
			if (action === undefined) continue;
			const what = action._tag === "Prefix" ? "the prefix" : `the ${action.command} chord`;
			return Result.fail(
				`binds "${key}", the desk's reserved key for ${what}; a project cannot rebind a reserved desk key`,
			);
		}
		return Result.void;
	}
}
