/**
 * The one generic handler set that drives any `TuvalAiAgent` layer.
 *
 * Nothing here names a backend (founder ruling, 2026-09-02): every handler yields the service and
 * calls one of its members, so the Pi row and the Claude row differ only in the layer they
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

import {Effect, type Layer, Option, Result, Stream} from "effect";
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
import {isRefusal, pageCursor, planTranscriptPage, withoutLocalEchoes} from "../history/index.ts";
import {SessionOpening} from "../opening.ts";
import type {Mode, TranscriptPagePayload} from "../ports/index.ts";
import {
	type ResumeTarget,
	type StartOptions,
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
	const projection = transcriptProjection(limits);

	/**
	 * `onFail` is how a call whose refusal belongs to something the core is holding open answers for
	 * it. The default drops the failure into the session's own slot, which is right for a call that
	 * left nothing behind; `aiAgent.answer` overrides it, because a card marked `answering` is
	 * cleared by nothing else (#8006).
	 */
	const withAgent = <A>(
		use: (agent: TuvalAiAgentApi) => Effect.Effect<A, AgentServiceError>,
		onDone: (value: A) => Follow,
		onFail: (failure: AgentFailure) => Follow = refusal,
	): Effect.Effect<Follow, never, ProcessSelf> =>
		Effect.gen(function* () {
			const agent = yield* slot.current;
			if (agent === null) return onFail(noSession);
			const answered = yield* Effect.result(use(agent));
			return Result.isFailure(answered)
				? onFail(failureOf(answered.failure))
				: onDone(answered.success);
		});

	/**
	 * `start` and `reconnect` are one call under two names, and ruling 4 (#7570) makes that call
	 * "rebuild the layer, then start": the transport lives in the layer's build, so resuming a
	 * session id against the handle a disconnect already killed reaches nothing.
	 */
	const open = (
		cwd: string,
		resume: ResumeTarget | null,
		mode: Mode | null,
	): Effect.Effect<Follow, never, ProcessSelf | RIn> =>
		Effect.gen(function* () {
			const agent = yield* slot.rebuild;
			const options: StartOptions = {
				cwd,
				...(resume === null ? {} : {resume}),
				...(mode === null ? {} : {mode}),
			};
			const started = yield* Effect.result(underPolicy(agent.start(options), policy));
			if (Result.isSuccess(started)) {
				return [{type: "started", sessionId: started.success.sessionId}];
			}
			const error = started.failure;
			return [
				{
					type: "openFailed",
					failure: isTimeout(error)
						? deadlineFailure(START_ERROR, policy.deadlineMillis)
						: failureOf(error as AgentServiceError),
				},
			];
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
		//
		// The one thing it decides is which session this process comes up on. A spawner that added
		// `SessionOpening` to the child's context is spawning for a session the operator picked out
		// of the session list, so the boot resumes that id in that folder instead of minting a new
		// one beside it (epic #8070, ruling 2); every other spawner adds nothing and the boot is the
		// fresh one it has always been. Read here rather than at the spawn seam because this is the
		// only place that knows the process is new (`../core/machine.ts`'s `init`).
		"aiAgent.boot": (cmd) =>
			Effect.map(Effect.serviceOption(SessionOpening), (opening) =>
				Option.isNone(opening)
					? [{type: "start", cwd: cmd.cwd, resume: null} as const]
					: [{type: "start", cwd: opening.value.cwd, resume: opening.value.resume} as const],
			),

		"aiAgent.start": (cmd) =>
			open(
				cmd.cwd,
				cmd.resume === null ? null : {sessionId: cmd.resume, holdsTranscript: false},
				cmd.mode,
			),

		// The one resume whose window already holds the transcript: a reconnect stands a new
		// transport under the state this process came back with, so the layer owes it no replay
		// (#8369). A `start` carrying a resume is the picker opening a session on a fresh process,
		// which holds nothing and needs one.
		//
		// What it does owe is everything the session finished while the socket was down, so the
		// restored tail itself rides with the flag. The layer reads both facts off it: where
		// "already on screen" stops, and what each of those rows looked like when this process last
		// saw it — a row that moved while the transport was gone is not one the operator has read.
		"aiAgent.reconnect": (cmd) =>
			Effect.flatMap(readSession, (state) =>
				open(
					cmd.cwd,
					{
						sessionId: cmd.sessionId,
						holdsTranscript: true,
						held: state?.transcript.items ?? [],
					},
					cmd.mode,
				),
			),

		// The one handler that reads the committed state rather than folding forward from it: there
		// is no event to fold, which is the whole point — a restored session's tail and its pending
		// cards are already in state and nothing else will ever push them out (#7608). The answer
		// cells emit it for the same reason one step on: an answer's own progress rides no event
		// (#8006), and re-seeding is what keeps the Sub's projection from folding on past it.
		"aiAgent.republish": () =>
			Effect.gen(function* () {
				const state = yield* readSession;
				if (state === null) return nothing;
				const seeded = yield* projection.seed(state);
				yield* emit(aiAgentPortNames.transcript, transcriptOf(seeded));
				yield* emit(aiAgentPortNames.permissionPending, pendingOf(state));
				yield* emit(aiAgentPortNames.modeState, modeStateOf(state));
				return nothing;
			}),

		// The turn the core recorded in the very commit that produced this Cmd (#7978) rides no
		// layer event, so the Sub's projection would publish a tail with the operator's half
		// missing (#7979). The committed state can be behind the projection while this runs — the
		// Sub folds each event before the host applies its Msg — so the seed carries that tail
		// across rather than replacing it (`./projection.ts`, #8034), and the emit publishes what
		// the seed answered rather than the commit it started from.
		//
		// It is also the one handler whose answer names the send it is about. `sent` carries the
		// Cmd's own key, so the window that minted it learns what became of *its* text rather than
		// what became of the last thing the session did — which is the correlation two windows
		// racing to send need (#8005). What it can say is bounded: both rows return from `prompt`
		// at the send (#8018), so a `sent` with no failure reports a handoff nobody refused and
		// says nothing about the backend, whose own refusal arrives later on the event stream.
		"aiAgent.prompt": (cmd) =>
			Effect.gen(function* () {
				const state = yield* readSession;
				if (state !== null) {
					const seeded = yield* projection.seed(state);
					yield* emit(aiAgentPortNames.transcript, transcriptOf(seeded));
				}
				const agent = yield* slot.current;
				if (agent === null) {
					return [{type: "sent", key: cmd.key, failure: noSession}] satisfies Follow;
				}
				const answered = yield* Effect.result(agent.prompt(cmd.text, cmd.key));
				return [
					{
						type: "sent",
						key: cmd.key,
						failure: Result.isFailure(answered) ? failureOf(answered.failure) : null,
					},
				] satisfies Follow;
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
				() => [{type: "answered", request: cmd.request, seq: cmd.seq}],
				(failure) => [{type: "answerFailed", request: cmd.request, seq: cmd.seq, failure}],
			),

		"aiAgent.setMode": (cmd) =>
			withAgent(
				(agent) => agent.setMode(cmd.mode),
				() => nothing,
			),

		"aiAgent.setModel": (cmd) =>
			withAgent(
				(agent) => agent.setModel(cmd.model),
				() => nothing,
			),

		"aiAgent.setThinkingLevel": (cmd) =>
			withAgent(
				(agent) => agent.setThinkingLevel(cmd.level),
				() => nothing,
			),

		// The port publishes successful pages; the Msg records either outcome for dispatchFolded.
		"aiAgent.page": (cmd) =>
			Effect.gen(function* () {
				const agent = yield* slot.current;
				if (agent === null) return [{type: "pageRefused", failure: noSession}] satisfies Follow;
				const held = yield* readSession;
				const cursor = pageCursor(held?.transcript.items ?? [], cmd.before);
				if (cursor.kind === "unavailable") return nothing;
				const answered = yield* Effect.result(agent.page(cursor.before, cmd.limit));
				if (Result.isFailure(answered))
					return [{type: "pageRefused", failure: failureOf(answered.failure)}] satisfies Follow;
				// A backend that stores the conversation keeps its own copy of the turn the core
				// recorded at the send, under its own id, and no id joins the two (#7979). Dropped
				// here rather than at the window, so both routes one page takes — the `pageReply`
				// port and the `paged` Msg — carry a single copy of it.
				const current = yield* readSession;
				const page = {
					items: withoutLocalEchoes(answered.success.items, current?.transcript.items ?? []),
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
					// A reset empties both projections rather than moving one row of either, so it
					// publishes on the same two ports an item and a card do — a window left rendering
					// the old conversation's tail and its unanswerable cards is the reset half-done.
					const reset = event.kind === "session-reset";
					if (event.kind === "item" || reset) {
						yield* emit(aiAgentPortNames.transcript, transcriptOf(next));
					}
					if (event.kind === "permission" || event.kind === "permission-resolved" || reset) {
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
