/**
 * `ScriptedAiAgent` — the deterministic `TuvalAiAgent` layer every unit test and headless proof
 * runs on. It talks to nothing: a checked-in `AgentScript` is the whole backend.
 *
 * It holds no retry loop and no reconnect. A scripted disconnect fails the event stream exactly
 * once and leaves the session down, so a test can prove the retry policy lives in the handlers'
 * declared data rather than hiding in a layer (#7371).
 *
 * A prompt replays its turn's events verbatim, so a fixture reads as the conversation it stands
 * for. The three calls that carry an argument the script cannot know — `answer`, `setMode`, and
 * `start`'s resume — emit events built from that argument, and nothing else is synthesized.
 */

import {type Cause, Effect, Layer, Queue, Ref, type Scope, Stream} from "effect";
import type {Mode, PermissionDecision, PermissionRequest} from "../ports/index.ts";
import {
	ModeUnsupported,
	PageError,
	PromptError,
	StartError,
	type TransportError,
	UnknownRequest,
} from "./errors.ts";
import type {AgentEvent} from "./events.ts";
import type {AgentScript} from "./script.ts";
import {TuvalAiAgent, type TuvalAiAgentApi} from "./TuvalAiAgent.ts";

interface ScriptState {
	readonly started: boolean;
	/** The turn the next prompt replays. */
	readonly turn: number;
	/** Idempotency keys this session has seen; a repeat is dropped, not re-sent. */
	readonly keys: ReadonlySet<string>;
	readonly pending: ReadonlyMap<string, PermissionRequest>;
	readonly mode: Mode | null;
	/** False once a scripted disconnect landed. Nothing sets it back — that is the point. */
	readonly live: boolean;
}

const initial = (script: AgentScript): ScriptState => ({
	started: false,
	turn: 0,
	keys: new Set(),
	pending: new Map(),
	mode: script.modes.current,
	live: true,
});

/** A turn's `permission` events open cards and its `permission-resolved` events close them. */
const foldPending = (
	pending: ReadonlyMap<string, PermissionRequest>,
	events: ReadonlyArray<AgentEvent>,
): ReadonlyMap<string, PermissionRequest> => {
	const next = new Map(pending);
	for (const event of events) {
		if (event.kind === "permission") next.set(event.request, event.detail);
		if (event.kind === "permission-resolved") next.delete(event.request);
	}
	return next;
};

