/**
 * The three process spells — `process spawn`, `process send`, `process read` — and the retained
 * handles under them (#7617 R2.4). These are the generic tools an AI agent program calls, written
 * once for every program: nothing here names a program, and a new agent costs an adapter and no
 * new spell (founder's walk on #7642, 2026-09-03).
 *
 * `SpawnedProcesses` is the state the spells cannot hold themselves, since a spell's `execute` is
 * a function per call. It retains the `ProcessHandle` of every process it spawns because the
 * process table exposes rows and no dispatch (spike #7597 finding 3b), and it wires that process's
 * ports the way `src/launch/` wires a graph node's: a bounded queue and a pump per in-port, and a
 * `ProcessPorts` that publishes each out-port's payload to a latch a `read` waits on. A process
 * this service did not spawn has no retained handle, so `send` and `read` answer `UnknownProcess`
 * for it — the graph's own processes are `src/launch/`'s to feed.
 *
 * `ask` / `answer` and the `on` record on `spawn` are the answer path (#8756), and they are here
 * because this is where the inboxes and the out-port latches are: an `ask` has to reach the port's
 * own queue past its `accepts`, and a routed child port has to be seen at the emit. What they hand
 * an answer *to* is `deliver` (`../../process/inbox.ts`), which needs only a live handle — so the
 * asking process is any process, not only one this service spawned. The three spells below are
 * untouched by either: nothing addressed by a correlation is reachable from a spell's params.
 *
 * The six errors are declared here rather than in a `commands/core/errors.ts`: `core/` is one
 * directory per core spell list, not one feature, and a shared errors file is a file two parallel
 * children would both write.
 */

import {randomUUID} from "node:crypto";
import {Context, type Duration, Effect, Layer, Option, Queue, Ref, Schema, Scope} from "effect";
import type {OpenError} from "../../durability/Checkpoints.ts";
import {PayloadRejected, PortNotWired} from "../../ports/errors.ts";
import {NodeId} from "../../ports/graph.ts";
import {ProcessPorts} from "../../ports/ProcessPorts.ts";
import type {Delivery} from "../../ports/wiring.ts";
import type {HandlerFailed} from "../../process/errors.ts";
import {asked, deliver, type ReplyTo} from "../../process/inbox.ts";
import {Processes} from "../../process/Processes.ts";
import {type Message, type ProcessHandle, ProcessId} from "../../process/process.ts";
import {type AnyProgram, type InPort, ProgramId, type Receiver} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {type AnySpell, defineSpell} from "../spell.ts";

/** The registry holds no such program. `Registry`'s own `ProgramNotFound` as a caller reads it. */
export class UnknownProgram extends Schema.TaggedError<UnknownProgram>()(
	"tuval/commands/UnknownProgram",
	{program: ProgramId},
) {
	override get message(): string {
		return `no program "${this.program}" is registered`;
	}
}

/** Named as a target or a parent: no process this service spawned and still holds carries the id. */
export class UnknownProcess extends Schema.TaggedError<UnknownProcess>()(
	"tuval/commands/UnknownProcess",
	{process: ProcessId},
) {
	override get message(): string {
		return `no live process "${this.process}" was spawned through the process spells`;
	}
}

/** The process's program declares no port of that name in the direction the call needs. */
export class UnknownPort extends Schema.TaggedError<UnknownPort>()("tuval/commands/UnknownPort", {
	process: ProcessId,
	port: Schema.String,
	direction: Schema.Literals(["in", "out"]),
}) {
	override get message(): string {
		return `process "${this.process}" has no ${this.direction}-port "${this.port}"`;
	}
}

/** An `ask` named a port that takes payloads and answers none: it is a `port.in`, not a `port.request`. */
export class PortAnswersNothing extends Schema.TaggedError<PortAnswersNothing>()(
	"tuval/commands/PortAnswersNothing",
	{process: ProcessId, port: Schema.String},
) {
	override get message(): string {
		return `port "${this.port}" of process "${this.process}" answers nothing, so it cannot be asked`;
	}
}

/** The correlation an answer was addressed to is not outstanding: it was already spent, or expired. */
export class UnclaimedReply extends Schema.TaggedError<UnclaimedReply>()(
	"tuval/commands/UnclaimedReply",
	{correlation: Schema.String},
) {
	override get message(): string {
		return `no ask is waiting on correlation "${this.correlation}"`;
	}
}

