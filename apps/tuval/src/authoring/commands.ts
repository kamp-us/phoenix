/**
 * A program's `commands` record, compiled into the spells the row already carries. One declared
 * command is one `defineSpell` (`../commands/spell.ts`): the declared `args` schema becomes the
 * spell's `params`, and `run` becomes its `execute`, interpreting the effect vocabulary
 * (`./effect.ts`) through the very handlers the spine hands this compiler.
 *
 * **The program id is the group and the author never writes the prefix** (#8716 R16.1). Nothing
 * here composes a group: the spell keeps the declared path, and the spell registry is what
 * registers it at `[program.id, ...spell.path]` (`../commands/registry.ts`) — so the group is
 * taken from the row's own id and there is nowhere for a package name to reach the path.
 */

import {Effect, Schema} from "effect";
import {type AnySpell, defineSpell, type Scope, type SpellPath} from "../commands/spell.ts";
import type {CapabilityRequest, HostHandlers} from "../registry/program.ts";
import type {AuthoredEvent} from "./define-program.ts";
import type {ProgramEffect} from "./effect.ts";

/** What a command's `args` may be declared over: decodable from `unknown` with no services. */
export type CommandArgs<A> = Schema.Codec<A, any, never, unknown>;

/** What a command's `run` answers: the effects it asks for, one or a list. */
export type CommandAnswer = ProgramEffect | ReadonlyArray<ProgramEffect>;

/** One command, as a user writes it. Nothing on it names a spell, a path prefix or an Effect. */
export interface CommandDecl<A> {
	readonly args: CommandArgs<A>;
	/** One user-facing sentence, shown beside the path. Absent falls through to the path itself. */
	readonly describe?: string;
	/** Inert, like every other capability list on a row: declared and checked by nothing (#7617 R1.6). */
	readonly capabilities?: ReadonlyArray<CapabilityRequest>;
	readonly run: (args: A, scope: Scope) => CommandAnswer;
}

export type AnyCommandDecl = CommandDecl<any>;

export type CommandDecls = Readonly<Record<string, AnyCommandDecl>>;

/**
 * The declared table, keyed by command name over the argument type each command takes.
 *
 * One mapped type over the argument types rather than over the declarations themselves, so the
 * checker infers each cell's argument from that cell's own `args` schema and hands it to `run`.
 * Measured at this pin: over the declarations, `commands: C & CommandTable<C>` — the shape
 * `update` takes — types every `run` argument `any`, because the contextual type an intersection
 * of two signatures offers a closure parameter is `any`.
 */
export type CommandTable<C> = {readonly [K in keyof C]: CommandDecl<C[K]>};

/** What `defineProgram` binds its command generic to: one argument type per declared name. */
export type CommandArgTypes = Readonly<Record<string, unknown>>;

/** What the compiled `execute` needs to interpret an effect: the spine's own five handlers. */
export type EffectHandlers<E, R> = HostHandlers<AuthoredEvent, ProgramEffect, E, R>;

const asList = (answer: CommandAnswer): ReadonlyArray<ProgramEffect> =>
	Array.isArray(answer) ? answer : [answer as ProgramEffect];

/**
 * Run a command's effects through the spine's handlers, exactly as an `update` cell's effects are
 * run. The events those handlers answer — a `spawn`'s `spawned`, a `stop`'s `stopped` — are
 * dropped here: a spell call is not a process step and has no inbox to dispatch them into.
 */
const interpret = <E, R>(
	answer: CommandAnswer,
	handlers: EffectHandlers<E, R>,
): Effect.Effect<void, E, R> => {
	const byType = handlers as {
		readonly [K in ProgramEffect["type"]]: (
			cmd: ProgramEffect,
		) => Effect.Effect<ReadonlyArray<AuthoredEvent>, E, R>;
	};
	// Serial on purpose: a command's effects are asked for in the order they were written, exactly
	// as an `update` cell's list is.
	return Effect.forEach(asList(answer), (effect) => byType[effect.type](effect), {
		concurrency: 1,
		discard: true,
	});
};

/**
 * The declared name is the command's path, dot-separated as a rendered path is (`window.close`).
 * An empty segment is an author's typo with no honest reading, so it is refused where it is
 * written rather than compiled into a row no caller can ever address.
 */
const pathOf = (name: string): SpellPath => {
	const segments = name.split(".");
	if (segments.some((segment) => segment.length === 0)) {
		throw new Error(`command name "${name}" has an empty segment`);
	}
	const [head, ...rest] = segments as [string, ...ReadonlyArray<string>];
	return [head, ...rest];
};

const NO_CAPABILITIES: ReadonlyArray<CapabilityRequest> = [];

/**
 * Compile a declared `commands` record into spells. The path carries no prefix, because the group
 * is the registry's to compose from the row's id — two programs declaring one command name
 * therefore collide on nothing. A program declaring none answers `undefined`, which is how the
 * row's optional `spells` stays absent rather than present-and-empty.
 */
export const compileCommands = <E, R>(
	commands: CommandDecls | undefined,
	handlers: EffectHandlers<E, R>,
): ReadonlyArray<AnySpell> | undefined => {
	const declared = Object.entries(commands ?? {});
	if (declared.length === 0) return undefined;
	return declared.map(([name, decl]) => {
		const path = pathOf(name);
		return defineSpell({
			path,
			describe: decl.describe ?? path.join("."),
			params: decl.args,
			result: Schema.Void,
			execute: (args: unknown, scope: Scope) => interpret(decl.run(args, scope), handlers),
			capabilities: decl.capabilities ?? NO_CAPABILITIES,
		});
	});
};
