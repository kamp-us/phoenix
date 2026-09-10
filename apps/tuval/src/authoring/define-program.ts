/**
 * The spine of the authoring layer: `defineProgram` takes what a user writes — an id, ports,
 * `init`, an `update` table and Demlik's dep-keyed `subs` — and answers a registry row
 * (`../registry/program.ts`) the kernel already knows how to launch, wire, checkpoint, restore,
 * reload, pick and window. It is a compiler, not a runtime: nothing here runs a program.
 *
 * Two things it exists to hide (#8716 R12.1). An in-port arrival is an `update` event carrying the
 * decoded payload, which is the row's `receive` map written for the author. A returned effect list
 * (`./effect.ts`) is the row's Cmd union, and the `handlers` that run those Cmds against
 * `ProcessPorts` and the process spells are written once here rather than by every author — as is
 * the dead `interpret` Demlik demands and the host never reads (#7576).
 *
 * **`FIELD_COMPILERS` is the extension seam this epic's field children share.** One row field per
 * key, one key per line: `commands`, the `key` opt-in and the `title`/`status`/`window` children
 * each add their own line and none edits another's; `define-program.unit.test.ts` holds that shape.
 *
 * Everything the layer does not sugar is still reachable, because the row is a plain object:
 * `{...defineProgram({...}), restorable, checkpointWorthy}`.
 */

import type {DepKeyedSub, Interpret} from "@demlik/tea";
import {Effect, Option} from "effect";
import type {
	PortAnswersNothing,
	PortRefused,
	UnclaimedReply,
	UnknownPort,
	UnknownProcess,
	UnknownProgram,
} from "../commands/core/process.ts";
import {SpawnedProcesses} from "../commands/core/process.ts";
import type {OpenError} from "../durability/Checkpoints.ts";
import type {PayloadRejected, PortNotWired} from "../ports/errors.ts";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import type {HandlerFailed, ProcessNotFound} from "../process/errors.ts";
import {isAsked, NO_REPLY, type ReplyTo} from "../process/inbox.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessSelf} from "../process/self.ts";
import type {
	AnyProgram,
	CapabilityRequest,
	DefinitionIdentity,
	HostHandlers,
	Placement,
	PortSchema,
	ProgramCore,
	Receiver,
} from "../registry/program.ts";
import {ProgramId} from "../registry/program.ts";
import {type AnyArgRefs, argKeys} from "./args.ts";
import {
	type CommandArgTypes,
	type CommandHandlers,
	type CommandTable,
	compileCommands,
} from "./commands.ts";
import {
	type AskEffect,
	type EmitEffect,
	type ProgramEffect,
	type ReplyEffect,
	type SendEffect,
	type SpawnEffect,
	type StopEffect,
	spawned,
	stopped,
} from "./effect.ts";
import {compileTakesKeys, type KEY_EVENT, type KeyEvent} from "./keys.ts";
import {
	type AnyPortDecl,
	compilePorts,
	type OutPortDecl,
	type PortDecls,
	type PortPayload,
	type RequestPortDecl,
} from "./port.ts";
import {
	type AuthoredWindow,
	compileWindow,
	type DerivedLine,
	initialSelfReport,
	isSelfReportPort,
	selfReportPorts,
	withSelfReport,
} from "./view.ts";

/** Every event an authored `update` may hold a cell for carries its own type tag, as a Msg does. */
export interface AuthoredEvent {
	readonly type: string;
}

/** What one `update` cell answers: the next state, and the effects it asks for. */
export type Answer<S> = readonly [S, ReadonlyArray<ProgramEffect>];

export type EventHandler<S, E> = (state: S, event: E) => Answer<S>;

/** An in-port arrival as the author's `update` sees it: the port's name, its decoded payload. */
export interface ArrivalEvent<Name extends string, Payload> {
	readonly type: Name;
	readonly payload: Payload;
}

/**
 * A `port.request` arrival: the same event as any other, plus the bound `reply` the caller's `ask`
 * is waiting on (#8716 R17.1). The address is opaque and belongs to this one question, so the cell
 * answers by handing it back to `reply(event.reply, answer)` and names no process.
 */
export interface RequestArrivalEvent<Name extends string, Payload>
	extends ArrivalEvent<Name, Payload> {
	readonly reply: ReplyTo;
}

/** What arrives on one declared port, which is the request kind's arrival for a request port. */
export type ArrivalEventOf<D extends PortDecls, K extends keyof D & string> =
	D[K] extends RequestPortDecl<any, any>
		? RequestArrivalEvent<K, PortPayload<D[K]>>
		: ArrivalEvent<K, PortPayload<D[K]>>;

