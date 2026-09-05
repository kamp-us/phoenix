/**
 * The table as spells on the shell's program row. There is no second command mechanism beside the
 * framework's (ADR 0348): a row is registered under `[shellId, ...path]` like any program's spell,
 * so `help`, `spell describe`, the palette's parser and an agent's bridge all reach the shell's
 * commands through the one registry.
 *
 * A spell's `execute` does exactly what the row says and nothing more — build the Msg, hand it to
 * `ShellDispatch`. The row stays pure; the impurity is one service call, in one place, where the
 * framework already expects a spell's requirements to ride its own type.
 */

import {Effect, Schema} from "effect";
import {type AnySpell, defineSpell} from "../../commands/spell.ts";
import {ShellDispatch} from "./dispatch.ts";
import type {AnyShellCommand} from "./row.ts";
import {shellCommands} from "./table.ts";

/**
 * What a run answers with: the Msg type it dispatched. A caller cannot read the desk from a reply —
 * the snapshot is how the desk is read — so the reply says what was done and stops there.
 */
export const CommandDispatched = Schema.Struct({msg: Schema.String});

const toSpell = (command: AnyShellCommand): AnySpell =>
	defineSpell({
		path: command.path,
		describe: command.describe,
		params: command.params,
		result: CommandDispatched,
		execute: Effect.fn("Tuval.Shell.command")(function* (args: unknown) {
			const shell = yield* ShellDispatch;
			const msg = command.toMsg(args);
			yield* shell.dispatch(msg);
			return {msg: msg.type};
		}),
		capabilities: [],
	});

/** Every command row as a spell, in table order. `shellProgram` declares this as its `spells`. */
export const shellSpells: ReadonlyArray<AnySpell> = shellCommands.map(toSpell);
