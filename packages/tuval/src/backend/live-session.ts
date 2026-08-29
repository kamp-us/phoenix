import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {Context, Effect, Queue, Stream} from "effect";
import * as Schema from "effect/Schema";
import type {
	AbortLiveSessionRequest,
	AttachLiveSessionOutcome,
	ControlLiveSessionOutcome,
	CreateLiveSessionRequest,
	LiveSessionControlCommand,
	LiveSessionEvent,
	LiveSessionView,
	OpenLiveSessionRequest,
	PromptLiveSessionOutcome,
	PromptLiveSessionRequest,
	ReleaseLiveSessionOutcome,
	SetModelLiveSessionRequest,
	SetThinkingLiveSessionRequest,
	SteerLiveSessionRequest,
} from "../shared/live-session.js";
import {
	type LiveSessionState,
	type LiveSessionStateOptions,
	PiLiveSessionState,
} from "./live-session-state.js";

export type {AcknowledgementDeadline, LiveSessionStateOptions} from "./live-session-state.js";

export class LiveSessionAdapterError extends Schema.TaggedErrorClass<LiveSessionAdapterError>()(
	"tuval/LiveSessionAdapterError",
	{cause: Schema.Defect()},
) {}

export interface LiveSessionService {
	readonly current: () => Effect.Effect<LiveSessionView | null>;
	readonly attach: (sessionId: string) => Effect.Effect<AttachLiveSessionOutcome>;
	readonly prompt: (request: PromptLiveSessionRequest) => Effect.Effect<PromptLiveSessionOutcome>;
	readonly create: (request: CreateLiveSessionRequest) => Effect.Effect<ControlLiveSessionOutcome>;
	readonly open: (request: OpenLiveSessionRequest) => Effect.Effect<ControlLiveSessionOutcome>;
	readonly steer: (request: SteerLiveSessionRequest) => Effect.Effect<ControlLiveSessionOutcome>;
	readonly abort: (request: AbortLiveSessionRequest) => Effect.Effect<ControlLiveSessionOutcome>;
	readonly setModel: (
		request: SetModelLiveSessionRequest,
	) => Effect.Effect<ControlLiveSessionOutcome>;
	readonly setThinking: (
		request: SetThinkingLiveSessionRequest,
	) => Effect.Effect<ControlLiveSessionOutcome>;
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

const controlFromState = (
	state: LiveSessionState,
	command: LiveSessionControlCommand,
	correlationId: string,
	run: () => Promise<ControlLiveSessionOutcome>,
): Effect.Effect<ControlLiveSessionOutcome> =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new LiveSessionAdapterError({cause}),
	}).pipe(
		Effect.catch(() =>
			Effect.succeed({
				_tag: "refused" as const,
				command,
				correlationId,
				code: "protocol" as const,
				reason: `The live-session adapter failed while running ${command}`,
				session: state.current(),
			}),
		),
	);

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
	create: Effect.fn("LiveSession.create")((request) =>
		controlFromState(state, "create", request.correlationId, () => state.create(request)),
	),
	open: Effect.fn("LiveSession.open")((request) =>
		controlFromState(state, "open", request.correlationId, () => state.open(request)),
	),
	steer: Effect.fn("LiveSession.steer")((request) =>
		controlFromState(state, "steer", request.correlationId, () => state.steer(request)),
	),
	abort: Effect.fn("LiveSession.abort")((request) =>
		controlFromState(state, "abort", request.correlationId, () => state.abort(request)),
	),
	setModel: Effect.fn("LiveSession.setModel")((request) =>
		controlFromState(state, "set-model", request.correlationId, () => state.setModel(request)),
	),
	setThinking: Effect.fn("LiveSession.setThinking")((request) =>
		controlFromState(state, "set-thinking", request.correlationId, () =>
			state.setThinking(request),
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
		options: LiveSessionStateOptions = {},
	): Effect.Effect<PiLiveSession, LiveSessionConnectError> {
		return Effect.tryPromise({
			try: async () =>
				new PiLiveSession(await PiLiveSessionState.connect(transportFactory, options)),
			catch: (cause) => new LiveSessionConnectError({cause}),
		});
	}

	readonly current = () => this.#service.current();
	readonly attach = (sessionId: string) => this.#service.attach(sessionId);
	readonly prompt = (request: PromptLiveSessionRequest) => this.#service.prompt(request);
	readonly create = (request: CreateLiveSessionRequest) => this.#service.create(request);
	readonly open = (request: OpenLiveSessionRequest) => this.#service.open(request);
	readonly steer = (request: SteerLiveSessionRequest) => this.#service.steer(request);
	readonly abort = (request: AbortLiveSessionRequest) => this.#service.abort(request);
	readonly setModel = (request: SetModelLiveSessionRequest) => this.#service.setModel(request);
	readonly setThinking = (request: SetThinkingLiveSessionRequest) =>
		this.#service.setThinking(request);
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
	create: Effect.fn("LiveSession.create")(({correlationId}) =>
		Effect.succeed({
			_tag: "refused",
			command: "create",
			correlationId,
			code: "disconnected",
			reason: "Tuval live protocol transport is not configured",
			session: null,
		}),
	),
	open: Effect.fn("LiveSession.open")(({correlationId}) =>
		Effect.succeed({
			_tag: "refused",
			command: "open",
			correlationId,
			code: "disconnected",
			reason: "Tuval live protocol transport is not configured",
			session: null,
		}),
	),
	steer: Effect.fn("LiveSession.steer")(({correlationId}) =>
		Effect.succeed({
			_tag: "refused",
			command: "steer",
			correlationId,
			code: "ownership-refused",
			reason: "No exclusive session lease is held",
			session: null,
		}),
	),
	abort: Effect.fn("LiveSession.abort")(({correlationId}) =>
		Effect.succeed({
			_tag: "refused",
			command: "abort",
			correlationId,
			code: "ownership-refused",
			reason: "No exclusive session lease is held",
			session: null,
		}),
	),
	setModel: Effect.fn("LiveSession.setModel")(({correlationId}) =>
		Effect.succeed({
			_tag: "refused",
			command: "set-model",
			correlationId,
			code: "ownership-refused",
			reason: "No exclusive session lease is held",
			session: null,
		}),
	),
	setThinking: Effect.fn("LiveSession.setThinking")(({correlationId}) =>
		Effect.succeed({
			_tag: "refused",
			command: "set-thinking",
			correlationId,
			code: "ownership-refused",
			reason: "No exclusive session lease is held",
			session: null,
		}),
	),
	release: Effect.fn("LiveSession.release")(() =>
		Effect.succeed({_tag: "released", sessionId: null}),
	),
	eventsAfter: Effect.fn("LiveSession.eventsAfter")(() => Effect.succeed([])),
	events: () => Stream.empty,
	dispose: Effect.fn("LiveSession.dispose")(() => Effect.void),
});