/** The declared ports that own a queue — `in` and `request` — which are the ones that arrive. */
export type ArrivingPortNames<D extends PortDecls> = {
	[K in keyof D]: D[K] extends OutPortDecl<any> ? never : K;
}[keyof D] &
	string;

/**
 * The author's `update`: a cell per event, keyed by the event's type. Every arriving port owes one
 * and gets that port's decoded payload; the author's own events take the cells beside them, and a
 * `key` cell — optional, and the whole keyboard opt-in (`./keys.ts`) — gets the forwarded keystroke.
 *
 * One mapped type over `keyof U | <arriving ports>` rather than an intersection of the two halves,
 * because an intersection whose other half is an index signature contextually types every cell's
 * event at `any` — including the port cells, which is exactly the inference this layer exists for.
 * Measured at this pin: under the intersection a port cell's `event` accepted a `string`.
 */
export type UpdateTable<S, D extends PortDecls, U> = {
	[K in keyof U | ArrivingPortNames<D>]: K extends typeof KEY_EVENT
		? EventHandler<S, KeyEvent>
		: K extends ArrivingPortNames<D>
			? EventHandler<S, ArrivalEventOf<D, K & keyof D & string>>
			: EventHandler<S, any>;
};

/** What a user writes. Nothing on it names Demlik, Effect, Scope or the row's seven generics. */
export interface AuthoredProgram<
	S,
	D extends PortDecls,
	U,
	C extends CommandArgTypes = Record<string, never>,
	Out = unknown,
> {
	readonly id: string;
	/** What a surface calls this program; absent falls through to `identity.program`. */
	readonly label?: string;
	readonly ports?: D;
	/**
	 * The state a fresh process starts on. A restored one starts on its checkpoint instead, which
	 * is why this takes nothing: Demlik refuses a rehydrating `init` that emits Cmds, so the
	 * compiled `init` answers the loaded state untouched whenever there is one.
	 */
	readonly init: () => S;
	readonly update: U & UpdateTable<S, D, U>;
	/** The args the config hands a process, as `programArgs` declared them (`./args.ts`). */
	readonly args?: AnyArgRefs;
	/**
	 * The commands this program offers, compiled into the row's spells (`./commands.ts`). The key
	 * is the command's own path and never carries a prefix: the group is the program id, and the
	 * spell registry composes it from the row's id (#8716 R16.1).
	 */
	readonly commands?: CommandTable<C>;
	/**
	 * One line saying what this program is, off its state. Compiled onto the kernel's `title@1`
	 * out-port and emitted on every transition that moves it (`./view.ts`).
	 */
	readonly title?: DerivedLine<S>;
	/** One short line saying how it is doing, on `status@1`, by the same rule. */
	readonly status?: DerivedLine<S>;
	/** This program's window, as a function of its own state and a `send` into its own events. */
	readonly window?: AuthoredWindow<S, D, U, Out>;
	/** Demlik's own dep-keyed Subs, taken as the row's core already takes them. */
	readonly subs?: ReadonlyArray<DepKeyedSub<S, AuthoredEvent, unknown>>;
	/**
	 * The three inert records, each defaulted so an author writes none of them. They are data the
	 * kernel stores and enforces nothing on (`../registry/program.ts` says so at length), so a
	 * default here grants nothing that a hand-written row would not have granted.
	 */
	readonly capabilities?: ReadonlyArray<CapabilityRequest>;
	readonly identity?: Partial<DefinitionIdentity>;
	readonly placement?: Placement;
}

export type AnyAuthoredProgram = AuthoredProgram<any, any, any, any>;

/** What every field compiler is handed beside the authored record: the id and the compiled ports. */
export interface CompileContext {
	readonly id: ProgramId;
	readonly ports: Readonly<Record<string, PortSchema>>;
}

/**
 * One row field, compiled. `undefined` leaves the field off the row entirely, which is how an
 * optional field a program did not ask for stays absent rather than present-and-empty.
 */
export type FieldCompiler<K extends keyof AnyProgram> = (
	authored: AnyAuthoredProgram,
	context: CompileContext,
) => AnyProgram[K] | undefined;

export type FieldCompilers = {readonly [K in keyof AnyProgram]?: FieldCompiler<K>};

const NO_EFFECTS: ReadonlyArray<ProgramEffect> = [];
const NO_EVENTS: ReadonlyArray<AuthoredEvent> = [];
const NO_CAPABILITIES: ReadonlyArray<CapabilityRequest> = [];
const LOCAL: Placement = {host: "local"};

/**
 * The identity an authored program takes when it states none. Inert data, so the defaults only
 * have to be honest about what they are: this app's own package, the program's own id, and a
 * digest that says the row was compiled here rather than pretending to hash any bytes.
 */
const defaultIdentity = (id: string): DefinitionIdentity => ({
	package: "@kampus/tuval",
	program: id,
	version: "0.0.0",
	digest: `authored:${id}`,
});

