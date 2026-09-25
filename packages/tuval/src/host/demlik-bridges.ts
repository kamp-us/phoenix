/**
 * The Demlik 0.12 bridges — and the kamp-us/demlik#36 swap point.
 *
 * Demlik 0.12 speaks Promise and synchronous disposer at its two host seams: an `Interpret` cell
 * returns `Promise<M | void>` (`src/pure/core.ts`, `Interpret`), and a dep-keyed Sub's `source`
 * returns a `Dispose` synchronously (`DepKeyedSub.source`). This host speaks Effect and Scope, and
 * declares its Subs as `{type, deps}` entries run by a runner of that type. Everything that
 * translates between the two lives here and nowhere else, so when demlik#36 ships `tea-effect`
 * this file is deleted. Nothing outside this file names a Promise or a `Dispose` on a handler's
 * behalf.
 */

import type {
	Cmd,
	DepKeyedSub as DemlikDepKeyedSub,
	Dispose,
	Interpret,
	Machine,
	PortEmitter,
} from "@demlik/tea";
import {type Context, Effect, Fiber, Queue, Stream} from "effect";
import {type DepKeyedSub, desiredSub, type Sub} from "../registry/sub.ts";
import type {
	ActorDefinition,
	Dispatch,
	InterpretHandlers,
	SubHandler,
	SubscribeHandlers,
} from "./definition.ts";
import {SubDisposeError} from "./errors.ts";

/**
 * Promise bridge for Interpret: Effect-valued Cmd handlers as the `Interpret` map Demlik 0.12's
 * `run` takes. Each cell runs its handler to a Promise over the services captured at build time
 * (`Effect.runPromiseWith`, `effect/Effect` rc.112). A failure rejects the Promise exactly as a
 * throwing Promise handler would, so Demlik's own error routing sees it.
 */
export const interpretPromiseBridge =
	<R>(services: Context.Context<R>) =>
	<M extends {type: string}, C extends Cmd, Ctx>(
		handlers: InterpretHandlers<M, C, Ctx>,
	): Interpret<M, C, Ctx> => {
		const runPromise = Effect.runPromiseWith(services);
		const cells: Partial<Interpret<M, C, Ctx>> = {};
		const bridge = <K extends C["type"]>(type: K): void => {
			const handler = handlers[type];
			cells[type] = (cmd, ctx: Ctx & PortEmitter, dispatch) =>
				runPromise(
					handler(cmd, ctx, dispatch ?? noDispatch) as Effect.Effect<M | void, unknown, R>,
				);
		};
		for (const type of Object.keys(handlers)) bridge(type as C["type"]);
		return cells as Interpret<M, C, Ctx>;
	};

const noDispatch = (): void => {};

/**
 * Disposer bridge for a Sub runner: one that opens now, sends through a callback and hands back the
 * close — Demlik's own runner shape — as the Stream runner a program row carries. Opening runs
 * under `Effect.acquireRelease` inside `Stream.callback`, whose Scope is the Stream's, so the
 * Stream's interruption awaits the `Dispose`, Promise or not, as one shutdown step.
 *
 * The Stream never ends on its own, so its lifetime is the Sub's lifetime: a runner whose Stream
 * ended would be marked `ended` and never re-armed while its id holds.
 */
export const disposerStream =
	<U extends Sub, M>(open: (sub: U, dispatch: Dispatch<M>) => Dispose) =>
	(sub: U): Stream.Stream<M> =>
		Stream.callback<M>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => open(sub, (msg) => void Queue.offerUnsafe(queue, msg))),
				(dispose) =>
					Effect.tryPromise({
						try: async () => {
							await dispose();
						},
						catch: (cause) => new SubDisposeError({cause}),
					}).pipe(Effect.orDie),
			),
		);

/**
 * Runner bridge for Sub: one `{type, deps}` entry and the Effect runner of its type as the
 * inline-runner entry Demlik 0.12 reconciles. Its `source` forks the runner scoped over the
 * services captured at build time, and its `Dispose` interrupts that fiber, which closes the scope.
 * 0.12 keys the entry on `deps` alone where this host keys it on `type` and `deps`; within one
 * entry the two agree on every start and stop.
 */
const depKeyedBridge =
	<R>(services: Context.Context<R>) =>
	<S, M, U extends Sub, Ctx>(
		entry: DepKeyedSub<S, U>,
		runner: SubHandler<M, U, U["type"], Ctx>,
	): DemlikDepKeyedSub<S, M, Ctx> => {
		const runFork = Effect.runForkWith(services);
		return {
			deps: (state) => entry.deps(state),
			source: (state, dispatch, ctx) => {
				const sub = desiredSub(entry, state) as Extract<U, {type: U["type"]}>;
				const fiber = runFork(
					Effect.scoped(runner(sub, ctx, dispatch) as Effect.Effect<void, unknown, R>),
				);
				return () => Effect.runPromise(Fiber.interrupt(fiber));
			},
		};
	};

/**
 * A definition on Demlik 0.12's own Promise runtime: its Cmd handlers crossed through the
 * Interpret bridge, each Sub entry crossed with its runner through the runner bridge. The parity
 * test runs one machine both ways; nothing else should need this.
 */
export const toDemlikMachine = <
	S,
	M extends {type: string},
	C extends Cmd,
	U extends Sub,
	Ctx,
	I extends InterpretHandlers<M, C, Ctx>,
	B extends SubscribeHandlers<M, U, Ctx>,
	R,
>(
	definition: ActorDefinition<S, M, C, U, Ctx, I, B>,
	services: Context.Context<R>,
): Machine<S, M, C, never, Ctx> => {
	const bridge = depKeyedBridge(services);
	return {
		...definition.machine,
		subs: (definition.machine.subs ?? []).map((entry) =>
			bridge<S, M, U, Ctx>(entry, definition.subscribe[entry.type as U["type"]]),
		),
		interpret: interpretPromiseBridge(services)<M, C, Ctx>(definition.interpret),
	};
};
