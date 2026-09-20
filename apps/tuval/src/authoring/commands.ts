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
import type {ProcessTable} from "../process/ProcessTable.ts";
import type {CapabilityRequest, HostHandlers, ProgramId} from "../registry/program.ts";
import type {AuthoredEvent} from "./define-program.ts";
import type {SendEffect, SendTarget} from "./effect.ts";
import {type OwnProcessRefused, resolveOwnProcess} from "./own-process.ts";

/**
 * Re-exported because a `run` that reads its scope has to name the type, and an author reaching
 * `../commands/spell.ts` for it would be reaching past the authoring layer for a kernel module —
 * which is the one thing R12.1 says they never do.
 */
export type {Scope};

/** What a command's `args` may be declared over: decodable from `unknown` with no services. */
export type CommandArgs<A> = Schema.Codec<A, any, never, unknown>;

/**
 * The one effect a command may ask for: `send`. Not four of the six, and not five — one (ADR 0372
 * as #8898 and #8858 amended it).
 *
 * The argument is the same in every case the ruling closed, and it is what a spell call *is*: not a
 * process step. The `Scope` it runs under (`../commands/spell.ts`) names a workspace and a client,
 * and the `process` it may carry is the *caller's*. So `emit` has no out-port of the declaring
 * program's to announce on; `spawn` has no honest process to stamp a child's parent from and `ask`
 * none to route an answer back to (both read `ProcessSelf`, which `Kernel` does not carry — #8858);
 * `reply` answers a question this call was never asked; and `stop` ends a process the command was
 * given no claim on. What is left is the one route that was always honest: put a payload on an
 * in-port and let the `update` cell that owns it decide.
 *
 * The target widens where the verb narrows. `SendTarget` lets a command name a bare port of its own
 * program, which `./own-process.ts` resolves at the call — so a command sends into its own program
 * without ever minting a process id, and the explicit `send({process, port}, …)` still works for
 * the process a command was handed as an argument.
 */
export type CommandEffect = SendEffect<SendTarget>;

/** What a command's `run` answers: the effects it asks for, one or a list. */
export type CommandAnswer = CommandEffect | ReadonlyArray<CommandEffect>;

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

/**
 * What the compiled `execute` needs to interpret a command's effects: the spine's `send` handler,
 * and nothing else. Every other handler is unreachable from here, so a compiled spell requires
 * neither `ProcessPorts` (the `emit` reader) nor `ProcessSelf` (the `spawn`/`ask` reader) — the two
 * services `Kernel` does not name, and the whole of what #8766, #8858 and #8898 were about.
 *
 * Typed over the addressed `SendEffect` rather than over `CommandEffect`: a bare target is resolved
 * into one before the handler sees it, so the spine's handler stays the one an `update` cell uses.
 */
export type CommandHandlers<E, R> = HostHandlers<AuthoredEvent, SendEffect, E, R>;

const asList = (answer: CommandAnswer): ReadonlyArray<CommandEffect> =>
	Array.isArray(answer) ? answer : [answer as CommandEffect];

/** The addressed form of one command `send`: a bare port resolved against the declaring program. */
const address = (
	program: ProgramId,
	effect: CommandEffect,
	scope: Scope,
): Effect.Effect<SendEffect, OwnProcessRefused, ProcessTable> =>
	typeof effect.to === "string"
		? Effect.map(resolveOwnProcess(program, effect.to, scope), (process) => ({
				type: "send",
				to: {process, port: effect.to as string},
				payload: effect.payload,
			}))
		: Effect.succeed(effect as SendEffect);

/**
 * Run a command's sends through the spine's handler, exactly as an `update` cell's are run. The
 * events a handler answers are dropped here: a spell call is not a process step and has no inbox to
 * dispatch them into.
 */
const interpret = <E, R>(
	program: ProgramId,
	answer: CommandAnswer,
	scope: Scope,
	handlers: CommandHandlers<E, R>,
): Effect.Effect<void, E | OwnProcessRefused, R | ProcessTable> =>
	// Serial on purpose: a command's effects are asked for in the order they were written, exactly
	// as an `update` cell's list is. Each is addressed immediately before it is run rather than all
	// of them up front, so a refusal stops the list where it was written.
	Effect.forEach(
		asList(answer),
		(effect) => Effect.flatMap(address(program, effect, scope), handlers.send),
		{concurrency: 1, discard: true},
	);

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
 *
 * `program` is the row's own id, and it is taken here for the same reason the group is not: a bare
 * `send("pr", pr)` means *this program's* process, so the compiler is the only place that knows
 * which program to resolve it against.
 */
export const compileCommands = <E, R>(
	program: ProgramId,
	commands: CommandDecls | undefined,
	handlers: CommandHandlers<E, R>,
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
			execute: (args: unknown, scope: Scope) =>
				interpret(program, decl.run(args, scope), scope, handlers),
			capabilities: decl.capabilities ?? NO_CAPABILITIES,
		});
	});
};
