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
 * `{...defineProgram({...}), restorable, checkpointWorthy}`. `configChanged` is one of those, and
 * deliberately so — `./resume.ts` says why the reload half stays a spread while `resume` does not.
 *
 * **The other half of R12.1 — an effect of the author's own — is the `X` generic (#9294).** The six
 * kernel effects are what a program gets for free; a program that has real work to do names its own
 * effect type as `defineProgram`'s last type argument, answers it from an `update` cell like any
 * other, and supplies the handler that runs it by spreading the compiled row:
 * `{...defineProgram(authored), handlers: {...row.handlers, run}}`. `X` defaults to `never`, so a
 * program that names none is typed exactly as it was and a typo'd effect is still refused at
 * compile. `handlers` is where the handler comes from — this compiler cannot see one added after
 * the spread, so it refuses nothing at definition time; an effect the row has no handler for is
 * skipped by the actor (`../host/actor.ts`), which is the same silence a hand-assembled row has
 * always had for the same mistake.
 */

import type {DepKeyedSub, Interpret} from "@demlik/tea";
import {Context, Effect, Option, Result} from "effect";
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
import {
	type AnyArgRefs,
	type ArgUnfilled,
	argContext,
	argKeys,
	resolveSpawnTarget,
} from "./args.ts";
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
import {type AuthoredResume, compileResume} from "./resume.ts";
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

/**
 * What one `update` cell answers: the next state, and the effects it asks for.
 *
 * `X` is the author's own effect type, and it defaults to `never` — so a program that names none
 * answers the six kernel effects and nothing else, and a typo'd effect is still refused at compile
 * (#9294). A program that opts in names its type once, on its `update` table's cells or on
 * `defineProgram`, and supplies the handler for it by spreading the compiled row; the seam is
 * written out on `defineProgram` below.
 */
export type Answer<S, X = never> = readonly [S, ReadonlyArray<ProgramEffect | X>];

export type EventHandler<S, E, X = never> = (state: S, event: E) => Answer<S, X>;

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
export type UpdateTable<S, D extends PortDecls, U, X = never> = {
	[K in keyof U | ArrivingPortNames<D>]: K extends typeof KEY_EVENT
		? EventHandler<S, KeyEvent, X>
		: K extends ArrivingPortNames<D>
			? EventHandler<S, ArrivalEventOf<D, K & keyof D & string>, X>
			: EventHandler<S, any, X>;
};

/** What a user writes. Nothing on it names Demlik, Effect, Scope or the row's seven generics. */
export interface AuthoredProgram<
	S,
	D extends PortDecls,
	U,
	C extends CommandArgTypes = Record<string, never>,
	Out = unknown,
	X = never,
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
	readonly update: U & UpdateTable<S, D, U, X>;
	/** The args the config hands a process, as `programArgs` declared them (`./args.ts`). */
	readonly args?: AnyArgRefs;
	/**
	 * What *this* registration hands those args — the config call's half of `args`. Every
	 * program-valued value is checked against its declared shape here, at definition time, and a
	 * mismatch refuses on the spot rather than at the process that would have spawned it; what
	 * passes becomes the `Context` this row's handlers read an arg back through, which is how a
	 * `spawn` on a shaped arg reaches the program the config chose (#8762).
	 *
	 * A row that states none still compiles — a program is registered once per fill, and a
	 * registration with nothing to give says so by leaving this off. Its handlers then refuse a
	 * spawn on an unfilled arg at the spawn (`ArgUnfilled`) rather than silently naming the key.
	 *
	 * Typed as a plain record: `args` has already erased the declarations its refs were built
	 * from, so there is nothing on this record for the checker to hold a fill against (#8954).
	 */
	readonly fill?: Readonly<Record<string, unknown>>;
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
	/**
	 * What this program is sent when it comes back from a checkpoint (`./resume.ts`). A restored
	 * process starts on its loaded state with no Cmds, so this is its only way back into the world.
	 */
	readonly resume?: AuthoredResume<S, U>;
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

