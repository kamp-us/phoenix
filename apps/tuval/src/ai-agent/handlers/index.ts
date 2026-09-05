/**
 * The one generic handler set that drives any `TuvalAiAgent` layer.
 *
 * Nothing here names a backend (founder ruling, 2026-09-02): every handler yields the service and
 * calls one of its seven members, so the Pi row and the Claude row differ only in the layer they
 * hand `aiAgentHandlers`. A layer's typed error never leaves as an error — each becomes a `failed`
 * Msg carrying the tag as data (ruling 3, #7570), because the window renders the refusal and a
 * crash would take the process with it. The one thing that does fail a handler is a
 * `PayloadRejected` — the route refused what this program emitted, which is a wiring bug in the
 * graph, not the agent's answer.
 *
 * The Sub is the outbound half. One subscription, one ordering (ruling 1, #7570): each event is
 * dispatched as an `event` Msg and the same fold the core runs is applied to a local projection,
 * seeded from the core's own state when the Sub opened. Same function, same seed, same order, so
 * the tail published on `transcript` is the tail the core commits — a read-back after `dispatch`
 * could not promise that, because the host applies a dispatched Msg on its own serial tail.
 *
 * The projection is the process's rather than the Sub's (`./projection.ts`), because the core's
 * transcript has a second entrance no event carries: the operator's own turn, recorded by the
 * `prompt` cell when they send it (#7978).
 */

import {Effect, type Layer, Result, Stream} from "effect";
import type {PayloadRejected, ProcessPorts} from "../../ports/index.ts";
import type {ProcessSelf} from "../../process/self.ts";
import type {HostHandlers, HostSubs} from "../../registry/program.ts";
import {
	type AgentFailure,
	type AiAgentEventsSub,
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionSub,
	foldEvent,
	initialState,
	START_ERROR,
	type WindowLimits,
} from "../core/index.ts";
import {isRefusal, planTranscriptPage, withoutLocalEchoes} from "../history/index.ts";
import type {TranscriptPagePayload} from "../ports/index.ts";
import {
	type TranscriptPage,
	TransportError,
	type TuvalAiAgent,
	type TuvalAiAgentApi,
} from "../service/index.ts";
import {type AgentServiceError, deadlineFailure, failureOf, isTimeout} from "./failures.ts";
import {type AiAgentRetryPolicy, defaultRetryPolicy, underPolicy} from "./policy.ts";
import {transcriptProjection} from "./projection.ts";
import {
	aiAgentPortNames,
	emit,
	modeStateOf,
	pendingOf,
	readSession,
	transcriptOf,
} from "./publish.ts";
import {agentSlot} from "./session.ts";

/** What every handler on this row may fail with, and what it needs to run. */
export type AiAgentHandlerError = PayloadRejected;
/**
 * The process's own two services, plus whatever the layer under the row still asks for.
 *
 * `RIn` rides out rather than being closed here, so a row built over a layer that needs a kernel
 * service says so and the spawner supplies it (#7951). A layer that needs nothing leaves `RIn`
 * `never`, which is the union unchanged.
 */
export type AiAgentHandlerServices<RIn = never> = ProcessSelf | ProcessPorts | RIn;

export interface AiAgentHandlerOptions<RIn = never> extends WindowLimits {
	readonly layer: Layer.Layer<TuvalAiAgent, never, RIn>;
	/** The working directory the Sub's projection falls back to when nothing is checkpointed. */
	readonly cwd: string;
	/** Declared data, read by `start` and the reconnect that repeats it (#7371). */
	readonly policy?: AiAgentRetryPolicy;
}

export interface AiAgentHandlerSet<RIn = never> {
	readonly handlers: HostHandlers<
		AiAgentSessionMsg,
		AiAgentSessionCmd,
		AiAgentHandlerError,
		AiAgentHandlerServices<RIn>
	>;
	readonly subs: HostSubs<
		AiAgentSessionMsg,
		AiAgentSessionSub,
		AiAgentHandlerError,
		AiAgentHandlerServices<RIn>
	>;
}

type Follow = ReadonlyArray<AiAgentSessionMsg>;

