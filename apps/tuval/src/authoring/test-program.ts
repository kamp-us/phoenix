/**
 * `testProgram` — drive an authored program by hand and read back what it did (#8716 R19.1).
 *
 * `testProgram(prReview).send("pr", 1)` answers the new state and the effects the program asked
 * for, with no kernel, no desk, no Effect runtime and no wiring: `init` and the `update` cells are
 * plain functions, so a test calls them the way the spine would. What this adds over calling them
 * by hand is the three things the kernel does around them — an in-port payload decoded through
 * that port's own schema, a derived `title`/`status` emit appended when the line moved
 * (`./view.ts`), and a declared command run through its own args schema (`./commands.ts`).
 *
 * A step answers a fresh run rather than mutating one, so two arrivals branched off a shared prefix
 * cannot see each other's state.
 *
 * **A payload arrives as `unknown`, exactly as it does on the wire.** The port's schema is the
 * whole check, so a test sending a payload the schema rejects fails here the way it would fail at
 * the kernel's enqueue rather than at the type-checker — which is the refusal a test wants to be
 * able to write.
 */

import {Result, Schema} from "effect";
import {ClientId, type Scope, WorkspaceId} from "../commands/spell.ts";
import {describeSchemaError} from "../protocol/issue.ts";
import type {AnyCommandDecl, CommandAnswer, CommandArgTypes} from "./commands.ts";
import type {
	Answer,
	AnyAuthoredProgram,
	ArrivalEvent,
	ArrivingPortNames,
	AuthoredEvent,
	AuthoredProgram,
} from "./define-program.ts";
import type {ProgramEffect} from "./effect.ts";
import {KEY_EVENT, type KeyEvent} from "./keys.ts";
import type {AnyPortDecl, PortCodec, PortDecls} from "./port.ts";
import {initialSelfReport, type ProgramEvent, withSelfReport} from "./view.ts";

/**
 * One step of a program, and the three arrivals that take it to the next one. `state` and
 * `effects` are plain values off the program's own types, so an assertion reads a record and never
 * a handle.
 */
export interface ProgramRun<S, D extends PortDecls, U, C extends CommandArgTypes> {
	readonly state: S;
	/** What the last step asked for. The initial run carries the derived lines a fresh process publishes. */
	readonly effects: ReadonlyArray<ProgramEffect>;
	/** A payload on one of this program's arriving ports, decoded through that port's schema. */
	readonly send: (port: ArrivingPortNames<D>, payload: unknown) => ProgramRun<S, D, U, C>;
	/**
	 * One of the program's own events: an author's event, or an answer to an effect it asked for —
	 * `spawned`, `stopped`, a routed child out-port, an `ask`'s named reply. The four are ordinary
	 * events with cells of their own, so one door takes all of them.
	 */
	readonly event: (event: ProgramEvent<D, U>) => ProgramRun<S, D, U, C>;
	/** A forwarded keystroke, as the shell would hand it to a program that opted in (`./keys.ts`). */
	readonly key: (key: string) => ProgramRun<S, D, U, C>;
	/**
	 * A declared command, called with its own args. A command call is not a process step — it moves
	 * no state and its effects' answer events are dropped, exactly as the compiled spell drops them
	 * (#8756) — so the run it answers carries the same state and the effects the command asked for.
	 */
	readonly call: <K extends keyof C & string>(
		command: K,
		args: C[K],
		scope?: Scope,
	) => ProgramRun<S, D, U, C>;
}

/** The scope a command call takes when a test states none. A test is its own workspace and client. */
const TEST_SCOPE: Scope = {
	workspace: WorkspaceId.make("tuval/test"),
	client: ClientId.make("tuval/test"),
};

type Cell = (state: unknown, event: unknown) => Answer<unknown>;

/** The schema an arrival is decoded through. `undefined` for an out-port, which nothing arrives on. */
const arrivingSchema = (decl: AnyPortDecl): PortCodec<any> | undefined =>
	decl.direction === "in" ? decl.schema : decl.direction === "request" ? decl.input : undefined;

const decodeArrival = (port: string, decl: AnyPortDecl, payload: unknown): unknown => {
	const schema = arrivingSchema(decl);
	if (schema === undefined) {
		throw new Error(`port "${port}" is an out-port, so nothing arrives on it`);
	}
	const decoded = Schema.decodeUnknownResult(schema)(payload);
	if (Result.isFailure(decoded)) {
		throw new Error(
			`port "${port}" refused the payload: ${describeSchemaError(decoded.failure, payload)}`,
		);
	}
	return decoded.success;
};

/** A command's `run` answers one effect or a list of them; a run always reads a list. */
const asked = (answer: CommandAnswer): ReadonlyArray<ProgramEffect> =>
	Array.isArray(answer) ? answer : [answer as ProgramEffect];

/**
 * Drive one authored program. It takes the authored record rather than the compiled row, because
 * the row erases the very types a test is asserting: the row's `update` is keyed by string and its
 * state is `unknown`, so a helper built on one could only ever answer `unknown` back.
 */
export const testProgram = <
	S,
	D extends PortDecls = Record<string, never>,
	U = unknown,
	C extends CommandArgTypes = Record<string, never>,
	Out = unknown,
>(
	authored: AuthoredProgram<S, D, U, C, Out>,
): ProgramRun<S, D, U, C> => {
	const program = authored as AnyAuthoredProgram;
	const cells = withSelfReport(program, program.update) as Readonly<Record<string, Cell>>;

	const at = (state: S, effects: ReadonlyArray<ProgramEffect>): ProgramRun<S, D, U, C> => {
		const step = (event: AuthoredEvent): ProgramRun<S, D, U, C> => {
			const cell = cells[event.type];
			if (cell === undefined) {
				throw new Error(`the program's \`update\` has no cell for "${event.type}"`);
			}
			const [next, wanted] = cell(state, event);
			return at(next as S, wanted);
		};
		return {
			state,
			effects,
			send: (port, payload) => {
				const decl = program.ports?.[port] as AnyPortDecl | undefined;
				if (decl === undefined) {
					throw new Error(`the program declares no port named "${port}"`);
				}
				const arrival: ArrivalEvent<string, unknown> = {
					type: port,
					payload: decodeArrival(port, decl, payload),
				};
				return step(arrival);
			},
			event: (event) => step(event as AuthoredEvent),
			key: (pressed) => {
				const keystroke: KeyEvent = {type: KEY_EVENT, key: pressed};
				return step(keystroke);
			},
			call: (command, args, scope = TEST_SCOPE) => {
				const decl = program.commands?.[command] as AnyCommandDecl | undefined;
				if (decl === undefined) {
					throw new Error(`the program declares no command named "${command}"`);
				}
				const decoded = Schema.decodeUnknownResult(decl.args)(args);
				if (Result.isFailure(decoded)) {
					throw new Error(
						`command "${command}" refused its args: ${describeSchemaError(decoded.failure, args)}`,
					);
				}
				return at(state, asked(decl.run(decoded.success, scope)));
			},
		};
	};

	const initial = program.init() as S;
	return at(initial, initialSelfReport(program, initial));
};
