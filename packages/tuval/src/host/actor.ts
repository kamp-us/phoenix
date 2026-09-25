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
	NoCellError,
	RuntimeDiscardedError,
	RuntimeDiscardNotice,
	type Store,
	type Supervision,
	structuralHash,
} from "@demlik/tea";
import {
	Cause,
	type Context,
	Effect,
	Exit,
	type Fiber,
	Latch,
	Layer,
	Result,
	Scope,
	Semaphore,
} from "effect";
import {desiredSub, type Sub} from "../registry/sub.ts";
import type {
	ActorDefinition,
	ErrorOf,
	HostErrorPhase,
	InterpretHandlers,
	OnError,
	ServicesOf,
	SubscribeHandlers,
} from "./definition.ts";
import {
	ActorStoppedError,
	MissingSubRunnerError,
	MsgNotAcceptedError,
	StoreError,
	UserCodeThrew,
} from "./errors.ts";

export type DispatchError<E> =
	| E
	| StoreError
	| DispatchDiscardedError
	| ActorStoppedError
	| MsgNotAcceptedError;

export interface ActorHandle<S, M extends {type: string}, E = never> {
	/** Apply `msg`, then wait for every transitive follow-up — Demlik's `dispatch`. */
	readonly dispatch: (msg: M) => Effect.Effect<void, DispatchError<E>>;
	/** Apply `msg` and return after its own transition — Demlik's `dispatchOnce`. */
	readonly dispatchOnce: (msg: M) => Effect.Effect<void, DispatchError<E>>;
	readonly getState: () => S;
	/** Resolves once nothing is pending on the transition tail. */
	readonly idle: Effect.Effect<void>;
	/** Drain, close every Sub, checkpoint the last worthy state. Runs on scope close; idempotent. */
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

/**
 * A Sub the host has armed. `mark` is its lifetime: `"running"` until its fiber exits, then
 * `"failed"` or `"ended"` — and reconcile re-arms neither, because the same id means the same
 * lifetime. The Scope outlives the mark: it is the Sub's registration, and its close is where a
 * Demlik-bridged `Dispose` runs, so only the state ceasing to desire the Sub releases it.
 */
type ArmedSub = {
	readonly type: string;
	readonly scope: Scope.Closeable;
	readonly mark: "running" | "failed" | "ended";
};

/** Records an armed Sub's exit mark, or answers `false` when its entry has already moved on. */
type SettleSub = (mark: "failed" | "ended") => boolean;

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
	const checkpointWorthy = definition.checkpointWorthy;

	/**
	 * The one write path to the store, so a state the program calls not-checkpoint-worthy is
	 * unreachable from every save site rather than from the commit alone (#8170).
	 */
	const checkpoint = (next: S): Effect.Effect<void, StoreError> =>
		store === undefined || checkpointWorthy?.(next) === false
			? Effect.void
			: storeSave(store, next);

	let state: S;
	let gate: Gate = "open";
	let stopping = false;
	let pending = 0;
	let inFlightCmds = 0;
	const armedSubs = new Map<string, ArmedSub>();

	const report = (error: unknown, phase: HostErrorPhase) =>
		onError(error, {phase}).pipe(
			Effect.catchCause((cause) => Effect.logError(Cause.squash(cause))),
		);
	/**
	 * A cause carrying nothing but interrupts is a stop the host asked for, so `onError` never sees
	 * it: squashing one yields `All fibers interrupted without error`, which read as a real failure
	 * at ERROR on every clean teardown (#7779).
	 */
	const reportCause = (phase: HostErrorPhase) => (cause: Cause.Cause<unknown>) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.logDebug(Cause.pretty(cause))
			: report(Cause.squash(cause), phase);

	const enter = (): void => {
		pending++;
		quiet.closeUnsafe();
	};
	const leave = (): void => {
		pending--;
		if (pending === 0) quiet.openUnsafe();
	};
	const leaving = Effect.sync(leave);

	const closeSub = (sub: Scope.Closeable) =>
		Scope.close(sub, Exit.void).pipe(Effect.catchCause(reportCause("sub-cleanup")));

	const dispatchUnawaited = (msg: M): void => {
		if (gate === "closed") {
			Effect.runFork(report(new ActorStoppedError({msgType: msg.type}), "follow-up"));
			return;
		}
		enter();
		Effect.runFork(
			Effect.flatMap(
				Effect.forkIn(
					enqueue(msg).pipe(
						Effect.catchCause((cause) => {
							const error = Cause.squash(cause);
							return report(
								error,
								error instanceof DispatchDiscardedError ? "discard" : "follow-up",
							);
						}),
						Effect.provideContext(services),
					),
					scope,
				),
				// The count is settled on the fiber's Exit, never inside its body: a follow-up forked
				// into the process Scope and interrupted before it ever starts — a stop taken in the
				// same tick as the dispatch, which is what a session opening itself at spawn makes
				// ordinary (#7925) — produces an Exit and runs no `ensuring`, so an in-body decrement
				// leaves `pending` above zero and `stop` waits on `quiet` for ever.
				(fiber) => Effect.sync(() => fiber.addObserver(leave)),
			),
		);
	};

	/**
	 * ADR 0408: a Sub failure its runner did not map into a Msg is reported under `"sub-fiber"` and
	 * closes the process's Scope with that failure as its Exit.
	 */
	const closeOnSubError = (settle: SettleSub, cause: Cause.Cause<unknown>) =>
		Effect.gen(function* () {
			yield* report(Cause.squash(cause), "sub-fiber");
			if (!settle("failed")) return;
			yield* Scope.close(scope, Exit.failCause(cause));
		});

