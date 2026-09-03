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
import {Context, Effect, Exit, Layer, Option, Scope} from "effect";
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
	type ProcessHandle,
	ProcessId,
	type ProcessRow,
} from "./process.ts";

export interface SpawnOptions {
	readonly parent?: ProcessId;
	/** Restore's: the id the process was checkpointed under. A fresh spawn mints its own. */
	readonly id?: ProcessId;
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
			options?: SpawnOptions,
		) => Effect.Effect<ProcessHandle, SpawnError>;
		readonly stop: (id: ProcessId) => Effect.Effect<void, ProcessNotFound>;
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
	) => Effect.Effect<void, never, Scope.Scope>;
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
	return {
		machine: core,
		store,
		ctx: {},
		interpret: handlers,
		subscribe: subscribeDisposerBridge(core.subscribe ?? {}) as ErasedSubscribe,
	};
};

function makeServices() {
	return Effect.gen(function* () {
		const registry = yield* Registry;
		const checkpoints = yield* Checkpoints;
		const root = yield* Effect.scope;
		const services = yield* Effect.context<never>();
		const live = new Map<ProcessId, Entry>();

		const lookup = (id: ProcessId) =>
			Effect.suspend(() => {
				const entry = live.get(id);
				return entry === undefined ? Effect.fail(new ProcessNotFound({id})) : Effect.succeed(entry);
			});

		const spawn = Effect.fn("Tuval.Processes.spawn")(function* (
			programId: ProgramId,
			options?: SpawnOptions,
		) {
			const program = yield* registry.resolve(programId);
			const parent = options?.parent === undefined ? undefined : yield* lookup(options.parent);
			const id = options?.id ?? ProcessId.make(randomUUID());
			const parentId = Option.fromNullishOr(parent?.row.id);
			const scope = yield* Scope.fork(parent?.scope ?? root);
			let lifecycle: Lifecycle = "running";

			yield* Scope.addFinalizer(
				scope,
				Effect.sync(() => void live.delete(id)),
			);
			const actor: ActorHandle<unknown, Message, HandlerFailed> = yield* Effect.gen(function* () {
				const checkpoint = yield* checkpoints.open({
					id,
					programId,
					parentId,
					version: program.identity.version,
				});
				return yield* makeActor(toDefinition(program, checkpoint.store, services));
			}).pipe(
				Effect.provideService(Scope.Scope, scope),
				Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
			);
			yield* Scope.addFinalizer(
				scope,
				Effect.sync(() => {
					lifecycle = "stopping";
				}),
			);

			const row: ProcessRow = {
				id,
				programId,
				parentId,
				ports: program.ports,
				stateSummary: () => ({lifecycle, state: actor.getState()}),
			};
			live.set(id, {row, scope});

			const handle: ProcessHandle = {
				id,
				programId,
				parentId: row.parentId,
				scope,
				dispatch: actor.dispatch,
				getState: actor.getState,
				stop: Scope.close(scope, Exit.void),
			};
			return handle;
		});

		const stop = Effect.fn("Tuval.Processes.stop")(function* (id: ProcessId) {
			const entry = yield* lookup(id);
			yield* Scope.close(entry.scope, Exit.void);
		});

		const table = ProcessTable.of({
			list: Effect.sync(() => [...live.values()].map((entry) => entry.row)),
			get: (id) => Effect.map(lookup(id), (entry) => entry.row),
		});

		return Context.make(Processes, {spawn, stop}).pipe(Context.add(ProcessTable, table));
	});
}
