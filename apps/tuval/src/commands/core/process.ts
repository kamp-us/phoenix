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
 * The four errors are declared here rather than in a `commands/core/errors.ts`: `core/` is one
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
 * node. There is no route to follow, so the delivery it reports is the port's own latch.
 */
const emitter = (id: ProcessId, row: AnyProgram, outboxes: ReadonlyMap<string, OutboundLatch>) =>
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
		return [{to: {node, port}, accepted: true}] as ReadonlyArray<Delivery>;
	});

export interface SpawnedProcessesOptions {
	/** How long a `read` waits for a port that has said nothing yet, before answering none. */
	readonly readTimeout: Duration.Input;
}

const make = Effect.fn("Tuval.SpawnedProcesses.make")(function* (options: SpawnedProcessesOptions) {
	const registry = yield* Registry;
	const processes = yield* Processes;
	const live = new Map<ProcessId, Entry>();

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
		const ports = ProcessPorts.of({emit: emitter(id, row, outboxes)});

		const handle = yield* processes
			.spawn(program, {
				id,
				...(Option.isSome(parent) ? {parent: parent.value} : {}),
				services: Context.make(ProcessPorts, ports),
			})
			.pipe(
				Effect.catchTag("tuval/ProgramNotFound", () => Effect.fail(new UnknownProgram({program}))),
				Effect.catchTag("tuval/ProcessNotFound", (miss) =>
					Effect.fail(new UnknownProcess({process: miss.id})),
				),
			);

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
			Effect.sync(() => void live.delete(id)),
		);
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
		return yield* Queue.offer(inbox.queue, payload);
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

	return SpawnedProcesses.of({spawn, send, read});
});

export class SpawnedProcesses extends Context.Service<
	SpawnedProcesses,
	{
		readonly spawn: (
			program: ProgramId,
			parent: Option.Option<ProcessId>,
		) => Effect.Effect<ProcessId, UnknownProgram | UnknownProcess | OpenError | HandlerFailed>;
		/** `false` only under a `dropping` in-port bound: the queue was full and refused the payload. */
		readonly send: (
			process: ProcessId,
			port: string,
			payload: unknown,
		) => Effect.Effect<boolean, UnknownProcess | UnknownPort | PortRefused>;
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
	result: Schema.Struct({delivered: Schema.Boolean}),
	execute: (args) =>
		Effect.map(
			Effect.flatMap(SpawnedProcesses, (spawned) =>
				spawned.send(args.process, args.port, args.payload),
			),
			(delivered) => ({delivered}),
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
