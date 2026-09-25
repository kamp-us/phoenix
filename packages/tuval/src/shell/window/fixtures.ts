/**
 * The test double for the window contract: one in-memory process that several windows can be opened
 * onto. It exists to prove the contract is satisfiable without a kernel, a socket or a renderer —
 * the transport (#7517) implements the same `WindowHost` over the wire, and a renderer cannot tell
 * the two apart, which is the whole point of the seam being transport-blind.
 *
 * `SubscriptionRef` is the process's public state because at the pin (4.0.0-rc.112) its `make`
 * builds a `PubSub.unbounded({replay: 1})` and publishes the initial value, and `changes` is
 * `Stream.fromPubSub` over it — so a new subscriber gets the current value first and then every
 * update, which is exactly what `readProcess` promises.
 */

import {type Cmd, defineMachine} from "@demlik/tea";
import {Effect, type Stream, SubscriptionRef} from "effect";
import type {Message, ProcessId} from "../../process/process.ts";
import {type AnyProgram, type Program, ProgramId} from "../../registry/program.ts";
import {
	type DispatchResult,
	delivered,
	type ProcessView,
	processGone,
	type ViewState,
	type WindowHost,
	type WindowId,
} from "./host.ts";

export interface TestProcess<S, M extends Message> {
	readonly id: ProcessId;
	/** Every Msg dispatched through any window over this process, in arrival order. */
	readonly inbox: () => ReadonlyArray<M>;
	/** Commit a transition: `revision` moves and every window over this process sees the new state. */
	readonly commit: (state: S) => Effect.Effect<void>;
	/** The process leaves the table. From here on every window over it reads `ProcessGone`. */
	readonly stop: Effect.Effect<void>;
	/** Open a window onto this process: its own id, its own view slot, the one shared state. */
	readonly window: <V extends ViewState>(
		windowId: WindowId,
		initialView: V,
	) => Effect.Effect<WindowHost<S, M, V>>;
}

export const testProcess = <S, M extends Message = Message>(
	id: ProcessId,
	initial: S,
): Effect.Effect<TestProcess<S, M>> =>
	Effect.gen(function* () {
		const state = yield* SubscriptionRef.make<ProcessView<S>>({
			_tag: "Live",
			processId: id,
			lifecycle: "running",
			revision: 0,
			state: initial,
		});
		const received: Array<M> = [];

		const commit = (next: S) =>
			SubscriptionRef.update(state, (current) =>
				current._tag === "Live"
					? {...current, revision: current.revision + 1, state: next}
					: current,
			);

		const dispatch = (msg: M): Effect.Effect<DispatchResult> =>
			Effect.gen(function* () {
				const current = yield* SubscriptionRef.get(state);
				if (current._tag === "ProcessGone") return current;
				received.push(msg);
				return delivered;
			});

		const window = <V extends ViewState>(windowId: WindowId, initialView: V) =>
			Effect.gen(function* () {
				// One ref per window: this is the slot two windows over one process must not share.
				const view = yield* SubscriptionRef.make(initialView);
				const readProcess: Stream.Stream<ProcessView<S>> = SubscriptionRef.changes(state);
				return {
					windowId,
					processId: id,
					readProcess,
					dispatch,
					view: () => SubscriptionRef.getUnsafe(view),
					setView: (next: V) => SubscriptionRef.set(view, next),
				} satisfies WindowHost<S, M, V>;
			});

		return {
			id,
			inbox: () => [...received],
			commit,
			stop: SubscriptionRef.set(state, processGone(id)),
			window,
		};
	});

// Two registry rows, one carrying a renderer reference and one carrying none, so `rendererFor`'s
// three arms are exercised against a real `Program` rather than a hand-shaped object literal.

type CounterState = {readonly count: number};
type CounterMsg = {readonly type: "tick"};

const counterCore = defineMachine<CounterState, CounterMsg, Cmd<never>, never, unknown>({
	init: (loaded) => [loaded ?? {count: 0}, []],
	update: {tick: (state) => [{count: state.count + 1}, []]},
});

const row = (id: string, renderer?: {readonly kind: "host-native"; readonly ref: string}) =>
	({
		id: ProgramId.make(id),
		core: counterCore,
		ports: {},
		handlers: {},
		capabilities: [],
		...(renderer === undefined ? {} : {renderer}),
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host: "local"},
	}) satisfies Program<CounterState, CounterMsg, Cmd<never>, never, unknown, never, never>;

/** A program that shows in a window: its row names the `tuval/counter` host-native renderer. */
export const counterRow: AnyProgram = row("counter", {kind: "host-native", ref: "tuval/counter"});

/** A program that runs and never shows in a window: no renderer reference on its row. */
export const noRendererRow: AnyProgram = row("headless");
