/**
 * The six things an authored `update` may ask for, and the events that answer them.
 *
 * **`effect` here is one of these five constructors and never an `Effect.Effect`** (#8716,
 * `### Vocabulary impact`). The collision is real: this module is named for the word the program
 * author sees, and it imports nothing from `effect` — the values below are plain serialisable
 * records. Interpreting them into the registry row's Cmds is the spine's (#8728).
 */

import type {ReplyTo} from "../process/inbox.ts";
import type {ProcessId} from "../process/process.ts";

export type {ReplyTo};

/**
 * A port of some other process, addressed. A process id arrives on `spawned`; the author never
 * mints one, and nothing here matches one against a reply.
 */
export interface PortAddress {
	readonly process: ProcessId;
	readonly port: string;
}

/**
 * What `spawn` needs of the thing it starts: the program the registry will resolve, plus the
 * out-ports it declares. `Program.shape({in, out})` (#8729) satisfies this structurally, so a
 * program-valued arg is spawnable with no import of the program's own package.
 */
export interface Spawnable<Out extends string = string> {
	readonly programId: string;
	readonly out: Readonly<Record<Out, unknown>>;
}

/** Which of my events a child's out-port arrives as. Keys are the child's ports, values my events. */
export type ChildRouting<Out extends string = string, Event extends string = string> = {
	readonly [P in Out]?: Event;
};

export interface SpawnEffect<Out extends string = string, Event extends string = string> {
	readonly type: "spawn";
	readonly program: string;
	readonly on: ChildRouting<Out, Event>;
}

/**
 * Where a `send` lands. A `PortAddress` is another process's port, named in full. A bare string is
 * an in-port of the **declaring program's own** process, and it is a command's form alone (ADR
 * 0372, amended for #8898): an `update` cell already runs under a process and reaches its own
 * out-ports with `emit`, while a command runs under a `Scope` whose `process` is the *caller's*.
 * Which process of the declaring program a bare name lands on is resolved at the call
 * (`./own-process.ts`) and is never carried by the effect.
 */
export type SendTarget = PortAddress | string;

/**
 * One payload, one target. The parameter is what keeps the bare form out of an `update` cell: it
 * defaults to the addressed form, so `send("pr", pr)` — a `SendEffect<"pr">` — is assignable to a
 * command's answer and to nothing an `update` cell may return.
 */
export interface SendEffect<To extends SendTarget = PortAddress> {
	readonly type: "send";
	readonly to: To;
	readonly payload: unknown;
}

export interface AskEffect<Event extends string = string> {
	readonly type: "ask";
	readonly to: PortAddress;
	readonly payload: unknown;
	readonly reply: Event;
}

/**
 * The callee's half of `ask` (#8716 R17.1): answer the question this process was asked. `to` is the
 * bound `reply` its request-port arrival carried — an opaque address the kernel minted — so a
 * program answers the caller it was asked by without ever naming one.
 */
export interface ReplyEffect {
	readonly type: "reply";
	readonly to: ReplyTo;
	readonly payload: unknown;
}

export interface EmitEffect<Port extends string = string> {
	readonly type: "emit";
	readonly port: Port;
	readonly payload: unknown;
}

export interface StopEffect {
	readonly type: "stop";
	readonly process: ProcessId;
}

export type ProgramEffect =
	| SpawnEffect
	| SendEffect
	| AskEffect
	| ReplyEffect
	| EmitEffect
	| StopEffect;

/**
 * Every effect either authoring surface may ask for: an `update` cell's six, plus the one extra
 * shape a `commands` cell has — a `send` at a bare port of its own program (`./commands.ts`).
 * Written for the helpers that hold both, `./test-program.ts` above all; neither surface takes it.
 */
export type AnyEffect = ProgramEffect | SendEffect<SendTarget>;

/** Start a process of `program`, routing the child's out-ports back into my own events. */
export const spawn = <Out extends string, Event extends string>(
	program: Spawnable<Out>,
	options?: {readonly on: ChildRouting<Out, Event>},
): SpawnEffect<Out, Event> => ({
	type: "spawn",
	program: program.programId,
	on: options?.on ?? {},
});

/**
 * Put a payload on an in-port: another process's, addressed in full, or — from a `commands` cell —
 * one of the declaring program's own, named by the port alone (`SendTarget`).
 *
 * Generic rather than overloaded so the target type survives to the answer: `send("pr", pr)` is a
 * `SendEffect<"pr">`, which an `update` cell's `ReadonlyArray<ProgramEffect>` refuses at the line
 * that wrote it.
 */
export const send = <To extends SendTarget>(to: To, payload: unknown): SendEffect<To> => ({
	type: "send",
	to,
	payload,
});

/**
 * Ask another process's `request` port one question. `reply` is the correlation: the answer
 * arrives as that event of mine, and the id it rides on is the interpreter's business.
 */
export const ask = <Event extends string>(
	to: PortAddress,
	payload: unknown,
	options: {readonly reply: Event},
): AskEffect<Event> => ({type: "ask", to, payload, reply: options.reply});

/** Answer the `ask` whose arrival carried `to`. Spending one twice is refused, not doubled. */
export const reply = (to: ReplyTo, payload: unknown): ReplyEffect => ({type: "reply", to, payload});

/** Announce on one of my own out-ports. An `update` cell's alone: a command may not (ADR 0372). */
export const emit = <Port extends string>(port: Port, payload: unknown): EmitEffect<Port> => ({
	type: "emit",
	port,
	payload,
});

/** End a process I started. It answers nothing; the `stopped` below is what arrives when it ends. */
export const stop = (process: ProcessId): StopEffect => ({type: "stop", process});

/** The event a `spawn` answers with: the new process, and which program it runs. */
export interface Spawned {
	readonly type: "spawned";
	readonly process: ProcessId;
	readonly program: string;
}

/**
 * A child of this process has ended — whether this process stopped it or it ended on its own. One
 * event per child end, produced in one place: the finalizer `SpawnedProcesses.spawn` hangs on the
 * child's Scope (`../commands/core/process.ts`, #9227). Because `stop` answers nothing, a cell that
 * issued one hears back here like any other ending, on a later dispatch rather than as its own
 * fold's answer — so an author's `stopped` cell never has to tell the two endings apart.
 */
export interface Stopped {
	readonly type: "stopped";
	readonly process: ProcessId;
}

export type AnswerEvent = Spawned | Stopped;

/** The event an `ask` is answered by, named by that `ask`'s own `reply`. */
export type Reply<Event extends string = string, Payload = unknown> = {
	readonly type: Event;
	readonly payload: Payload;
};

export const spawned = (process: ProcessId, program: string): Spawned => ({
	type: "spawned",
	process,
	program,
});

export const stopped = (process: ProcessId): Stopped => ({type: "stopped", process});