const make = (script: AgentScript): Effect.Effect<TuvalAiAgentApi, never, Scope.Scope> =>
	Effect.gen(function* () {
		// Acquired against the caller's Scope, so closing it shuts the queue: this layer's whole
		// teardown, standing where a real layer's transport teardown goes (ruling 4, #7570).
		const queue = yield* Effect.acquireRelease(
			Queue.unbounded<AgentEvent, TransportError | Cause.Done>(),
			(open) => Queue.shutdown(open),
		);
		const state = yield* Ref.make(initial(script));

		const emit = (events: ReadonlyArray<AgentEvent>): Effect.Effect<void> =>
			// Serial on purpose: one subscription, one ordering — a parallel offer would shuffle a turn.
			Effect.forEach(events, (event) => Queue.offer(queue, event), {
				concurrency: 1,
				discard: true,
			});

		const start = Effect.fn("TuvalAiAgent.start")(function* (options: {
			readonly cwd: string;
			readonly resume?: string;
		}) {
			const current = yield* Ref.get(state);
			if (!current.live) {
				return yield* new StartError({
					reason: "transport",
					cwd: options.cwd,
					detail: "the scripted transport is down and nothing reconnects it",
				});
			}
			if (options.resume !== undefined && options.resume !== script.sessionId) {
				return yield* new StartError({
					reason: "session-not-found",
					cwd: options.cwd,
					detail: `the script holds session ${script.sessionId}, not ${options.resume}`,
				});
			}
			yield* emit([{kind: "phase", phase: "starting"}]);
			if (options.resume !== undefined) {
				yield* emit(script.history.map((item) => ({kind: "item", item}) as const));
			}
			yield* emit([
				{kind: "mode", current: current.mode, available: script.modes.available},
				{kind: "phase", phase: "ready"},
			]);
			yield* Ref.update(state, (previous) => ({...previous, started: true}));
			return {sessionId: script.sessionId};
		});

		const prompt = Effect.fn("TuvalAiAgent.prompt")(function* (text: string, key?: string) {
			const current = yield* Ref.get(state);
			if (!current.live) {
				return yield* new PromptError({
					reason: "disconnected",
					detail: "the scripted transport is down and nothing reconnects it",
				});
			}
			if (!current.started) {
				return yield* new PromptError({
					reason: "no-session",
					detail: "start has not been called on this scripted session",
				});
			}
			if (key !== undefined && current.keys.has(key)) return;
			const turn = script.turns[current.turn];
			if (turn === undefined) {
				// A script that ran out is the test's own bug, not a failure this interface models.
				return yield* Effect.die(
					new Error(`the script has no turn ${current.turn} for the prompt "${text}"`),
				);
			}
			yield* Ref.update(state, (previous) => ({
				...previous,
				turn: previous.turn + 1,
				keys: key === undefined ? previous.keys : new Set(previous.keys).add(key),
				pending: foldPending(previous.pending, turn.events),
				live: turn.disconnect === undefined,
			}));
			yield* emit(turn.events);
			if (turn.disconnect !== undefined) yield* Queue.fail(queue, turn.disconnect);
		});

		const interrupt = Effect.gen(function* () {
			yield* emit(script.interrupt);
			yield* Ref.update(state, (previous) => ({
				...previous,
				pending: foldPending(previous.pending, script.interrupt),
			}));
		}).pipe(Effect.withSpan("TuvalAiAgent.interrupt"));

		const answer = Effect.fn("TuvalAiAgent.answer")(function* (
			request: string,
			decision: PermissionDecision,
		) {
			const current = yield* Ref.get(state);
			if (!current.pending.has(request)) return yield* new UnknownRequest({request});
			const next = new Map(current.pending);
			next.delete(request);
			yield* Ref.update(state, (previous) => ({...previous, pending: next}));
			yield* emit([{kind: "permission-resolved", request, decision}]);
		});

		const setMode = Effect.fn("TuvalAiAgent.setMode")(function* (mode: Mode) {
			if (!script.modes.available.includes(mode)) {
				return yield* new ModeUnsupported({mode, available: script.modes.available});
			}
			yield* Ref.update(state, (previous) => ({...previous, mode}));
			yield* emit([{kind: "mode", current: mode, available: script.modes.available}]);
		});

		const page = Effect.fn("TuvalAiAgent.page")(function* (before: string | null, limit: number) {
			const current = yield* Ref.get(state);
			if (!current.live) {
				return yield* new PageError({
					reason: "disconnected",
					detail: "the scripted transport is down and nothing reconnects it",
				});
			}
			if (!Number.isInteger(limit) || limit < 1) {
				return yield* Effect.die(
					new Error(`page was asked for ${limit} items; the port declares limit > 0`),
				);
			}
			const end =
				before === null
					? script.history.length
					: script.history.findIndex((item) => item.id === before);
			if (end < 0) {
				return yield* new PageError({
					reason: "unknown-cursor",
					detail: `no item "${before}" is in this session's history`,
				});
			}
			const from = Math.max(0, end - limit);
			return {items: script.history.slice(from, end), hasMore: from > 0};
		});

		return {
			start,
			prompt,
			interrupt,
			answer,
			setMode,
			page,
			events: Stream.fromQueue(queue),
		};
	});

export const ScriptedAiAgent = {
	layer: (script: AgentScript): Layer.Layer<TuvalAiAgent> =>
		Layer.effect(TuvalAiAgent, make(script)),
} as const;