export type AnyAuthoredProgram = AuthoredProgram<any, any, any, any, any, any>;

/**
 * `program({...})` — hold an authored program in a binding and keep every type this layer infers
 * (#8825).
 *
 * TypeScript contextually types an object literal from what it is passed to, and a `const` passes
 * it to nothing. So the record an author has to keep — the config compiles it with `defineProgram`,
 * a test drives it with `testProgram` — lost the whole of R12.1 at the binding: each `update`
 * cell's `(state, event)` became an implicit `any` under `strict`, and each cell's returned array
 * widened to `T[]` instead of fitting the `Answer<S>` tuple. The author's only fix was writing
 * `pr: (state: State, event: ArrivalEvent<"pr", number>): Answer<State> => [...]` on every cell.
 *
 * This is the call site that was missing. It runs nothing and changes nothing — it answers its
 * argument — so the parameter's type is the entire mechanism: `AuthoredProgram<S, D, U, C, Out, X>`
 * is what contextually types the literal, and the same generics that make `defineProgram` infer a
 * cell's event from the port that feeds it make this infer it too.
 *
 * **It was picked over widening `defineProgram`'s row to carry its authored record beside it**
 * because the row is not where the inference dies. An author who spreads the record — the worked
 * example's `{...prReviewProgram, fill, label}` (`./example/pr-review.ts`) — still holds the
 * literal in a `const` no matter what `defineProgram` answers, so a wider row would have left that
 * binding un-typed and bought a second shape on every compiled row for it.
 *
 * **The name is one word on purpose, and it sits one capital letter from `Program.shape`**
 * (`./shape.ts`) in the barrel's import list. That is close, and it was still the right trade: the
 * worked example's line budget (`./example/pr-review.ts`, #8716 R11.1) is a ruled number, and a
 * longer name pushes its single import line past the formatter's width, which costs the example
 * eight wrapped lines and breaks the ceiling. The two read differently at every use anyway —
 * `Program.shape({...})` declares the ports a program is *named by*, `program({...})` holds the
 * program itself.
 *
 * **`A` is why the answer is the literal the author wrote and not the interface.** Every field this
 * layer does not require is optional on `AuthoredProgram`, so answering that interface flat would
 * hand back a `ports`, `commands` and `title` that are all possibly-`undefined` — a binding worse
 * to read than the one it replaces. Taking the argument as `A & AuthoredProgram<…>` infers both
 * halves from the one literal: the intersection's second member is the inference site for `S`, `D`,
 * `U`, `C`, `Out` and the contextual type the cells are written against, while `A` captures the
 * literal's own shape and carries the present fields through. A plain `A extends AuthoredProgram<…>`
 * does not work — measured at this pin, constraint-only inference leaves `S`, `D` and `U` on their
 * defaults, and every cell is an implicit `any` again.
 *
 * `X` — the author's own effect type — is no more inferrable here than at `defineProgram`, and for
 * the same reason (#9294): it is named only in a cell's answer, and `update`'s mapped table is not
 * an inference site. A program that opts in states its arguments once, here instead of there.
 */
export const program = <
	S,
	D extends PortDecls = Record<string, never>,
	U = unknown,
	C extends CommandArgTypes = Record<string, never>,
	Out = unknown,
	X = never,
	A = unknown,
>(
	authored: A & AuthoredProgram<S, D, U, C, Out, X>,
): A & AuthoredProgram<S, D, U, C, Out, X> => authored;

