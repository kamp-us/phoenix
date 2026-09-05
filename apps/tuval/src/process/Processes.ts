/**
 * Process lifetime: spawn resolves a registry row, opens the process's checkpoint and runs the
 * row through the host under a Scope of its own, forked from the parent's; stop closes that
 * Scope. Everything a stop must do — drain,
 * dispose Subs, flush, refuse later dispatches — is the host's shutdown protocol registered as the
 * actor's Scope finalizer (`make` in `../host/actor.ts`); this slice only closes the Scope, and a
 * parent's close reaches every descendant because `Scope.fork` closes children with the parent.
 */

import {randomUUID} from "node:crypto";
import type {Cmd, Store, Sub, Subscribe} from "@demlik/tea";
import {Context, Effect, Exit, Layer, Option, PubSub, Scope, Stream} from "effect";
import {Checkpoints, type OpenError} from "../durability/Checkpoints.ts";
import {type ActorHandle, make as makeActor} from "../host/actor.ts";
import type {ActorDefinition, CoreMachine, Dispatch} from "../host/definition.ts";
import {subscribeDisposerBridge} from "../host/demlik-bridges.ts";
import type {ProgramNotFound} from "../registry/errors.ts";
import type {AnyProgram, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {HandlerFailed, ProcessNotFound} from "./errors.ts";
import {ProcessTable} from "./ProcessTable.ts";
import {
	type Lifecycle,
	type Message,
	type ProcessChange,
	type ProcessHandle,
	ProcessId,
	type ProcessRow,
} from "./process.ts";
import {ProcessSelf} from "./self.ts";

export interface SpawnOptions {
	readonly parent?: ProcessId;
	/** Restore's: the id the process was checkpointed under. A fresh spawn mints its own. */
	readonly id?: ProcessId;
	/**
	 * Provided to this process's handlers: the services its program's `R` names, per process.
	 * Never optional — a spawner with nothing to give says so with `Context.empty()`. Omission
	 * used to be silent, and `restore` took it, so a restored process's first handler died on a
	 * missing service one boot later (#7789).
	 */
	readonly services: Context.Context<never>;
}

/**
 * `HandlerFailed` reaches spawn when an `init` Cmd's handler fails while the actor boots; an
 * `OpenError` when the process's checkpoint refuses — a snapshot under another definition never
 * fresh-boots (`../durability/Checkpoints.ts`).
 */
export type SpawnError = ProgramNotFound | ProcessNotFound | OpenError | HandlerFailed;

export class Processes extends Context.Service<
	Processes,
	{
		readonly spawn: (
			programId: ProgramId,
			options: SpawnOptions,
		) => Effect.Effect<ProcessHandle, SpawnError>;
		readonly stop: (id: ProcessId) => Effect.Effect<void, ProcessNotFound>;
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
	static readonly layer: Layer.Layer<Processes | ProcessTable, never, Registry | Checkpoints> =
		Layer.effectContext(makeServices());
}

interface Entry {
	readonly row: ProcessRow;
	readonly scope: Scope.Closeable;
	/** The live actor behind the row. A row is what another process may see; this is what dispatches. */
	readonly handle: ProcessHandle;
}

/**
 * The row's private types are erased (`AnyProgram`), so the definition the host runs is typed at
 * the erased shape: `{type: string}` messages, `unknown` state. Handlers yield their follow-ups as
 * a list; here each one is dispatched back through the host's own follow-up path.
 */
type ErasedHandlers = {
	readonly [type: string]: (
		cmd: Cmd,
		ctx: unknown,
		dispatch: Dispatch<Message>,
	) => Effect.Effect<void, HandlerFailed, never>;
};

type ErasedSubscribe = {
	readonly [type: string]: (
		sub: Sub,
		ctx: unknown,
		dispatch: Dispatch<Message>,
	) => Effect.Effect<void, HandlerFailed, Scope.Scope>;
};

type ErasedDefinition = ActorDefinition<
	unknown,
	Message,
	Cmd,
	Sub,
	unknown,
	ErasedHandlers,
	ErasedSubscribe
>;

const toDefinition = (
	program: AnyProgram,
	store: Store<unknown>,
	services: Context.Context<never>,
	onCommit: (state: unknown) => Effect.Effect<void>,
): ErasedDefinition => {
	const handlers: Record<string, ErasedHandlers[string]> = {};
	for (const [type, handler] of Object.entries(program.handlers)) {
		const run = handler as (cmd: Cmd) => Effect.Effect<ReadonlyArray<Message>, unknown, never>;
		handlers[type] = (cmd, _ctx, dispatch) =>
			run(cmd).pipe(
				Effect.flatMap((follow) =>
					Effect.sync(() => {
						for (const msg of follow) dispatch(msg);
					}),
				),
				Effect.mapError(
					(cause) => new HandlerFailed({programId: program.id, cmdType: cmd.type, cause}),
				),
				Effect.provideContext(services),
			);
	}
	const core = program.core as CoreMachine<unknown, Message, Cmd, Sub, unknown> & {
		readonly subscribe?: Subscribe<Message, Sub, unknown>;
	};
	// A row's own Effect Sub handler wins over the bridged Demlik cell of the same type: the core
	// declares the Sub, the row says how it is run, and a core carrying both keeps the bridge for
	// the types the row leaves alone.
	const subscribe: Record<string, ErasedSubscribe[string]> = {
		...(subscribeDisposerBridge(core.subscribe ?? {}) as ErasedSubscribe),
	};
	for (const [type, handler] of Object.entries(program.subs ?? {})) {
		const run = handler as (
			sub: Sub,
			dispatch: Dispatch<Message>,
		) => Effect.Effect<void, unknown, Scope.Scope>;
		subscribe[type] = (sub, _ctx, dispatch) =>
			run(sub, dispatch).pipe(
				Effect.mapError(
					(cause) => new HandlerFailed({programId: program.id, cmdType: sub.type, cause}),
				),
				Effect.provideContext(services),
			);
	}
	return {
		// The definition's nominal identity is the registry row's `ProgramId` (ADR 0346). Built as a
		// literal, not through `defineActor`: one program is one definition and many processes, and
		// `defineActor`'s per-process name registry would read the second spawn as a collision.
		name: program.id,
		machine: core,
		store,
		ctx: {},
		interpret: handlers,
		subscribe,
		onCommit,
	};
};

function makeServices() {
	return Effect.gen(function* () {
		const registry = yield* Registry;
		const checkpoints = yield* Checkpoints;
		const root = yield* Effect.scope;
		const live = new Map<ProcessId, Entry>();
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
			// Assigned once the actor is up; a commit before then (boot's own) is not the row's.
			let row: ProcessRow | undefined;
			// Read late on purpose: the definition that closes over this is built before the actor
			// exists, and a handler only ever calls it once the actor is running.
			let readState: () => unknown = () => undefined;
			// What handlers actually get: the spawner's context plus this process's own `ProcessSelf`.
			// Never `options.services` directly — spawn is the one place `ProcessSelf` is provided, so
			// no caller and no `restore` has to know it exists (#7603).
			const handlerServices = Context.add(options.services, ProcessSelf, {
				scope,
				state: () => readState(),
			});

			yield* Scope.addFinalizer(
				scope,
				Effect.suspend(() => (row === undefined ? Effect.void : publish({kind: "stopped", row}))),
			);
			yield* Scope.addFinalizer(
				scope,
				Effect.sync(() => void live.delete(id)),
			);
			const onCommit = () =>
				Effect.suspend(() => {
					if (row === undefined) return Effect.void;
					revision++;
					return publish({kind: "state-changed", row});
				});
			const actor: ActorHandle<unknown, Message, HandlerFailed> = yield* Effect.gen(function* () {
				const checkpoint = yield* checkpoints.open({
					id,
					programId,
					parentId,
					version: program.identity.version,
				});
				return yield* makeActor(toDefinition(program, checkpoint.store, handlerServices, onCommit));
			}).pipe(
				Effect.provideService(Scope.Scope, scope),
				Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
			);
			readState = actor.getState;
			yield* Scope.addFinalizer(
				scope,
				Effect.sync(() => {
					lifecycle = "stopping";
				}),
			);

			row = {
				id,
				programId,
				parentId,
				ports: program.ports,
				stateSummary: () => ({lifecycle, revision, state: actor.getState()}),
			};
			const handle: ProcessHandle = {
				id,
				programId,
				parentId: row.parentId,
				scope,
				dispatch: actor.dispatch,
				getState: actor.getState,
				stop: Scope.close(scope, Exit.void),
			};
			live.set(id, {row, scope, handle});
			yield* publish({kind: "spawned", row});
			return handle;
		});

		const stop = Effect.fn("Tuval.Processes.stop")(function* (id: ProcessId) {
			const entry = yield* lookup(id);
			yield* Scope.close(entry.scope, Exit.void);
		});

		const table = ProcessTable.of({
			list: Effect.sync(() => [...live.values()].map((entry) => entry.row)),
			get: (id) => Effect.map(lookup(id), (entry) => entry.row),
			changes: Stream.fromPubSub(changes),
		});

		const handleOf = (id: ProcessId) =>
			Effect.sync(() => Option.fromNullishOr(live.get(id)?.handle));

		return Context.make(Processes, {spawn, stop, handle: handleOf}).pipe(
			Context.add(ProcessTable, table),
		);
	});
}
