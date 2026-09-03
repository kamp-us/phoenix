/**
 * The Effect host: runs one Demlik core machine as a scoped actor.
 *
 * Stands in for Demlik's own `tea-effect` until kamp-us/demlik#36 ships, and mirrors `run` in
 * `kamp-us/demlik/src/run.ts` (0.12) step for step: save before effects, one serial transition
 * tail, reconcile then interpret, and an absolute stop gate whose only leniency is Demlik's own
 * classified discard while draining. What differs is the substrate — one Semaphore is the tail,
 * a Scope is every Sub's lifetime, and handler failures ride the Effect error channel.
 */

import {
	applyCellChecked,
	type Cmd,
	DispatchDiscardedError,
	IdentityDropNotice,
	RuntimeDiscardedError,
	RuntimeDiscardNotice,
	type Store,
	type Sub,
	SubIdCollisionError,
	type Supervision,
	structuralHash,
} from "@demlik/tea";
import {Cause, type Context, Effect, Exit, Latch, Layer, Result, Scope, Semaphore} from "effect";
import type {
	ActorDefinition,
	ErrorOf,
	HostErrorPhase,
	InterpretHandlers,
	OnError,
	ServicesOf,
	SubscribeHandlers,
} from "./definition.ts";
import {subDisposerBridge} from "./demlik-bridges.ts";
import {ActorStoppedError, StoreError, UserCodeThrew} from "./errors.ts";

export type DispatchError<E> = E | StoreError | DispatchDiscardedError | ActorStoppedError;

export interface ActorHandle<S, M extends {type: string}, E = never> {
	/** Apply `msg`, then wait for every transitive follow-up — Demlik's `dispatch`. */
	readonly dispatch: (msg: M) => Effect.Effect<void, DispatchError<E>>;
	/** Apply `msg` and return after its own transition — Demlik's `dispatchOnce`. */
	readonly dispatchOnce: (msg: M) => Effect.Effect<void, DispatchError<E>>;
	readonly getState: () => S;
	/** Resolves once nothing is pending on the transition tail. */
	readonly idle: Effect.Effect<void>;
	/** Drain, close every Sub, flush the last save. Runs on scope close; idempotent. */
	readonly stop: Effect.Effect<void>;
}

const defaultOnError: OnError = (error) =>
	error instanceof RuntimeDiscardNotice ? Effect.logWarning(error) : Effect.logError(error);

type Gate = "open" | "draining" | "closed";

const normalizeSupervision = <S, M extends {type: string}>(
	supervision: Supervision<S, M> | undefined,
): Extract<Supervision<S, M>, object> =>
	supervision === undefined
		? {strategy: "stop"}
		: typeof supervision === "string"
			? {strategy: supervision}
			: supervision;

const storeLoad = <S>(store: Store<S>) =>
	Effect.tryPromise({
		try: () => store.load(),
		catch: (cause) => new StoreError({operation: "load", cause}),
	});

const storeSave = <S>(store: Store<S>, state: S) =>
	Effect.tryPromise({
		try: () => store.save(state),
		catch: (cause) => new StoreError({operation: "save", cause}),
	});

type Reduced<S, C> =
	| {readonly kind: "dropped"}
	| {readonly kind: "applied"; readonly next: S; readonly cmds: readonly C[]};

type Probe = {readonly kind: "inactive"} | {readonly kind: "active"; readonly id: string};