/** Does this port arrive? `out` is a name routes leave from and owns no queue, so it never does. */
const arrives = (decl: AnyPortDecl): boolean => decl.direction !== "out";

const arrivingPorts = (authored: AnyAuthoredProgram): ReadonlyArray<string> =>
	Object.entries(authored.ports ?? {})
		.filter(([, decl]) => arrives(decl as AnyPortDecl))
		.map(([name]) => name);

/**
 * The six effect handlers, written once. Each answers the events its effect produces: `emit` and
 * `send` announce nothing back, `spawn` answers `spawned` and `stop` answers `stopped`. A command
 * reaches five of them; `emit` is an `update` cell's alone (ADR 0372).
 */
const emitHandler = (cmd: EmitEffect) =>
	Effect.gen(function* () {
		const ports = yield* ProcessPorts;
		yield* ports.emit(cmd.port, cmd.payload);
		return NO_EVENTS;
	}).pipe(
		// A derived title or status published to nobody is not a failure: a headless process is a
		// whole process (#7557), and the kernel latches the line before delivery either way
		// (`../process/self-report.ts`). An authored `emit` keeps #7789's loudness.
		Effect.catchTag("tuval/ports/PortNotWired", (failure) =>
			isSelfReportPort(cmd.port) ? Effect.succeed(NO_EVENTS) : Effect.fail(failure),
		),
	);

const spawnHandler = (cmd: SpawnEffect) =>
	Effect.gen(function* () {
		const processes = yield* SpawnedProcesses;
		const self = yield* ProcessSelf;
		// The parent is stamped here, off the process this interpretation is running for, and is
		// never something the `spawn` effect carries (#8757). `on` rides along as that same
		// process's routing table, so a named child port arrives as this process's own event.
		const child = yield* processes.spawn(ProgramId.make(cmd.program), Option.some(self.id), cmd.on);
		return [spawned(child, cmd.program)];
	});

const sendHandler = (cmd: SendEffect) =>
	Effect.gen(function* () {
		const processes = yield* SpawnedProcesses;
		yield* processes.send(cmd.to.process, cmd.to.port, cmd.payload);
		return NO_EVENTS;
	});

/**
 * An `ask` delivers on the target's request port and hands the kernel the return address: this
 * process, and the event name the `ask` itself declared as its correlation. When the callee answers,
 * the kernel dispatches `{type: cmd.reply, payload}` — the `Reply` of `./effect.ts` — into this
 * process's inbox (`../process/inbox.ts`), so nothing here waits and nothing is matched by hand.
 */
const askHandler = (cmd: AskEffect) =>
	Effect.gen(function* () {
		const processes = yield* SpawnedProcesses;
		const self = yield* ProcessSelf;
		yield* processes.ask(self.id, cmd.to.process, cmd.to.port, cmd.payload, cmd.reply);
		return NO_EVENTS;
	});

/** The callee's half: spend the bound `reply` its request-port arrival carried. */
const replyHandler = (cmd: ReplyEffect) =>
	Effect.gen(function* () {
		const processes = yield* SpawnedProcesses;
		yield* processes.answer(cmd.to, cmd.payload);
		return NO_EVENTS;
	});

const stopHandler = (cmd: StopEffect) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		yield* processes.stop(cmd.process);
		return [stopped(cmd.process)];
	});

/** Everything an authored program's effects can fail with, gathered off the services they run on. */
export type EffectFailure =
	| PayloadRejected
	| PortNotWired
	| UnknownProgram
	| UnknownProcess
	| UnknownPort
	| PortAnswersNothing
	| UnclaimedReply
	| PortRefused
	| OpenError
	| HandlerFailed
	| ProcessNotFound;

export type EffectServices = ProcessPorts | ProcessSelf | SpawnedProcesses | Processes;

const HANDLERS: HostHandlers<AuthoredEvent, ProgramEffect, EffectFailure, EffectServices> = {
	emit: emitHandler,
	spawn: spawnHandler,
	send: sendHandler,
	ask: askHandler,
	reply: replyHandler,
	stop: stopHandler,
};

/**
 * What a compiled command needs — `EffectServices` without `ProcessPorts`, because a command may
 * not declare `emit` (ADR 0372) and `emitHandler` is the only reader of that service.
 */
export type CommandEffectServices = ProcessSelf | SpawnedProcesses | Processes;

/** The same handlers minus `emit`, so no command's spell can reach a process out-port. */
const COMMAND_HANDLERS: CommandHandlers<EffectFailure, CommandEffectServices> = {
	spawn: spawnHandler,
	send: sendHandler,
	ask: askHandler,
	reply: replyHandler,
	stop: stopHandler,
};

