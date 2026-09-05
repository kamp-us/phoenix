/**
 * The two Demlik 0.12 bridges — and the kamp-us/demlik#36 swap point.
 *
 * Demlik 0.12 speaks Promise and synchronous disposer at its two host seams: an `Interpret` cell
 * returns `Promise<M | void>` (`src/pure/core.ts`, `Interpret`), and a dep-keyed Sub's `source`
 * returns a `Dispose` synchronously (`DepKeyedSub.source`). This host speaks Effect and Scope.
 * Everything that translates between the two lives here and nowhere else, so when demlik#36
 * ships `tea-effect` — Demlik accepting Effect handlers and Scope-owned Subs natively — this file
 * is deleted and the two call sites take Demlik's own types. Nothing outside this file names a
 * Promise or a `Dispose` on a handler's behalf.
 */

import type {Cmd, DepKeyedSub, Interpret, Machine, PortEmitter, Sub, Subscribe} from "@demlik/tea";
import {type Context, Effect, type Scope} from "effect";
import type {
	ActorDefinition,
	Dispatch,
	InterpretHandlers,
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
 * Synchronous disposer bridge for Sub: a Demlik 0.12 dep-keyed `source` — open now, hand back the
 * close — as a scoped acquisition. Opening runs the source under `Effect.acquireRelease`
 * (`LLMS.md` "Managing resources and Scopes"); the Scope's close awaits the `Dispose`, Promise or
 * not, so Demlik's disposer and the Effect finalizer are one shutdown step.
 *
 * It then holds instead of returning, so the effect's lifetime is the Sub's lifetime and its error
 * channel is the Sub's post-open failure channel — the one the host routes through the ADR 0346
 * policy. A dep-keyed `source` returning a `Dispose` has nothing to put on that channel yet; a
 * manual `subscribe` handler does return, and its return is the `ended` mark, which is why
 * `subscribeDisposerBridge` below does not hold.
 */
export const subDisposerBridge = <S, M, Ctx>(
	sub: DepKeyedSub<S, M, Ctx>,
	state: S,
	dispatch: Dispatch<M>,
	ctx: Ctx,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => sub.source(state, dispatch, ctx)),
		(dispose) =>
			Effect.tryPromise({
				try: async () => {
					await dispose();
				},
				catch: (cause) => new SubDisposeError({cause}),
			}).pipe(Effect.orDie),
	).pipe(Effect.andThen(Effect.never));

/**
 * The same disposer bridge for the manual-Sub map: Demlik 0.12's `subscribe[type]` cells, each
 * returning a `Dispose`, as the Effect-valued `SubscribeHandlers` the host forks into a Sub scope.
 * The acquire opens the cell; the Scope the host provides awaits its `Dispose` on close.
 */
export const subscribeDisposerBridge = <M extends {type: string}, U extends Sub, Ctx>(
	subscribe: Subscribe<M, U, Ctx>,
): SubscribeHandlers<M, U, Ctx> => {
	const cells: Partial<SubscribeHandlers<M, U, Ctx>> = {};
	const bridge = <K extends U["type"]>(type: K): void => {
		const open = subscribe[type];
		cells[type] = (sub, ctx, dispatch) =>
			Effect.acquireRelease(
				Effect.sync(() => open(sub, ctx, dispatch)),
				(dispose) =>
					Effect.tryPromise({
						try: async () => {
							await dispose();
						},
						catch: (cause) => new SubDisposeError({cause}),
					}).pipe(Effect.orDie),
			).pipe(Effect.asVoid);
	};
	for (const type of Object.keys(subscribe)) bridge(type as U["type"]);
	return cells as SubscribeHandlers<M, U, Ctx>;
};

/**
 * A definition on Demlik 0.12's own Promise runtime: its Cmd handlers crossed through the
 * Interpret bridge, its core machine handed to `run` unchanged. Only a machine whose Subs are all
 * dep-keyed crosses — an Effect-valued `subscribe` handler has no Demlik shape to land on. The
 * parity test runs one machine both ways; nothing else should need this.
 */
export const toDemlikMachine = <
	S,
	M extends {type: string},
	C extends Cmd,
	Ctx,
	I extends InterpretHandlers<M, C, Ctx>,
	R,
>(
	definition: ActorDefinition<S, M, C, never, Ctx, I, SubscribeHandlers<M, never, Ctx>>,
	services: Context.Context<R>,
): Machine<S, M, C, never, Ctx> => ({
	...definition.machine,
	interpret: interpretPromiseBridge(services)<M, C, Ctx>(definition.interpret),
});