/** What every field compiler is handed beside the authored record: the id and the compiled ports. */
export interface CompileContext {
	readonly id: ProgramId;
	readonly ports: Readonly<Record<string, PortSchema>>;
	/** What this registration filled its args with, as the row's handlers read them back (#8762). */
	readonly args: Context.Context<never>;
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
 * The six effect handlers, written once. Each answers the events its effect produces: `spawn`
 * answers `spawned`, and `emit`, `send` and `stop` announce nothing back. A command reaches exactly
 * one of them — `send`; the other five are an `update` cell's alone (ADR 0372, as the rulings on
 * #8898 and #8858 amended it).
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
		// What the author wrote `spawn` against is a program id or a program-valued arg's own
		// service key, and only the second needs answering: the key is read back through this
		// handler's `R`, where the row's fill put the program the config chose, so the registry is
		// only ever asked for a real id and both cases take this one line (#8762). The `spawned`
		// event carries the same resolved id, so the author's `update` reads what actually started.
		const program = yield* resolveSpawnTarget(cmd.program);
		// The parent is stamped here, off the process this interpretation is running for, and is
		// never something the `spawn` effect carries (#8757). `on` rides along as that same
		// process's routing table, so a named child port arrives as this process's own event.
		const child = yield* processes.spawn(ProgramId.make(program), Option.some(self.id), cmd.on);
		return [spawned(child, program)];
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

/**
 * End the named process, and answer nothing (#9227). `stopped` still arrives — it is delivered by
 * the child's own exit, from the finalizer `SpawnedProcesses.spawn` hung on it
 * (`../commands/core/process.ts`), which is now the single producer of that event.
 *
 * It used to be produced here as well, and two producers meant a child that ended by itself
 * produced none at all: the answer to the parent's own `stop` was the only `stopped` an author could
 * ever see, so an unsolicited exit was silently absorbed. Returning it here *and* delivering it would
 * have made the parent-issued case two events for one child end. One producer, on the edge that
 * actually happens, makes both of those unwritable rather than guarded against.
 *
 * The cost is that the event is no longer this fold's answer: it arrives as a later dispatch. An
 * author reading `stopped` sees the same event for both endings and cannot tell which asked for it,
 * which is the point — a `stop` a cell issued has already moved that cell's state.
 */
const stopHandler = (cmd: StopEffect) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		yield* processes.stop(cmd.process);
		return NO_EVENTS;
	});