export const make = Effect.fn("Tuval.host.make")(function* <
	S,
	M extends {type: string},
	C extends Cmd,
	U extends Sub,
	Ctx,
	I extends InterpretHandlers<M, C, Ctx>,
	B extends SubscribeHandlers<M, U, Ctx>,
>(definition: ActorDefinition<S, M, C, U, Ctx, I, B>) {
	type E = ErrorOf<I> | ErrorOf<B>;
	type R = ServicesOf<I> | ServicesOf<B>;

	const scope = yield* Effect.scope;
	const services = yield* Effect.context<R>();
	const subsScope = yield* Scope.fork(scope);
	const tail = yield* Semaphore.make(1);
	const quiet = yield* Latch.make(true);
	const stopped = yield* Latch.make(false);

	const {machine, store} = definition;
	const ctx = ((definition as {ctx?: Ctx}).ctx ?? {}) as Ctx;
	const supervision = normalizeSupervision(definition.supervision);
	const onError = definition.onError ?? defaultOnError;
	const onCommit = definition.onCommit;

	let state: S;
	let gate: Gate = "open";
	let stopping = false;
	let pending = 0;
	let inFlightCmds = 0;
	const manualSubs = new Map<string, Scope.Closeable>();
	const keyedSubs = new Map<number, {readonly id: string; readonly scope: Scope.Closeable}>();

	const report = (error: unknown, phase: HostErrorPhase) =>
		onError(error, {phase}).pipe(
			Effect.catchCause((cause) => Effect.logError(Cause.squash(cause))),
		);
	const reportCause = (phase: HostErrorPhase) => (cause: Cause.Cause<unknown>) =>
		report(Cause.squash(cause), phase);

	const enter = (): void => {
		pending++;
		quiet.closeUnsafe();
	};
	const leave = Effect.sync(() => {
		pending--;
		if (pending === 0) quiet.openUnsafe();
	});

	const closeSub = (sub: Scope.Closeable) =>
		Scope.close(sub, Exit.void).pipe(Effect.catchCause(reportCause("sub-cleanup")));

	const dispatchUnawaited = (msg: M): void => {
		if (gate === "closed") {
			Effect.runFork(report(new ActorStoppedError({msgType: msg.type}), "follow-up"));
			return;
		}
		enter();
		Effect.runFork(
			Effect.forkIn(
				enqueue(msg).pipe(
					Effect.catchCause((cause) => {
						const error = Cause.squash(cause);
						return report(error, error instanceof DispatchDiscardedError ? "discard" : "follow-up");
					}),
					Effect.ensuring(leave),
					Effect.provideContext(services),
				),
				scope,
			),
		);
	};

	const runInterpret = Effect.fn("Tuval.host.interpret")(function* (cmds: readonly C[]) {
		for (const cmd of cmds) {
			const handler = definition.interpret[cmd.type as C["type"]];
			if (!handler) continue;
			inFlightCmds++;
			const follow = yield* (
				handler(cmd as Extract<C, {type: C["type"]}>, ctx, dispatchUnawaited) as Effect.Effect<
					M | void,
					E,
					R
				>
			).pipe(Effect.ensuring(Effect.sync(() => inFlightCmds--)));
			if (follow !== undefined && follow !== null) dispatchUnawaited(follow);
		}
	});

	const probeKeyed = (deps: (state: S) => unknown) =>
		Effect.try({
			try: (): Probe => {
				const slice = deps(state);
				return slice === null || slice === undefined
					? {kind: "inactive"}
					: {kind: "active", id: structuralHash(slice)};
			},
			catch: (cause) => new UserCodeThrew({cause}),
		});

	const disposeKeyed = Effect.fn("Tuval.host.disposeKeyed")(function* (index: number) {
		const running = keyedSubs.get(index);
		if (running === undefined) return;
		keyedSubs.delete(index);
		yield* closeSub(running.scope);
	});

	const reconcile = Effect.fn("Tuval.host.reconcile")(function* () {
		let firstError: unknown = null;
		for (const [index, entry] of (machine.subs ?? []).entries()) {
			const probed = yield* probeKeyed(entry.deps).pipe(Effect.exit);
			if (Exit.isFailure(probed)) {
				firstError ??= Cause.squash(probed.cause);
				continue;
			}
			const probe = probed.value;
			if (probe.kind === "inactive") {
				yield* disposeKeyed(index);
				continue;
			}
			if (keyedSubs.get(index)?.id === probe.id) continue;
			yield* disposeKeyed(index);
			const child = yield* Scope.fork(subsScope);
			const opened = yield* subDisposerBridge(entry, state, dispatchUnawaited, ctx).pipe(
				Effect.provideService(Scope.Scope, child),
				Effect.exit,
			);
			if (Exit.isFailure(opened)) {
				firstError ??= Cause.squash(opened.cause);
				yield* closeSub(child);
				continue;
			}
			keyedSubs.set(index, {id: probe.id, scope: child});
		}

		if (machine.subscriptions) {
			const desired = machine.subscriptions(state);
			const desiredTypeById = new Map<string, string>();
			for (const sub of desired) {
				const existing = desiredTypeById.get(sub.id);
				if (existing !== undefined && existing !== sub.type) {
					return yield* Effect.die(new SubIdCollisionError(sub.id, existing, sub.type));
				}
				desiredTypeById.set(sub.id, sub.type);
			}
			for (const [id, running] of manualSubs) {
				if (desiredTypeById.has(id)) continue;
				manualSubs.delete(id);
				yield* closeSub(running);
			}
			for (const sub of desired) {
				if (manualSubs.has(sub.id)) continue;
				const handler = definition.subscribe[sub.type as U["type"]];
				if (!handler) continue;
				const child = yield* Scope.fork(subsScope);
				const work = handler(
					sub as Extract<U, {type: U["type"]}>,
					ctx,
					dispatchUnawaited,
				) as Effect.Effect<void, E, R | Scope.Scope>;
				yield* Effect.forkIn(
					work.pipe(
						Effect.provideService(Scope.Scope, child),
						Effect.provideContext(services),
						Effect.catchCause(reportCause("sub-fiber")),
					),
					child,
					{startImmediately: true},
				);
				manualSubs.set(sub.id, child);
			}
		}
		if (firstError !== null) return yield* Effect.die(firstError);
	});

	const commit = Effect.fn("Tuval.host.commit")(function* (next: S, cmds: readonly C[]) {
		state = next;
		if (store) yield* storeSave(store, next);
		yield* reconcile();
		yield* runInterpret(cmds);
		if (onCommit) yield* onCommit(state);
	});

	const isMisaddressed = (msg: M): boolean => {
		if (machine.identity === undefined) return false;
		const addressed = machine.identity.ofMsg(msg);
		if (addressed === undefined) return false;
		const own = machine.identity.ofState(state);
		if (own === undefined) return false;
		return structuralHash(addressed) !== structuralHash(own);
	};

	const reduce = (msg: M) =>
		Effect.try({
			try: (): Reduced<S, C> => {
				if (isMisaddressed(msg)) return {kind: "dropped"};
				const [next, cmds] = applyCellChecked<S, M, C>(machine, state, msg);
				return {kind: "applied", next, cmds};
			},
			catch: (cause) => new UserCodeThrew({cause}),
		});

	const step = Effect.fn("Tuval.host.step")(function* (msg: M) {
		const reduced = yield* reduce(msg).pipe(Effect.result);
		if (Result.isFailure(reduced)) {
			const error = reduced.failure.cause;
			yield* report(error, "reduce");
			switch (supervision.strategy) {
				case "restart":
					return yield* commit(supervision.rehydrate(state, msg, error), []);
				case "escalate":
					return yield* Effect.die(error);
				default:
					gate = "closed";
					return yield* Effect.die(error);
			}
		}
		if (reduced.success.kind === "dropped") {
			return yield* report(new IdentityDropNotice(msg.type), "identity-drop");
		}
		yield* commit(reduced.success.next, reduced.success.cmds);
	});

	const enqueue = (msg: M): Effect.Effect<void, DispatchError<E>, R> =>
		Effect.suspend((): Effect.Effect<void, DispatchError<E>, R> => {
			if (gate === "draining") return Effect.fail(new DispatchDiscardedError(msg.type));
			if (gate === "closed") return Effect.fail(new ActorStoppedError({msgType: msg.type}));
			return tail.withPermits(1)(step(msg));
		});

	const dispatchOnce = (msg: M): Effect.Effect<void, DispatchError<E>> =>
		Effect.suspend(() => {
			enter();
			return enqueue(msg).pipe(Effect.ensuring(leave), Effect.provideContext(services));
		});

	const idle: Effect.Effect<void> = quiet.await;

	const dispatch = (msg: M) => dispatchOnce(msg).pipe(Effect.andThen(idle));

	const teardown = Effect.gen(function* () {
		if (gate === "open") gate = "draining";
		if (inFlightCmds > 0) yield* report(new RuntimeDiscardedError(inFlightCmds), "discard");
		yield* quiet.await;
		gate = "closed";
		manualSubs.clear();
		keyedSubs.clear();
		yield* closeSub(subsScope);
		if (store) yield* storeSave(store, state).pipe(Effect.catchCause(reportCause("stop-save")));
	}).pipe(
		Effect.ensuring(Effect.sync(() => void stopped.openUnsafe())),
		Effect.withSpan("Tuval.host.stop"),
	);

	const stop: Effect.Effect<void> = Effect.suspend(() => {
		if (stopping) return stopped.await;
		stopping = true;
		return teardown;
	});

	const loaded = store ? store.migrate(yield* storeLoad(store)) : null;
	const [initial, initCmds] = machine.init(loaded, ctx);
	state = initial;
	if (store) yield* storeSave(store, state);
	yield* Scope.addFinalizer(scope, stop);
	yield* tail.withPermits(1)(
		Effect.gen(function* () {
			yield* reconcile();
			yield* runInterpret(initCmds);
			if (onCommit) yield* onCommit(state);
		}),
	);

	const handle: ActorHandle<S, M, E> = {
		dispatch,
		dispatchOnce,
		getState: () => state,
		idle,
		stop,
	};
	return handle;
});

/** The actor as a service: `Layer.effect` runs `make` in the layer's own scope (`LLMS.md` "Writing Effect services"). */
export const layer = <
	Id,
	S,
	M extends {type: string},
	C extends Cmd,
	U extends Sub,
	Ctx,
	I extends InterpretHandlers<M, C, Ctx>,
	B extends SubscribeHandlers<M, U, Ctx>,
>(
	key: Context.Key<Id, ActorHandle<S, M, ErrorOf<I> | ErrorOf<B>>>,
	definition: ActorDefinition<S, M, C, U, Ctx, I, B>,
) => Layer.effect(key, make(definition));