/** The port's predicate rejected the payload. The kind is the whole answer: it names the protocol. */
export class PortRefused extends Schema.TaggedError<PortRefused>()("tuval/commands/PortRefused", {
	process: ProcessId,
	port: Schema.String,
	kind: Schema.String,
}) {
	override get message(): string {
		return `port "${this.port}" of process "${this.process}" takes ${this.kind} and refused the payload`;
	}
}

/**
 * One out-port as a reader sees it: the value last emitted, and — before the first one — the first
 * to arrive. The queue is capacity 1 and sliding, so it is a wakeup for a `read` that got there
 * first and never a backlog; a port's history is not something a caller can ask for.
 */
interface OutboundLatch {
	readonly publish: (payload: unknown) => Effect.Effect<void>;
	readonly current: Effect.Effect<unknown>;
}

const openLatch = Effect.gen(function* () {
	const last = yield* Ref.make(Option.none<unknown>());
	const arrivals = yield* Queue.make<unknown>({capacity: 1, strategy: "sliding"});
	return {
		publish: (payload) =>
			Effect.asVoid(
				Effect.flatMap(Ref.set(last, Option.some(payload)), () => Queue.offer(arrivals, payload)),
			),
		current: Effect.flatMap(Ref.get(last), (held) =>
			Option.isSome(held) ? Effect.succeed(held.value) : Queue.take(arrivals),
		),
	} satisfies OutboundLatch;
});

interface Inbox {
	readonly port: InPort;
	readonly queue: Queue.Queue<unknown>;
}

/**
 * What one `send` did: whether the payload landed, and how many queued payloads the in-port took
 * off to make room for it. Only a `sliding` bound displaces anything — `dropping` refuses the new
 * payload instead and `suspend` waits — so `evicted` is `0` under the other two (#7971).
 */
export interface Sent {
	readonly delivered: boolean;
	readonly evicted: number;
}

/**
 * The offer and the eviction it cost, read as one step. A `sliding` queue at capacity takes its
 * oldest payload off inside the offer and answers `true` either way, so the displacement can only
 * be inferred from the queue's own fullness at the moment of the offer: `Queue.offerUnsafe` is the
 * same code as `Queue.offer` for a `sliding` queue in every state (`Queue.ts` at
 * `effect@4.0.0-rc.112`), and running it beside the fullness read inside one `Effect.sync` leaves
 * no yield point for the port's pump to `take` between them. A queue at capacity holding nothing
 * is a zero-capacity bound, which has no payload to lose.
 *
 * A `suspend` bound must keep blocking until there is room, which `offerUnsafe` will not do, so it
 * stays on the effectful offer along with `dropping`.
 */
const offerCounting = (inbox: Inbox, payload: unknown): Effect.Effect<Sent> =>
	inbox.port.bound.overflow === "sliding"
		? Effect.sync(() => {
				const evicted =
					Queue.isFullUnsafe(inbox.queue) && Queue.sizeUnsafe(inbox.queue) > 0 ? 1 : 0;
				return {delivered: Queue.offerUnsafe(inbox.queue, payload), evicted};
			})
		: Effect.map(Queue.offer(inbox.queue, payload), (delivered) => ({delivered, evicted: 0}));

interface Entry {
	readonly handle: ProcessHandle;
	readonly inboxes: ReadonlyMap<string, Inbox>;
	readonly outboxes: ReadonlyMap<string, OutboundLatch>;
}

/**
 * One in-port's pump: take, translate through the program's own receiver, dispatch, for as long as
 * the process lives. It is `launch`'s pump (`src/launch/launch.ts`) over an ad-hoc process rather
 * than a graph node; that one is private to its module and keyed on a node id, so this is written
 * again rather than reached into. A dispatch the target refuses is the target's failure, reported
 * and not retried.
 */
const pump = (handle: ProcessHandle, inbox: Queue.Dequeue<unknown>, receive: Receiver<Message>) =>
	Effect.forkIn(
		Effect.forever(
			Queue.take(inbox).pipe(
				Effect.flatMap((payload) => handle.dispatch(receive(payload as never))),
				Effect.catch((error: unknown) => Effect.logError(error)),
			),
		),
		handle.scope,
	);

/**
 * The out-port half of an ad-hoc process's wiring: what `src/ports/`'s `Wiring.emit` is to a graph
 * node. The delivery it reports is the port's own latch; `routed` is the spawner's `on` record
 * applied beside it, so a port the spawner named also lands in the spawner's inbox and a port it
 * did not name lands nowhere else (#8756).
 */