	/**
	 * Fork one Sub's work into its own Scope. `startImmediately` runs the handler's synchronous head
	 * before this returns (`forkIn`, `effect/Effect` rc.112).
	 */
	const armSub = (
		work: Effect.Effect<void, E, R | Scope.Scope>,
		child: Scope.Closeable,
	): Effect.Effect<Fiber.Fiber<void, E>> =>
		Effect.forkIn(
			work.pipe(Effect.provideService(Scope.Scope, child), Effect.provideContext(services)),
			child,
			{startImmediately: true},
		);

	/**
	 * The Sub's exit, read from a detached fiber: a failure closes the process Scope, and a fiber
	 * living under that Scope would end up waiting on its own interruption.
	 */
	const observeSub = (fiber: Fiber.Fiber<void, E>, settle: SettleSub): void => {
		fiber.addObserver((exit) => {
			if (Exit.isSuccess(exit)) {
				settle("ended");
				return;
			}
			if (Cause.hasInterruptsOnly(exit.cause)) return;
			Effect.runFork(closeOnSubError(settle, exit.cause));
		});
	};

	const settleArmed =
		(id: string, child: Scope.Closeable): SettleSub =>
		(mark) => {
			const armed = armedSubs.get(id);
			if (armed?.scope !== child) return false;
			armedSubs.set(id, {...armed, mark});
			return true;
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

	const desire = (entry: NonNullable<typeof machine.subs>[number]) =>
		Effect.try({
			try: () => desiredSub<S, U>(entry, state),
			catch: (cause) => new UserCodeThrew({cause}),
		});

	/**
	 * The one Sub path, in the order `reconcileSubs` in `@demlik/tea` 0.18 takes: derive each entry's
	 * id from its `type` and `deps`, stop every armed id no entry still asks for, then start the
	 * runner for each id that is new. An id that holds is left alone whatever its mark, so a `failed`
	 * or `ended` Sub is re-armed only under a new id. An entry whose `deps` throws leaves its type's
	 * armed Subs standing: this state never said whether it still wants them.
	 */
	const reconcile = Effect.fn("Tuval.host.reconcile")(function* () {
		let firstError: unknown = null;
		const desired = new Map<string, U>();
		const unreadTypes = new Set<string>();
		for (const entry of machine.subs ?? []) {
			const probed = yield* desire(entry).pipe(Effect.exit);
			if (Exit.isFailure(probed)) {
				firstError ??= Cause.squash(probed.cause);
				unreadTypes.add(entry.type);
				continue;
			}
			if (probed.value !== null) desired.set(probed.value.id, probed.value);
		}
		for (const [id, armed] of armedSubs) {
			if (desired.has(id) || unreadTypes.has(armed.type)) continue;
			armedSubs.delete(id);
			yield* closeSub(armed.scope);
		}
		for (const [id, sub] of desired) {
			if (armedSubs.has(id)) continue;
			const handler = definition.subscribe[sub.type as U["type"]];
			if (!handler) {
				firstError ??= new MissingSubRunnerError({subType: sub.type});
				continue;
			}
			const child = yield* Scope.fork(subsScope);
			armedSubs.set(id, {type: sub.type, scope: child, mark: "running"});
			const work = handler(
				sub as Extract<U, {type: U["type"]}>,
				ctx,
				dispatchUnawaited,
			) as Effect.Effect<void, E, R | Scope.Scope>;
			observeSub(yield* armSub(work, child), settleArmed(id, child));
		}
		if (firstError !== null) return yield* Effect.die(firstError);
	});

	/**
	 * This commit's publication, owed to the world however its Cmds settle: by the time a handler
	 * runs the state is applied and checkpointed. Before #8538 the publication sat after
	 * `runInterpret` in the same error channel, so one failing handler aborted the commit before it
	 * and the process's public revision froze at 0 while its state went on advancing.
	 */
	const published = onCommit === undefined ? Effect.void : Effect.suspend(() => onCommit(state));

	const commit = Effect.fn("Tuval.host.commit")(function* (next: S, cmds: readonly C[]) {
		state = next;
		yield* checkpoint(next);
		yield* reconcile();
		yield* runInterpret(cmds).pipe(Effect.ensuring(published));
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
			// Demlik throws `NoCellError` before any of the machine's own code runs, so it says the
			// program does not take this Msg — never that the program is faulty. Supervision must not
			// see it: one stray wire Msg would otherwise close the gate under the `stop` default (#7973).
			catch: (cause): UserCodeThrew | MsgNotAcceptedError =>
				cause instanceof NoCellError
					? new MsgNotAcceptedError({msgType: cause.msgType, stateName: cause.stateName})
					: new UserCodeThrew({cause}),
		});

	const step = Effect.fn("Tuval.host.step")(function* (msg: M) {
		const reduced = yield* reduce(msg).pipe(Effect.result);
		if (Result.isFailure(reduced)) {
			if (reduced.failure instanceof MsgNotAcceptedError)
				return yield* Effect.fail(reduced.failure);
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
			return enqueue(msg).pipe(Effect.ensuring(leaving), Effect.provideContext(services));
		});

	const idle: Effect.Effect<void> = quiet.await;

	const dispatch = (msg: M) => dispatchOnce(msg).pipe(Effect.andThen(idle));

	const teardown = Effect.gen(function* () {
		if (gate === "open") gate = "draining";
		if (inFlightCmds > 0) yield* report(new RuntimeDiscardedError(inFlightCmds), "discard");
		yield* quiet.await;
		gate = "closed";
		armedSubs.clear();
		yield* closeSub(subsScope);
		yield* checkpoint(state).pipe(Effect.catchCause(reportCause("stop-save")));
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
	yield* checkpoint(state);
	yield* Scope.addFinalizer(scope, stop);
	yield* tail.withPermits(1)(
		Effect.gen(function* () {
			yield* reconcile();
			yield* runInterpret(initCmds);
			yield* published;
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
