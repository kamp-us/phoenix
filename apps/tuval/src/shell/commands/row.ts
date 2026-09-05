/**
 * A named command row: the thing a key binding names, the command line resolves, and the spell
 * registry publishes. The shape is the founder's `@usirin/spellbook`
 * (`monorepo/packages/spellbook/src/spellbook.ts`) narrowed to what a shell command needs — a
 * Spellbook spell's `execute` returned a Promise over context the closure had captured, and a row
 * here returns one core Msg from its decoded parameters and nothing else.
 *
 * That signature is the whole discipline: no scope argument, no service, no closure over a runtime,
 * so a row is data a test can drive. Whatever a command needs from the world — a process to spawn,
 * a config module to re-import — rides on the Msg's own Cmd, which is the host's to run.
 */

import type {Schema} from "effect";
import type {ShellMsg} from "../core/machine.ts";
import {CommandName} from "../keys/table.ts";

/**
 * A row's address: a non-empty list of lowercase English segments (`["window", "close"]`).
 * Non-emptiness is in the type, matching the spell framework's `SpellPath`.
 */
export type CommandPath = readonly [string, ...ReadonlyArray<string>];

export interface ShellCommand<Params extends Schema.Top = Schema.Top> {
	readonly path: CommandPath;
	/** One user-facing sentence. Every surface that shows this row shows this string. */
	readonly describe: string;
	readonly params: Params;
	readonly toMsg: (params: Params["Type"]) => ShellMsg;
}

/** A row with its parameter type erased: what one table holding rows of every shape stores. */
export type AnyShellCommand = ShellCommand<any>;

/**
 * Pins a row's parameter type at the declaration site. The identity function, like `defineSpell`:
 * the whole job is inference, so a `toMsg` returning a Promise, or reading a second argument the
 * caller has no way to supply, is a compile error where it is written.
 */
export const defineCommand = <Params extends Schema.Top>(
	command: ShellCommand<Params>,
): ShellCommand<Params> => command;

/**
 * The name the prefix table binds and a user types: the path joined by colons. One derivation, so
 * a row cannot carry a name its own path disagrees with.
 */
export const commandName = (path: CommandPath): CommandName => CommandName.make(path.join(":"));

/**
 * The same name read back as a path. `split` always yields at least one element, so the head is
 * destructured and defaulted rather than asserted — non-emptiness stays a fact the type carries.
 */
export const commandPath = (name: CommandName | string): CommandPath => {
	const [head = "", ...rest] = String(name).split(":");
	return [head, ...rest];
};

/**
 * The parameters in declaration order, which is the positional order the command line binds them
 * in. `Schema.Struct` keeps `fields` in declaration order, the same property the spell framework's
 * `readParams` reads off the rendered JSON Schema (`.patterns/tuval-spells.md`, "The spell index").
 */
export const parameterNames = (command: AnyShellCommand): ReadonlyArray<string> =>
	Object.keys(command.params.fields ?? {});