const emitter = (
	id: ProcessId,
	row: AnyProgram,
	outboxes: ReadonlyMap<string, OutboundLatch>,
	routed: (port: string, payload: unknown) => Effect.Effect<void>,
) =>
	Effect.fn("Tuval.SpawnedProcesses.emit")(function* (port: string, payload: unknown) {
		const node = NodeId.make(id);
		const latch = outboxes.get(port);
		const declared = row.ports[port];
		if (latch === undefined || declared === undefined) {
			return yield* new PortNotWired({node, port});
		}
		if (!declared.accepts(payload)) {
			return yield* new PayloadRejected({node, program: row.id, port, kind: declared.kind});
		}
		yield* latch.publish(payload);
		yield* routed(port, payload);
		return [{to: {node, port}, accepted: true}] as ReadonlyArray<Delivery>;
	});

/**
 * Which of the spawner's own events each of the child's out-ports arrives as — the authoring
 * layer's `spawn(x, {on})` as the kernel takes it. A port with no entry routes nowhere.
 */
export type ChildRoutes = Readonly<Record<string, string | undefined>>;

const NO_ROUTES: ChildRoutes = {};

/** One outstanding `ask`, held against the correlation the kernel minted for it. */
interface Pending {
	/** The process that asked, and the event its answer arrives as. */
	readonly to: ProcessId;
	readonly event: string;
	/** Who was asked — kept so a refused answer can name the port that refused it. */
	readonly of: ProcessId;
	readonly port: string;
	readonly answers: (payload: unknown) => boolean;
}

export interface SpawnedProcessesOptions {
	/** How long a `read` waits for a port that has said nothing yet, before answering none. */
	readonly readTimeout: Duration.Input;
}

