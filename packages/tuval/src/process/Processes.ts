/**
 * Process lifetime: spawn resolves a registry row, opens the process's checkpoint and runs the
 * row on tea's Effect engine (`run` from `@demlik/tea/effect`) under a Scope of its own, forked from
 * the parent's; stop closes that Scope. Everything a stop must do — drain, interrupt in-flight
 * handlers, stop Subs, flush, refuse later dispatches — is the run's own stop, which `run`
 * registers on that Scope; this slice only closes the Scope, and a parent's close reaches every
 * descendant because `Scope.fork` closes children with the parent.
 *
 * `remove` is stop's durable counterpart (#9446): the founder ruled that removing a process forgets
 * it and its descendants for good, so it drops the checkpoint first and closes the Scope second.
 * That order is the whole guarantee — a Scope closed ahead of a failed manifest write would leave a
 * process gone from the table and still queued for the next `restore`, which is the half-forgotten
 * state this exists to make unwritable.
 */

import {randomUUID} from "node:crypto";
import {type Cmd, type OnError, RuntimeDiscardNotice, type Store, type Sub} from "@demlik/tea";
import {type EffectRuntime, run, type StoreFailed} from "@demlik/tea/effect";
import {Context, Effect, Exit, Layer, Option, PubSub, Scope, Semaphore, Stream} from "effect";
import {Checkpoints, type OpenError} from "../durability/Checkpoints.ts";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import type {ProgramNotFound} from "../registry/errors.ts";
import type {AnyProgram, ProgramCore, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {ForgetRefused, HandlerFailed, ProcessIsPlanned, ProcessNotFound} from "./errors.ts";
import {PlannedProcesses} from "./PlannedProcesses.ts";
import {ProcessTable} from "./ProcessTable.ts";
import {
	type Lifecycle,
	type Message,
	type ProcessChange,
	type ProcessHandle,
	ProcessId,
	type ProcessRow,
	type StateSummary,
} from "./process.ts";
import {ProcessSelf} from "./self.ts";
import {
	latching,
	noSelfReport,
	type SelfReport,
	type SelfReportPort,
	seedSelfReport,
	TITLE_PORT,
} from "./self-report.ts";

export interface SpawnOptions {
	readonly parent?: ProcessId;
	/** Restore's: the id the process was checkpointed under. A fresh spawn mints its own. */
	readonly id?: ProcessId;
	/**
	 * Exactly what this process's handlers resolve: the services its program's `R` names, per
	 * process. Not a floor — a handler is sealed to this set, so a service the fiber that
	 * dispatched holds and this set does not is not resolvable inside the handler (#7972). A
	 * spawner that wants to pass its own context on says so, the way `shell/picker/open.ts` does.
	 * Never optional — a spawner with nothing to give says so with `Context.empty()`. Omission
	 * used to be silent, and `restore` took it, so a restored process's first handler died on a
	 * missing service one boot later (#7789).
	 */
	readonly services: Context.Context<never>;
}

/**
 * `HandlerFailed` reaches spawn when an `init` Cmd's handler fails while the run boots, and
 * `StoreFailed` when boot's own save fails; an `OpenError` when the process's checkpoint refuses — a
 * snapshot under another definition never fresh-boots (`../durability/Checkpoints.ts`).
 */
export type SpawnError =
	| ProgramNotFound
	| ProcessNotFound
	| OpenError
	| HandlerFailed
	| StoreFailed;

/**
 * Every way a `remove` refuses, and each one leaves the process exactly as it found it: unknown to
 * the table, declared by the config graph, or durably un-forgettable.
 */
export type RemoveError = ProcessNotFound | ProcessIsPlanned | ForgetRefused;

export class Processes extends Context.Service<
	Processes,
	{
		readonly spawn: (
			programId: ProgramId,
			options: SpawnOptions,
		) => Effect.Effect<ProcessHandle, SpawnError>;
		readonly stop: (id: ProcessId) => Effect.Effect<void, ProcessNotFound>;
		/**
		 * Forget the process durably, then stop it — the desk's `remove` and the authored `stop`
		 * effect's one operation. Its subtree goes with it both ways: the checkpoint's descendants are
		 * dropped by `Checkpoints.forget`, and the live ones by the Scope close. A process the config
		 * graph declares is refused outright, and so is one whose durable write fails; in both cases
		 * the process is still running and still in the manifest when the failure arrives.
		 */
		readonly remove: (id: ProcessId) => Effect.Effect<void, RemoveError>;
		/**
		 * The live handle for one id, or none. `ProcessTable.get` answers with the public row; this
		 * answers with the thing that can be dispatched into, which is what the shell's `forwardKey`
		 * and the page transport's `handles` both need and neither can reach through the table.
		 * Absence is a value, not a failure: a process that has stopped is the ordinary case.
		 */
		readonly handle: (id: ProcessId) => Effect.Effect<Option.Option<ProcessHandle>>;
	}
>()("tuval/Processes") {
	/**
	 * `Processes` and `ProcessTable` over one map. The layer's Scope is the root every root process
	 * forks from, so closing the layer stops every process (`LLMS.md` "Writing Effect services").
	 */
	static readonly layer: Layer.Layer<
		Processes | ProcessTable | PlannedProcesses,
		never,
		Registry | Checkpoints
	> = Layer.effectContext(makeServices());
}

interface Entry {
	readonly row: ProcessRow;
	readonly scope: Scope.Closeable;
	/** The live actor behind the row. A row is what another process may see; this is what dispatches. */
	readonly handle: ProcessHandle;
}

/**
 * The row's private types are erased (`AnyProgram`), so the run is typed at the erased shape:
 * `{type: string}` messages, `unknown` state. A handler yields its follow-ups as a list, which tea's
 * Effect engine dispatches in order; its failure crosses the handle as `HandlerFailed`.
 */
type ErasedCell = (cmd: Cmd) => Effect.Effect<ReadonlyArray<Message>, HandlerFailed>;

type ErasedRunner = (sub: Sub) => Stream.Stream<Message, HandlerFailed>;

/** What a process's run answers with once booted: every dispatch fails as `DispatchError` says. */
type Run = EffectRuntime<unknown, Message, never, HandlerFailed>;

/**
 * Every key effect keeps its own runtime under is namespaced `effect/…` — the clock, the scheduler
 * and its yield knobs, the loggers and log level, the tracer and its parent span, and `Scope`
 * (rc.112: `Context.Reference("effect/Clock")` and friends in `src/internal/effect.ts`,
 * `src/Scheduler.ts`, `src/Tracer.ts`, `src/Scope.ts`). Tuval's own services are namespaced
 * `tuval/…` by `Context.Service`, so the prefix is the line between "what a spawner grants" and
 * "how the fiber runs".
 */
const EFFECT_RUNTIME_PREFIX = "effect/";

/**
 * The seal: a handler resolves exactly the set its spawn was given, never that set merged over
 * whatever the spawning fiber happened to carry (#7972). `Effect.provideContext` is
 * `updateContext(self, Context.merge(context))` (rc.112, `src/internal/effect.ts:2197`), which
 * makes the spawn set a floor; `Effect.updateContext` sets the fiber context outright at the same
 * seam and restores it on exit (rc.112, `src/internal/effect.ts:2073`). tea's `run` captures the
 * context it runs in and runs every handler and Sub Stream with that one, so sealing the `run` call
 * seals them all, and no dispatching fiber's context reaches a handler.
 *
 * effect's own runtime rides through, because `FiberImpl.setContext` re-derives the scheduler,
 * clock, log level, stack frame, tracer and parent span from the context on every replace (rc.112,
 * `src/internal/effect.ts:709`): dropping those would silently reset a handler's clock and logger
 * to the process defaults, and would take the process `Scope` that `run` stops on with them.
 * Everything the runtime does not own is the spawn set's alone.
 */
const sealed =
	(services: Context.Context<never>) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		Effect.updateContext(self, (ambient: Context.Context<R>) => {
			const runtime = new Map<string, unknown>();
			for (const [key, value] of ambient.mapUnsafe) {
				if (key.startsWith(EFFECT_RUNTIME_PREFIX)) runtime.set(key, value);
			}
			return Context.merge(Context.makeUnsafe<R>(runtime), services);
		});

/**
 * The store tea's run saves through. A state the program calls not checkpoint-worthy is skipped at
 * this one write path, so it is unreachable from every save the run makes — a commit, boot and the
 * final save on stop alike (#8170).
 */
const worthyOnly = (store: Store<unknown>, program: AnyProgram): Store<unknown> => {
	const worthy = program.checkpointWorthy;
	if (worthy === undefined) return store;
	return {
		load: () => store.load(),
		save: (state) => (worthy(state) ? store.save(state) : Promise.resolve()),
		migrate: (raw) => store.migrate(raw),
	};
};

/**
 * A process's run on tea's Effect engine. The definition's nominal identity is the registry row's
 * `ProgramId` (ADR 0346); one program is one row and many runs. The whole run is sealed, so every
 * handler fiber and every Sub's Stream resolves the spawn set and nothing else.
 */
const runProgram = (
	program: AnyProgram,
	store: Store<unknown>,
	services: Context.Context<never>,
	onError: OnError,
) => {
	const interpret: Record<string, ErasedCell> = {};
	for (const [type, handler] of Object.entries(program.handlers)) {
		const cell = handler as (cmd: Cmd) => Effect.Effect<ReadonlyArray<Message>, unknown, never>;
		interpret[type] = (cmd) =>
			Effect.mapError(
				cell(cmd),
				(cause) => new HandlerFailed({programId: program.id, cmdType: cmd.type, cause}),
			);
	}
	// The core declares each Sub as `{type, deps}`; the row's runner of that type is its Stream, which
	// tea drains on its own fiber and interrupts when the Sub leaves. A failure the runner did not map
	// into a Msg stops the process (ADR 0408).
	const subscribe: Record<string, ErasedRunner> = {};
	for (const [type, runner] of Object.entries(program.subs ?? {})) {
		const stream = runner as (sub: Sub) => Stream.Stream<Message, unknown>;
		subscribe[type] = (sub) =>
			Stream.mapError(
				stream(sub),
				(cause) => new HandlerFailed({programId: program.id, cmdType: sub.type, cause}),
			);
	}
	// The cast is for the erasure: `AnyProgram` erases S/M/C/U to `any`, and an `any`-parameterised
	// `update` is the union of `Reducer` and `Transitions`, which no annotation accepts as either
	// (TS2322 without the cast).
	const core = program.core as ProgramCore<unknown, Message, Cmd, Sub, unknown>;
	const booting = run(core, {interpret, subscribe, store: worthyOnly(store, program), onError});
	return sealed(services)(booting);
};

function makeServices() {
	return Effect.gen(function* () {
		const registry = yield* Registry;
		const checkpoints = yield* Checkpoints;
		const root = yield* Effect.scope;
		const live = new Map<ProcessId, Entry>();
		// The graph-declared ids, written by `launch` through `PlannedProcesses` and read by `remove`
		// off this same set — the way `ProcessTable` reads the map above.
		const planned = new Set<ProcessId>();
		const changes = yield* PubSub.unbounded<ProcessChange>();
		yield* Scope.addFinalizer(root, PubSub.shutdown(changes));
		const publish = (change: ProcessChange) => Effect.asVoid(PubSub.publish(changes, change));

		const lookup = (id: ProcessId) =>
			Effect.suspend(() => {
				const entry = live.get(id);
				return entry === undefined ? Effect.fail(new ProcessNotFound({id})) : Effect.succeed(entry);
			});

		const spawn = Effect.fn("Tuval.Processes.spawn")(function* (
			programId: ProgramId,
			options: SpawnOptions,
		) {
			const program = yield* registry.resolve(programId);
			const parent = options.parent === undefined ? undefined : yield* lookup(options.parent);
			const id = options.id ?? ProcessId.make(randomUUID());
			const parentId = Option.fromNullishOr(parent?.row.id);
			const scope = yield* Scope.fork(parent?.scope ?? root);
			let lifecycle: Lifecycle = "running";
			let revision = 0;
			let report = noSelfReport;
			// Assigned once the actor is up; a commit before then (boot's own) is not the row's.
			let row: ProcessRow | undefined;
			// Read late on purpose: the definition that closes over this is built before the actor
			// exists, and a handler only ever calls it once the actor is running.
			let readState: () => unknown = () => undefined;
			// What handlers actually get, and under the seal it is all they get: the spawner's set
			// plus this process's own `ProcessSelf`. Never `options.services` directly — spawn is the
			// one place `ProcessSelf` is provided, so no caller and no `restore` has to know it
			// exists (#7603), and `id` rides along here for the same reason: every spawn path — the
			// graph's launcher, the picker, an ad-hoc spawn, a restore — mints or carries the id at
			// this one call, so a handler's `self` is a free read on all four (#8757). The spawner's
			// `Scope` is dropped on the way in: a spawner that passes its whole context on carries
			// one, and the seal would let it beat the Scope the host forks for a sub handler. A
			// handler that wants this process's own reads `ProcessSelf`.
			const granted = Context.add(Context.omit(Scope.Scope)(options.services), ProcessSelf, {
				id,
				scope,
				state: () => readState(),
			});
			// The latch is the kernel's, so it wraps whichever `ProcessPorts` the spawner bound — the
			// graph's wiring, an ad-hoc spawn's latches, or `unwired` — and `title@1`/`status@1` read
			// back the same on all three (`./self-report.ts`). A spawner that bound none has nothing to
			// wrap: that process cannot emit at all.
			const spawnerPorts = Context.getOption(granted, ProcessPorts);
			const record = (port: SelfReportPort, line: string) => {
				report =
					port === TITLE_PORT
						? {...report, title: Option.some(line)}
						: {...report, status: Option.some(line)};
			};
			const handlerServices = Option.isNone(spawnerPorts)
				? granted
				: Context.add(granted, ProcessPorts, latching(program, spawnerPorts.value, record));

			yield* Scope.addFinalizer(
				scope,
				Effect.suspend(() => (row === undefined ? Effect.void : publish({kind: "stopped", row}))),
			);
			yield* Scope.addFinalizer(
				scope,
				Effect.sync(() => void live.delete(id)),
			);
			// tea's sink is synchronous, so each report is forked onto the spawner's own runtime: its
			// logger, not a default one.
			const forkLog = Effect.runForkWith(yield* Effect.context<never>());
			const onError: OnError = (error) =>
				void forkLog(
					error instanceof RuntimeDiscardNotice ? Effect.logWarning(error) : Effect.logError(error),
				);
			const runtime: Run = yield* Effect.gen(function* () {
				const checkpoint = yield* checkpoints.open({
					id,
					programId,
					parentId,
					version: program.identity.version,
					...(program.migrations === undefined ? {} : {migrations: program.migrations}),
					...(program.restorable === undefined ? {} : {restorable: program.restorable}),
				});
				const booting = yield* runProgram(program, checkpoint.store, handlerServices, onError);
				// Fires after every applied transition once its Cmds have settled, however they settled
				// (demlik #311), and never for boot's own commit. An `init` Cmd's follow-ups land on
				// tea's tail before this fiber resumes from `ready`, so a transition can precede the row:
				// it is counted here and published once the row exists, below.
				booting.observe(() => {
					revision++;
					if (row !== undefined) {
						PubSub.publishUnsafe<ProcessChange>(changes, {kind: "state-changed", row});
					}
				});
				return yield* booting.ready;
			}).pipe(
				Effect.provideService(Scope.Scope, scope),
				Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
			);
			readState = runtime.getState;
			// The latch only ever records what this process emitted, and a restored one emits nothing:
			// a rehydrating `init` may answer no Cmds and the authored `update` publishes a derived
			// line only on the transition that moves it, so a stable title would read back as absent
			// forever (#8812). Seeding it off the state the run actually booted on covers both arms
			// at once — a fresh boot's `init` derives the same lines from that same state.
			seedSelfReport(program, runtime.getState(), record);
			yield* Scope.addFinalizer(
				scope,
				Effect.sync(() => {
					lifecycle = "stopping";
				}),
			);

			const stateSummary = (): StateSummary => ({lifecycle, revision, state: runtime.getState()});
			const selfReport = (): SelfReport => report;
			row = {id, programId, parentId, ports: program.ports, stateSummary, selfReport};
			const unpublished = revision;
			// Every fold this process is asked for from outside runs alone, so a summary read beside
			// one is that fold's and not a later one's. The run's own tail serialises the transition
			// but releases before `dispatch` waits out the follow-ups, which is the window a caller
			// reading state after its dispatch used to lose its Msg's answer in (#8274).
			const folds = yield* Semaphore.make(1);
			const handle: ProcessHandle = {
				id,
				programId,
				parentId: row.parentId,
				scope,
				dispatch: (msg) => folds.withPermits(1)(runtime.dispatch(msg)),
				dispatchFolded: (msg) =>
					folds.withPermits(1)(
						Effect.map(Effect.exit(runtime.dispatch(msg)), (settled) => ({
							settled,
							summary: stateSummary(),
						})),
					),
				getState: runtime.getState,
				stop: Scope.close(scope, Exit.void),
			};
			live.set(id, {row, scope, handle});
			yield* publish({kind: "spawned", row});
			if (unpublished > 0) yield* publish({kind: "state-changed", row});
			return handle;
		});

		const stop = Effect.fn("Tuval.Processes.stop")(function* (id: ProcessId) {
			const entry = yield* lookup(id);
			yield* Scope.close(entry.scope, Exit.void);
		});

		const remove = Effect.fn("Tuval.Processes.remove")(function* (id: ProcessId) {
			const entry = yield* lookup(id);
			if (planned.has(id)) return yield* new ProcessIsPlanned({id});
			// Durable half first, and nothing is closed until it has landed. The refusal carries the
			// store's own failure so a caller can say why, and says in its own message that the
			// process it names is still running.
			yield* Effect.mapError(checkpoints.forget(id), (cause) => new ForgetRefused({id, cause}));
			yield* Scope.close(entry.scope, Exit.void);
		});

		const table = ProcessTable.of({
			list: Effect.sync(() => [...live.values()].map((entry) => entry.row)),
			get: (id) => Effect.map(lookup(id), (entry) => entry.row),
			changes: Stream.fromPubSub(changes),
		});

		const handleOf = (id: ProcessId) =>
			Effect.sync(() => Option.fromNullishOr(live.get(id)?.handle));

		return Context.make(Processes, {spawn, stop, remove, handle: handleOf}).pipe(
			Context.add(ProcessTable, table),
			Context.add(PlannedProcesses, {
				declare: (ids) =>
					Effect.sync(() => {
						for (const id of ids) planned.add(id);
					}),
				isPlanned: (id) => Effect.sync(() => planned.has(id)),
			}),
		);
	});
}