const nothing: Follow = [];

const refusal = (failure: AgentFailure): Follow => [{type: "failed", failure}];

/** A call reached a process no start has opened an agent in. There is no session, so say that. */
const noSession: AgentFailure = {
	tag: START_ERROR,
	reason: "session-not-found",
	detail: "no agent has been started in this process",
};

export const aiAgentHandlers = <RIn = never>(
	options: AiAgentHandlerOptions<RIn>,
): AiAgentHandlerSet<RIn> => {
	const policy = options.policy ?? defaultRetryPolicy;
	const limits: WindowLimits = {
		...(options.itemLimit === undefined ? {} : {itemLimit: options.itemLimit}),
		...(options.byteLimit === undefined ? {} : {byteLimit: options.byteLimit}),
	};
	const slot = agentSlot(options.layer);
	const projection = transcriptProjection();

	const withAgent = <A>(
		use: (agent: TuvalAiAgentApi) => Effect.Effect<A, AgentServiceError>,
		onDone: (value: A) => Follow,
	): Effect.Effect<Follow, never, ProcessSelf> =>
		Effect.gen(function* () {
			const agent = yield* slot.current;
			if (agent === null) return refusal(noSession);
			const answered = yield* Effect.result(use(agent));
			return Result.isFailure(answered)
				? refusal(failureOf(answered.failure))
				: onDone(answered.success);
		});

	/**
	 * `start` and `reconnect` are one call under two names, and ruling 4 (#7570) makes that call
	 * "rebuild the layer, then start": the transport lives in the layer's build, so resuming a
	 * session id against the handle a disconnect already killed reaches nothing.
	 */
	const open = (
		cwd: string,
		resume: string | null,
	): Effect.Effect<Follow, never, ProcessSelf | RIn> =>
		Effect.gen(function* () {
			const agent = yield* slot.rebuild;
			const started = yield* Effect.result(
				underPolicy(agent.start(resume === null ? {cwd} : {cwd, resume}), policy),
			);
			if (Result.isSuccess(started)) {
				return [{type: "started", sessionId: started.success.sessionId}];
			}
			const error = started.failure;
			return refusal(
				isTimeout(error)
					? deadlineFailure(START_ERROR, policy.deadlineMillis)
					: failureOf(error as AgentServiceError),
			);
		});

	/**
	 * The backend already applied `limit`; this re-plans the slice so the page ends on a whole
	 * exchange, and reads `next` off the plan unless the backend says there is more behind it.
	 */
	const pagePayload = (page: TranscriptPage, limit: number): TranscriptPagePayload | null => {
		const planned = planTranscriptPage(page.items, {limit});
		if (isRefusal(planned)) return null;
		const next = planned.next ?? (page.hasMore ? (planned.items[0]?.id ?? null) : null);
		return {kind: "page", items: planned.items, omitted: planned.omitted, next};
	};

	const handlers: AiAgentHandlerSet<RIn>["handlers"] = {
		// The one handler that calls nothing. It answers the fresh `init`'s Cmd with the Msg that
		// opens the session, and the `start` cell does the rest — including refusing a second open.
		// Doing the work here instead would run it inside the spawn (`host/actor.ts` awaits an init
		// Cmd's handler before `make` returns), which would hold the spawning process's own tail
		// for as long as the backend takes to answer.
		"aiAgent.boot": (cmd) => Effect.succeed([{type: "start", cwd: cmd.cwd, resume: null}]),

		"aiAgent.start": (cmd) => open(cmd.cwd, cmd.resume),

		"aiAgent.reconnect": (cmd) => open(cmd.cwd, cmd.sessionId),

		// The one handler that reads the committed state rather than folding forward from it: there
		// is no event to fold, which is the whole point — a restored session's tail and its pending
		// cards are already in state and nothing else will ever push them out (#7608).
		"aiAgent.republish": () =>
			Effect.gen(function* () {
				const state = yield* readSession;
				if (state === null) return nothing;
				yield* emit(aiAgentPortNames.transcript, transcriptOf(state));
				yield* emit(aiAgentPortNames.permissionPending, pendingOf(state));
				yield* emit(aiAgentPortNames.modeState, modeStateOf(state));
				return nothing;
			}),

		// The turn the core recorded in the very commit that produced this Cmd (#7978) rides no
		// layer event, so the Sub's projection would publish a tail with the operator's half
		// missing (#7979). Re-seeding is sound here rather than a race: this Cmd is applied after
		// every event Msg the projection has folded, so the committed state is never behind it.
		"aiAgent.prompt": (cmd) =>
			Effect.gen(function* () {
				const state = yield* readSession;
				if (state !== null) {
					yield* projection.seed(state);
					yield* emit(aiAgentPortNames.transcript, transcriptOf(state));
				}
				return yield* withAgent(
					(agent) => agent.prompt(cmd.text, cmd.key),
					() => nothing,
				);
			}),

		"aiAgent.interrupt": () =>
			withAgent(
				(agent) => agent.interrupt,
				() => nothing,
			),

		"aiAgent.answer": (cmd) =>
			withAgent(
				// `cmd.message` is not forwarded: the founder's pinned `answer` signature (#7570 ruling 3,
				// held by `../service/boundary.unit.test.ts`) takes the request and the decision only.
				// The note rides the Cmd so nothing between the window and here loses it; #7875 tracks
				// the last hop, which needs a ruling before that signature can widen.
				(agent) => agent.answer(cmd.request, cmd.decision),
				() => nothing,
			),

		"aiAgent.setMode": (cmd) =>
			withAgent(
				(agent) => agent.setMode(cmd.mode),
				() => nothing,
			),

		// The page goes back two ways: the `paged` Msg tells the core what the last page was, and
		// the payload rides `pageReply` so the window that asked gets the items themselves.
		"aiAgent.page": (cmd) =>
			Effect.gen(function* () {
				const agent = yield* slot.current;
				if (agent === null) return refusal(noSession);
				const answered = yield* Effect.result(agent.page(cmd.before, cmd.limit));
				if (Result.isFailure(answered)) return refusal(failureOf(answered.failure));
				// A backend that stores the conversation keeps its own copy of the turn the core
				// recorded at the send, under its own id, and no id joins the two (#7979). Dropped
				// here rather than at the window, so both routes one page takes — the `pageReply`
				// port and the `paged` Msg — carry a single copy of it.
				const held = yield* readSession;
				const page = {
					items: withoutLocalEchoes(answered.success.items, held?.transcript.items ?? []),
					hasMore: answered.success.hasMore,
				};
				const payload = pagePayload(page, cmd.limit);
				if (payload !== null) yield* emit(aiAgentPortNames.pageReply, payload);
				return [{type: "paged", page}] satisfies Follow;
			}),
	};

	const events = (sub: AiAgentEventsSub, dispatch: (msg: AiAgentSessionMsg) => void) =>
		Effect.gen(function* () {
			const agent = yield* slot.current;
			if (agent === null) return;
			const seed = yield* readSession;
			yield* projection.seed(seed ?? initialState(options.cwd));

			yield* Stream.runForEach(agent.events, (event) =>
				Effect.gen(function* () {
					dispatch({type: "event", sessionId: sub.sessionId, event});
					const next = yield* projection.fold((state) => foldEvent(state, event, limits));
					if (next === null) return;
					if (event.kind === "item") yield* emit(aiAgentPortNames.transcript, transcriptOf(next));
					if (event.kind === "permission" || event.kind === "permission-resolved") {
						yield* emit(aiAgentPortNames.permissionPending, pendingOf(next));
					}
					if (event.kind === "mode") yield* emit(aiAgentPortNames.modeState, modeStateOf(next));
				}),
			).pipe(
				Effect.catchIf(
					(error): error is TransportError => error instanceof TransportError,
					(error) => Effect.sync(() => dispatch({type: "failed", failure: failureOf(error)})),
				),
			);
		});

	return {handlers, subs: {"aiAgent.events": events}};
};

export {type AiAgentRetryPolicy, defaultRetryPolicy} from "./policy.ts";
export {aiAgentPortNames} from "./publish.ts";