const make = Effect.fn("Tuval.SpawnedProcesses.make")(function* (options: SpawnedProcessesOptions) {
	const registry = yield* Registry;
	const processes = yield* Processes;
	const live = new Map<ProcessId, Entry>();
	/** The correlation table an answer is addressed by. One entry per outstanding `ask`. */
	const pending = new Map<string, Pending>();

	const entryOf = (process: ProcessId) =>
		Effect.suspend(() => {
			const entry = live.get(process);
			return entry === undefined
				? Effect.fail(new UnknownProcess({process}))
				: Effect.succeed(entry);
		});

	const spawn = Effect.fn("Tuval.SpawnedProcesses.spawn")(function* (
		program: ProgramId,
		parent: Option.Option<ProcessId>,
		on: ChildRoutes = NO_ROUTES,
	) {
		const row = yield* Effect.mapError(
			registry.resolve(program),
			() => new UnknownProgram({program}),
		);
		// Minted here rather than by `Processes.spawn` — same value, one call earlier — because the
		// `ProcessPorts` handed to the spawn must already know which process it emits from.
		const id = ProcessId.make(randomUUID());
		const outboxes = new Map<string, OutboundLatch>();
		for (const [name, port] of Object.entries(row.ports)) {
			if (port.direction === "out") outboxes.set(name, yield* openLatch);
		}
		// Routing is resolved per emit rather than wired once, because a route's target is the
		// spawner's inbox and a spawner can stop while its child runs on: `deliver` answers `false`
		// then, where a captured handle would have gone stale.
		const routeOne = (port: string, payload: unknown): Effect.Effect<void> => {
			const event = on[port];
			if (event === undefined || Option.isNone(parent)) return Effect.void;
			return Effect.asVoid(deliver(processes, parent.value, {type: event, payload}));
		};
		const ports = ProcessPorts.of({emit: emitter(id, row, outboxes, routeOne)});

		// The spawn set is stated here in full, because it is all the child's handlers will resolve
		// (#7972). `Effect.context()` is this caller's own — the spell fiber's, which is the kernel
		// one an executor runs a spell under — so a spawned row's `R` is satisfied the same way the
		// picker satisfies a window's (`../../shell/picker/open.ts`), and the ports below are the
		// one thing minted for the child rather than passed on.
		const inherited = yield* Effect.context<never>();
		const handle = yield* processes
			.spawn(program, {
				id,
				...(Option.isSome(parent) ? {parent: parent.value} : {}),
				services: Context.add(inherited, ProcessPorts, ports),
			})
			.pipe(
				Effect.catchTag("tuval/ProgramNotFound", () => Effect.fail(new UnknownProgram({program}))),
				Effect.catchTag("tuval/ProcessNotFound", (miss) =>
					Effect.fail(new UnknownProcess({process: miss.id})),
				),
			);

		// The kernel process is running from here on, under a scope forked from the layer root or the
		// parent's — nothing ties it to this effect, so a failure below would leave it holding its
		// ports with no entry in `live` for `entryOf` to find. `onError` catches a defect as well as
		// a failure, which is what the no-receiver die below is (#7761).
		yield* Effect.gen(function* () {
			const inboxes = new Map<string, Inbox>();
			for (const [name, port] of Object.entries(row.ports)) {
				if (port.direction !== "in") continue;
				const receive = row.receive?.[name] as Receiver<Message> | undefined;
				if (receive === undefined) {
					// `launch` refuses this at boot with `NoReceiver`; there is no boot to refuse here, and a
					// caller cannot act on another program's authoring bug — so it dies, as the executor dies
					// on a spell whose value its own `result` schema refuses.
					return yield* Effect.die(
						`program "${row.id}" declares in-port "${name}" but no receiver for it`,
					);
				}
				const queue = yield* Queue.make<unknown>({
					capacity: port.bound.capacity,
					strategy: port.bound.overflow,
				});
				yield* Scope.addFinalizer(handle.scope, Effect.asVoid(Queue.shutdown(queue)));
				yield* pump(handle, queue, receive);
				inboxes.set(name, {port, queue});
			}

			live.set(id, {handle, inboxes, outboxes});
			yield* Scope.addFinalizer(
				handle.scope,
				Effect.sync(() => {
					live.delete(id);
					// A process that stopped answers nothing more, and a correlation nobody will ever
					// spend is a leak: one sweep per process rather than one finalizer per `ask`.
					for (const [correlation, held] of pending) {
						if (held.of === id || held.to === id) pending.delete(correlation);
					}
				}),
			);
		}).pipe(Effect.onError(() => handle.stop));
		return id;
	});

	const send = Effect.fn("Tuval.SpawnedProcesses.send")(function* (
		process: ProcessId,
		port: string,
		payload: unknown,
	) {
		const entry = yield* entryOf(process);
		const inbox = entry.inboxes.get(port);
		if (inbox === undefined) return yield* new UnknownPort({process, port, direction: "in"});
		if (!inbox.port.accepts(payload)) {
			return yield* new PortRefused({process, port, kind: inbox.port.kind});
		}
		return yield* offerCounting(inbox, payload);
	});

	const ask = Effect.fn("Tuval.SpawnedProcesses.ask")(function* (
		from: ProcessId,
		process: ProcessId,
		port: string,
		payload: unknown,
		event: string,
	) {
		const entry = yield* entryOf(process);
		const inbox = entry.inboxes.get(port);
		if (inbox === undefined) return yield* new UnknownPort({process, port, direction: "in"});
		const answers = inbox.port.answers;
		if (answers === undefined) return yield* new PortAnswersNothing({process, port});
		if (!inbox.port.accepts(payload)) {
			return yield* new PortRefused({process, port, kind: inbox.port.kind});
		}
		const correlation = randomUUID();
		pending.set(correlation, {to: from, event, of: process, port, answers});
		const sent = yield* offerCounting(inbox, asked(payload, {correlation}));
		// A payload the queue refused is a question nobody was asked, so it owes no answer.
		if (!sent.delivered) pending.delete(correlation);
		return sent;
	});

	const answer = Effect.fn("Tuval.SpawnedProcesses.answer")(function* (
		to: ReplyTo,
		payload: unknown,
	) {
		const held = pending.get(to.correlation);
		if (held === undefined) return yield* new UnclaimedReply({correlation: to.correlation});
		if (!held.answers(payload)) {
			return yield* new PortRefused({
				process: held.of,
				port: held.port,
				kind: `an answer to ${held.port}`,
			});
		}
		// Spent before delivery: the caller's fold runs inside `deliver`, and a program that asks
		// again from that fold must not find this correlation still outstanding.
		pending.delete(to.correlation);
		return yield* deliver(processes, held.to, {type: held.event, payload});
	});

	const read = Effect.fn("Tuval.SpawnedProcesses.read")(function* (
		process: ProcessId,
		port: string,
	) {
		const entry = yield* entryOf(process);
		const latch = entry.outboxes.get(port);
		if (latch === undefined) return yield* new UnknownPort({process, port, direction: "out"});
		return yield* Effect.timeoutOption(latch.current, options.readTimeout);
	});

	return SpawnedProcesses.of({spawn, send, ask, answer, read});
});

