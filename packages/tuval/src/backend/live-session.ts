import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {Context, Effect, Queue, Stream} from "effect";
import * as Schema from "effect/Schema";
import type {
	AttachLiveSessionOutcome,
	LiveSessionEvent,
	LiveSessionView,
	PromptLiveSessionOutcome,
	PromptLiveSessionRequest,
	ReleaseLiveSessionOutcome,
} from "../shared/live-session.js";
import {type LiveSessionState, PiLiveSessionState} from "./live-session-state.js";

export class LiveSessionAdapterError extends Schema.TaggedErrorClass<LiveSessionAdapterError>()(
	"tuval/LiveSessionAdapterError",
	{cause: Schema.Defect()},
) {}

export interface LiveSessionService {
	readonly current: () => Effect.Effect<LiveSessionView | null>;
	readonly attach: (sessionId: string) => Effect.Effect<AttachLiveSessionOutcome>;
	readonly prompt: (request: PromptLiveSessionRequest) => Effect.Effect<PromptLiveSessionOutcome>;
	readonly release: () => Effect.Effect<ReleaseLiveSessionOutcome>;
	readonly eventsAfter: (sequence?: number) => Effect.Effect<ReadonlyArray<LiveSessionEvent>>;
	readonly events: (sequence?: number) => Stream.Stream<LiveSessionEvent>;
	readonly dispose: () => Effect.Effect<void, LiveSessionAdapterError>;
}

export class LiveSession extends Context.Service<LiveSession, LiveSessionService>()(
	"tuval/LiveSession",
) {}

export class LiveSessionConnectError extends Schema.TaggedErrorClass<LiveSessionConnectError>()(
	"tuval/LiveSessionConnectError",
	{cause: Schema.Defect()},
) {}

const fromState = (state: LiveSessionState): LiveSessionService => ({
	current: Effect.fn("LiveSession.current")(() => Effect.sync(() => state.current())),
	attach: Effect.fn("LiveSession.attach")((sessionId) =>
		Effect.tryPromise({
			try: () => state.attach(sessionId),
			catch: (cause) => new LiveSessionAdapterError({cause}),
		}).pipe(
			Effect.catch(() =>
				Effect.succeed({
					_tag: "refused" as const,
					sessionId,
					code: "protocol" as const,
					reason: "The live-session adapter failed while attaching",
				}),
			),
		),
	),
	prompt: Effect.fn("LiveSession.prompt")((request) =>
		Effect.tryPromise({
			try: () => state.prompt(request),
			catch: (cause) => new LiveSessionAdapterError({cause}),
		}).pipe(
			Effect.catch(() =>
				Effect.succeed({
					_tag: "refused" as const,
					correlationId: request.correlationId,
					code: "protocol" as const,
					reason: "The live-session adapter failed while sending the prompt",
				}),
			),
		),
	),
	release: Effect.fn("LiveSession.release")(() => {
		const sessionId = state.current()?.sessionId ?? null;
		return Effect.tryPromise({
			try: () => state.release(),
			catch: (cause) => new LiveSessionAdapterError({cause}),
		}).pipe(Effect.catch(() => Effect.succeed({_tag: "released" as const, sessionId})));
	}),
	eventsAfter: Effect.fn("LiveSession.eventsAfter")((sequence = 0) =>
		Effect.sync(() => state.eventsAfter(sequence)),
	),
	events: (sequence = 0) =>
		Stream.callback((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					for (const event of state.eventsAfter(sequence)) Queue.offerUnsafe(queue, event);
					return state.subscribe((event) => Queue.offerUnsafe(queue, event));
				}),
				(unsubscribe) => Effect.sync(unsubscribe),
			),
		),
	dispose: Effect.fn("LiveSession.dispose")(() =>
		Effect.tryPromise({
			try: () => state.dispose(),
			catch: (cause) => new LiveSessionAdapterError({cause}),
		}),
	),
});

export class PiLiveSession implements LiveSessionService {
	readonly #service: LiveSessionService;

	private constructor(state: PiLiveSessionState) {
		this.#service = fromState(state);
	}

	static connect(
		transportFactory: ByteTransportFactory,
	): Effect.Effect<PiLiveSession, LiveSessionConnectError> {
		return Effect.tryPromise({
			try: async () => new PiLiveSession(await PiLiveSessionState.connect(transportFactory)),
			catch: (cause) => new LiveSessionConnectError({cause}),
		});
	}

	readonly current = () => this.#service.current();
	readonly attach = (sessionId: string) => this.#service.attach(sessionId);
	readonly prompt = (request: PromptLiveSessionRequest) => this.#service.prompt(request);
	readonly release = () => this.#service.release();
	readonly eventsAfter = (sequence?: number) => this.#service.eventsAfter(sequence);
	readonly events = (sequence?: number) => this.#service.events(sequence);
	readonly dispose = () => this.#service.dispose();
}

export const makeUnavailableLiveSession = (): LiveSessionService => ({
	current: Effect.fn("LiveSession.current")(() => Effect.succeed(null)),
	attach: Effect.fn("LiveSession.attach")((sessionId) =>
		Effect.succeed({
			_tag: "refused",
			sessionId,
			code: "disconnected",
			reason: "Tuval live protocol transport is not configured",
		}),
	),
	prompt: Effect.fn("LiveSession.prompt")(({correlationId}) =>
		Effect.succeed({
			_tag: "refused",
			correlationId,
			code: "no-attachment",
			reason: "No live session is attached",
		}),
	),
	release: Effect.fn("LiveSession.release")(() =>
		Effect.succeed({_tag: "released", sessionId: null}),
	),
	eventsAfter: Effect.fn("LiveSession.eventsAfter")(() => Effect.succeed([])),
	events: () => Stream.empty,
	dispose: Effect.fn("LiveSession.dispose")(() => Effect.void),
});