/** Demlik demands a Promise `interpret` beside the row's `handlers`; the host never reads it (#7576). */
const dead = (): Promise<void> => Promise.resolve();

const INTERPRET: Interpret<AuthoredEvent, ProgramEffect, unknown> = {
	emit: dead,
	spawn: dead,
	send: dead,
	ask: dead,
	reply: dead,
	stop: dead,
};

const compileCore = (authored: AnyAuthoredProgram): ProgramCore<any, any, any, any, any> => ({
	// A loaded state is answered untouched and with no Cmds, which is Demlik's rehydrate contract —
	// so a fresh boot is the only place a derived line may be published from `init` (`./view.ts`),
	// and a restored process republishes on its first transition instead.
	init: (loaded: unknown) => {
		if (loaded !== null && loaded !== undefined) return [loaded, NO_EFFECTS];
		const initial = authored.init();
		return [initial, initialSelfReport(authored, initial)];
	},
	update: withSelfReport(authored, authored.update),
	...(authored.subs === undefined ? {} : {subs: authored.subs}),
	interpret: INTERPRET,
});

/**
 * A receiver per arriving port, so launch can never refuse a compiled row for a missing one. The
 * payload crossed the wire as `unknown` and the port's own `accepts` ran before it was enqueued,
 * so what lands here already fits the schema the author declared.
 *
 * A request port's arrival is the one that carries more than the payload: an `ask` enqueues the
 * kernel's envelope, and this unwraps it into the bound `reply` the cell answers with. A plain
 * `send` can reach a request port too — nothing forbids it — and that arrival carries `NO_REPLY`,
 * so answering it is refused loudly rather than addressed at a caller who never asked.
 */
const receiverFor = (name: string, decl: AnyPortDecl): Receiver<AuthoredEvent> =>
	decl.direction === "request"
		? (payload: unknown) =>
				isAsked(payload)
					? ({
							type: name,
							payload: payload.payload,
							reply: payload.reply,
						} satisfies RequestArrivalEvent<string, unknown>)
					: ({type: name, payload, reply: NO_REPLY} satisfies RequestArrivalEvent<string, unknown>)
		: (payload: unknown) => ({type: name, payload}) satisfies ArrivalEvent<string, unknown>;

const compileReceive = (
	authored: AnyAuthoredProgram,
): Readonly<Record<string, Receiver<AuthoredEvent>>> =>
	Object.fromEntries(
		arrivingPorts(authored).map((name) => [
			name,
			receiverFor(name, (authored.ports ?? {})[name] as AnyPortDecl),
		]),
	);

const compileIdentity = (authored: AnyAuthoredProgram): DefinitionIdentity => ({
	...defaultIdentity(authored.id),
	...authored.identity,
});

/**
 * The seam. One row field per key, one key per line: a field child of #8716 adds its line here and
 * its own module beside this one, and edits nothing another child wrote.
 */
export const FIELD_COMPILERS = {
	id: (_authored, context) => context.id,
	label: (authored) => authored.label,
	core: (authored) => compileCore(authored),
	ports: (_authored, context) => context.ports,
	receive: (authored) => compileReceive(authored),
	handlers: () => HANDLERS,
	args: (authored) => (authored.args === undefined ? undefined : argKeys(authored.args)),
	spells: (authored) => compileCommands(authored.commands, COMMAND_HANDLERS),
	takesKeys: (authored) => compileTakesKeys(authored),
	renderer: (authored, context) => compileWindow(authored, context),
	capabilities: (authored) => authored.capabilities ?? NO_CAPABILITIES,
	identity: (authored) => compileIdentity(authored),
	placement: (authored) => authored.placement ?? LOCAL,
} satisfies FieldCompilers;

/**
 * Compile one authored program into the registry row. The row is a plain object, so every field
 * this layer does not sugar is still reachable by spread.
 */
export const defineProgram = <
	S,
	D extends PortDecls = Record<string, never>,
	U = unknown,
	C extends CommandArgTypes = Record<string, never>,
	Out = unknown,
>(
	authored: AuthoredProgram<S, D, U, C, Out>,
): AnyProgram => {
	const id = ProgramId.make(authored.id);
	const context: CompileContext = {
		id,
		ports: {...compilePorts(id, authored.ports ?? {}), ...selfReportPorts(authored)},
	};
	// The record above proved each field's type one key at a time; iterating it erases them, which
	// is what the closing cast buys back.
	const compilers = Object.entries(FIELD_COMPILERS) as ReadonlyArray<
		readonly [string, (authored: AnyAuthoredProgram, context: CompileContext) => unknown]
	>;
	const row: Partial<AnyProgram> & Record<string, unknown> = {};
	for (const [field, compile] of compilers) {
		const value = compile(authored, context);
		if (value !== undefined) row[field] = value;
	}
	return row as AnyProgram;
};