export class SpawnedProcesses extends Context.Service<
	SpawnedProcesses,
	{
		readonly spawn: (
			program: ProgramId,
			parent: Option.Option<ProcessId>,
			/** Which of the parent's events each named child out-port arrives as. Needs a parent to route to. */
			on?: ChildRoutes,
		) => Effect.Effect<ProcessId, UnknownProgram | UnknownProcess | OpenError | HandlerFailed>;
		/**
		 * `delivered` is `Queue.offer`'s own answer, and it covers less than a reader expects. `false`
		 * is one of two things: a `dropping` in-port at capacity refusing the payload, or a queue that
		 * is no longer open — the process stopped and the finalizer shut its in-port queues down.
		 * `true` is not "nothing was lost", which is what `evicted` answers: a `sliding` bound at
		 * capacity takes the oldest queued payload off to append this one, and that count is the only
		 * way a sender can learn the earlier payload was never read (#7971).
		 */
		readonly send: (
			process: ProcessId,
			port: string,
			payload: unknown,
		) => Effect.Effect<Sent, UnknownProcess | UnknownPort | PortRefused>;
		/**
		 * `send`'s two-way twin: deliver on a request port and hold, against a correlation the kernel
		 * mints, where the answer goes. The callee's arrival carries that correlation and nothing
		 * else, so a `from` it was not given is a process it cannot address (#8756).
		 */
		readonly ask: (
			from: ProcessId,
			process: ProcessId,
			port: string,
			payload: unknown,
			event: string,
		) => Effect.Effect<Sent, UnknownProcess | UnknownPort | PortAnswersNothing | PortRefused>;
		/**
		 * Spend one correlation: check the answer against the asked port's own output schema and hand
		 * it to the asking process as the event that `ask` named. `false` means the asker is gone.
		 * A correlation is spent once — a second answer to it is `UnclaimedReply`, not a second event.
		 */
		readonly answer: (
			to: ReplyTo,
			payload: unknown,
		) => Effect.Effect<boolean, UnclaimedReply | PortRefused>;
		readonly read: (
			process: ProcessId,
			port: string,
		) => Effect.Effect<Option.Option<unknown>, UnknownProcess | UnknownPort>;
	}
>()("tuval/SpawnedProcesses") {
	static readonly layer = (
		options: SpawnedProcessesOptions,
	): Layer.Layer<SpawnedProcesses, never, Registry | Processes> =>
		Layer.effect(SpawnedProcesses, make(options));
}

const spawnSpell = defineSpell({
	path: ["process", "spawn"],
	describe: "Spawn a process of the named program as a child of the calling process.",
	params: Schema.Struct({program: ProgramId}),
	result: Schema.Struct({process: ProcessId}),
	// The parent is the caller's own process, which the kernel resolved into the scope — never an
	// id the caller named (#7617 R2.2). A call from outside any process spawns a root.
	execute: (args, scope) =>
		Effect.map(
			Effect.flatMap(SpawnedProcesses, (spawned) =>
				spawned.spawn(args.program, Option.fromNullishOr(scope.process)),
			),
			(process) => ({process}),
		),
	capabilities: [{family: "process-control"}],
});

const sendSpell = defineSpell({
	path: ["process", "send"],
	describe: "Write one payload to a named in-port of a process.",
	params: Schema.Struct({process: ProcessId, port: Schema.String, payload: Schema.Unknown}),
	result: Schema.Struct({delivered: Schema.Boolean, evicted: Schema.Number}),
	execute: (args) =>
		Effect.flatMap(SpawnedProcesses, (spawned) =>
			spawned.send(args.process, args.port, args.payload),
		),
	capabilities: [{family: "process"}],
});

/** `empty` and the value travel together, so a reply carrying both cannot be built or decoded. */
const ReadResult = Schema.Union([
	Schema.Struct({empty: Schema.Literal(true)}),
	Schema.Struct({empty: Schema.Literal(false), value: Schema.Unknown}),
]);

const readSpell = defineSpell({
	path: ["process", "read"],
	describe: "Read the current value of a named out-port of a process, or none.",
	params: Schema.Struct({process: ProcessId, port: Schema.String}),
	result: ReadResult,
	execute: (args) =>
		Effect.map(
			Effect.flatMap(SpawnedProcesses, (spawned) => spawned.read(args.process, args.port)),
			(held) =>
				Option.isSome(held)
					? ({empty: false, value: held.value} as const)
					: ({empty: true} as const),
		),
	capabilities: [{family: "process"}],
});

/**
 * The three spells as one list. Composing them into the registry is the proof child's; nothing
 * here edits `src/boot.ts` or `commands/index.ts`.
 */
export const processSpells: ReadonlyArray<AnySpell> = [spawnSpell, sendSpell, readSpell];