/** Everything an authored program's effects can fail with, gathered off the services they run on. */
export type EffectFailure =
	| ArgUnfilled
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
 * What a compiled command needs: `SpawnedProcesses`, and that is the whole list. A command may
 * declare only `send` (ADR 0372 as the rulings on #8898 and #8858 amended it), and `sendHandler` is
 * the only handler it can reach — so the two services `Kernel` (`../boot.ts`) does not name,
 * `ProcessPorts` (read by `emitHandler`) and `ProcessSelf` (read by `spawnHandler` and
 * `askHandler`), are unreachable from a spell rather than merely unused by one.
 *
 * Written as an `Extract` off `EffectServices` rather than as the bare service, so it stays in
 * lockstep with the spine's set instead of drifting from it.
 */
export type CommandEffectServices = Extract<EffectServices, SpawnedProcesses>;

/**
 * The one handler a command reaches. `compileCommands` adds `ProcessTable` to what the compiled
 * spell requires, because resolving a bare port name to a process of the declaring program is a
 * read of the live set (`./own-process.ts`); `Kernel` already names that service.
 */
const COMMAND_HANDLERS: CommandHandlers<EffectFailure, CommandEffectServices> = {
	send: sendHandler,
};

/**
 * Put this row's filled args into what its handlers resolve. Merged onto the ambient context
 * rather than replacing it, because the kernel seals a handler to the spawner's own services
 * (`../process/Processes.ts`) and this runs inside that seal — a fill adds arg keys and takes
 * nothing away.
 *
 * Every handler is bound, not only `spawn`: an arg is read through `R` and which handler reads
 * which arg is the author's business. A row whose registration filled nothing keeps the shared
 * record, so the common program compiles to the same handlers it did before args existed.
 */
type AnyHandlers = Readonly<Record<string, (cmd: never) => Effect.Effect<any, any, any>>>;

const bindArgs = <H extends AnyHandlers>(handlers: H, args: Context.Context<never>): H =>
	args.mapUnsafe.size === 0
		? handlers
		: (Object.fromEntries(
				Object.entries(handlers as AnyHandlers).map(([type, run]) => [
					type,
					(cmd: never) =>
						Effect.updateContext(run(cmd), (ambient: Context.Context<unknown>) =>
							Context.merge(ambient, args),
						),
				]),
				// One wrapper per key, each at the handler's own Cmd type; iterating the record erases
				// that correspondence, which is what this cast buys back.
			) as H);

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

/**
 * A command's spell runs its one effect on the same filled args an `update` cell's effects read, so
 * it is bound the same way (#8762) — `send` reads no arg today, and binding the record rather than
 * the handler that happens to need one keeps the two paths in lockstep.
 *
 * The program id goes in beside them: a bare port name in a command resolves against the live
 * processes of the *declaring* program (`./own-process.ts`), which is a fact of the registration
 * rather than of the call, so the compile site is the only place that knows it.
 */
const compileSpells = (authored: AnyAuthoredProgram, context: CompileContext) =>
	compileCommands(context.id, authored.commands, bindArgs(COMMAND_HANDLERS, context.args));

/**
 * What this registration filled its args with. Refused here, at definition time, where the config
 * that got it wrong is the only thing on the stack: `defineProgram` answers a plain row rather than
 * an Effect, so a `ShapeMismatch` has no channel to fail on and `./commands.ts` refuses a malformed
 * command name the same way. The error thrown is the `ShapeMismatch` itself, which names the arg,
 * the program and the port that did not fit.
 */
const filledArgs = (authored: AnyAuthoredProgram): Context.Context<never> => {
	if (authored.args === undefined || authored.fill === undefined) return Context.empty();
	const filled = argContext(authored.args, authored.fill as never);
	if (Result.isFailure(filled)) throw filled.failure;
	return filled.success as Context.Context<never>;
};

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
	handlers: (_authored, context) => bindArgs(HANDLERS, context.args),
	args: (authored) => (authored.args === undefined ? undefined : argKeys(authored.args)),
	spells: (authored, context) => compileSpells(authored, context),
	takesKeys: (authored) => compileTakesKeys(authored),
	resume: (authored) => compileResume(authored),
	renderer: (authored, context) => compileWindow(authored, context),
	capabilities: (authored) => authored.capabilities ?? NO_CAPABILITIES,
	identity: (authored) => compileIdentity(authored),
	placement: (authored) => authored.placement ?? LOCAL,
} satisfies FieldCompilers;

/**
 * Compile one authored program into the registry row. The row is a plain object, so every field
 * this layer does not sugar is still reachable by spread.
 *
 * `X` — the author's own effect type — is the one type argument inference cannot reach: it is named
 * only in a cell's *answer*, and `update`'s mapped table is not an inference site. A program that
 * opts in therefore states the whole list once, over an `update` table declared beside the call:
 *
 * ```ts
 * const update = {go: (s: State): Answer<State, Run> => [s, [run("ls")]]};
 * const row = defineProgram<State, typeof ports, typeof update, Commands, unknown, Run>({…});
 * const program = {...row, handlers: {...row.handlers, run: runHandler}};
 * ```
 *
 * A program that names none writes none of that: every argument keeps its default, `X` is `never`,
 * and the answer is the six kernel effects as before (#9294).
 */
export const defineProgram = <
	S,
	D extends PortDecls = Record<string, never>,
	U = unknown,
	C extends CommandArgTypes = Record<string, never>,
	Out = unknown,
	X = never,
>(
	authored: AuthoredProgram<S, D, U, C, Out, X>,
): AnyProgram => {
	const id = ProgramId.make(authored.id);
	const context: CompileContext = {
		id,
		ports: {...compilePorts(id, authored.ports ?? {}), ...selfReportPorts(authored)},
		args: filledArgs(authored),
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
