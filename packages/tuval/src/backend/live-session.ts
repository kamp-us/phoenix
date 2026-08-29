import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {Context, Duration, Effect, Fiber, Queue, Schedule, Stream} from "effect";
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
import {resilienceDiagnostic} from "./resilience.js";

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
		}).pipe(
			Effect.catch(() =>
				Effect.succeed({
					_tag: "failed" as const,
					sessionId,
					code: "protocol" as const,
					reason: "The live-session adapter failed while releasing the selected session",
				}),
			),
		);
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

export interface LiveSessionReconnectOptions {
	readonly retries?: number;
	readonly baseDelayMs?: number;
	readonly maxDelayMs?: number;
}

const reconnectSchedule = (options: LiveSessionReconnectOptions) => {
	const retries = Math.max(0, Math.floor(options.retries ?? 4));
	const baseDelay = Math.max(1, Math.floor(options.baseDelayMs ?? 100));
	const maxDelay = Math.max(baseDelay, Math.floor(options.maxDelayMs ?? 2_000));
	return Schedule.exponential(Duration.millis(baseDelay)).pipe(
		Schedule.modifyDelay((_attempt, delay) =>
			Effect.succeed(Duration.min(delay, Duration.millis(maxDelay))),
		),
		Schedule.both(Schedule.recurs(retries)),
	);
};

/** A separately testable Clock/Schedule seam for bounded deterministic reconnect attempts. */
export const connectLiveSessionWithBackoff = <A, E, R>(
	connect: Effect.Effect<A, E, R>,
	options: LiveSessionReconnectOptions = {},
): Effect.Effect<A, E, R> => Effect.retry(connect, {schedule: reconnectSchedule(options)});

class ReconnectingLiveSession implements LiveSessionService {
	readonly #listeners = new Set<(event: LiveSessionEvent) => void>();
	readonly #events: Array<LiveSessionEvent> = [];
	#service: LiveSessionService = makeUnavailableLiveSession();
	#forwarder: Fiber.Fiber<void, never> | undefined;
	#selectedSessionId: string | undefined;
	#sequence = 0;
	#disposed = false;

	replace = Effect.fn("LiveSession.reconnect.replace")(function* (
		this: ReconnectingLiveSession,
		next: LiveSessionService,
	) {
		if (this.#disposed) {
			yield* next.dispose().pipe(Effect.ignore);
			return;
		}
		if (this.#forwarder !== undefined) yield* Fiber.interrupt(this.#forwarder);
		const previous = this.#service;
		this.#service = next;
		this.#forwarder = yield* next.events().pipe(
			Stream.runForEach((event) => Effect.sync(() => this.#publish(event))),
			Effect.forkScoped,
		);
		if (previous !== next) yield* previous.dispose().pipe(Effect.ignore);
	});

	restoreSelection = Effect.fn("LiveSession.reconnect.restoreSelection")(function* (
		this: ReconnectingLiveSession,
	) {
		const selected = this.#selectedSessionId;
		if (selected === undefined) return;
		const outcome = yield* this.#service.attach(selected);
		if (outcome._tag === "attached") return;
		this.#publishDiagnostic(
			"selected-lease-unavailable",
			"The selected session could not provide a fresh lease after reconnect",
			selected,
		);
	});

	publishReconnectFailure(_error: LiveSessionConnectError): void {
		this.#publishDiagnostic(
			"reconnect-exhausted",
			"Pi live transport reconnect exhausted its bounded attempts",
		);
	}

	readonly current = () => this.#service.current();
	readonly attach = (sessionId: string) =>
		this.#service.attach(sessionId).pipe(
			Effect.tap((outcome) =>
				Effect.sync(() => {
					if (outcome._tag === "attached") this.#selectedSessionId = sessionId;
				}),
			),
		);
	readonly prompt = (request: PromptLiveSessionRequest) => this.#service.prompt(request);
	readonly create = (request: CreateLiveSessionRequest) =>
		this.#trackSelection(this.#service.create(request));
	readonly open = (request: OpenLiveSessionRequest) =>
		this.#trackSelection(this.#service.open(request));
	readonly steer = (request: SteerLiveSessionRequest) => this.#service.steer(request);
	readonly abort = (request: AbortLiveSessionRequest) => this.#service.abort(request);
	readonly setModel = (request: SetModelLiveSessionRequest) => this.#service.setModel(request);
	readonly setThinking = (request: SetThinkingLiveSessionRequest) =>
		this.#service.setThinking(request);
	readonly release = () =>
		this.#service.release().pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					this.#selectedSessionId = undefined;
				}),
			),
		);
	readonly eventsAfter = (sequence = 0) =>
		Effect.sync(() => this.#events.filter((event) => event.sequence > sequence));
	readonly events = (sequence = 0) =>
		Stream.callback<LiveSessionEvent>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					for (const event of this.#events) {
						if (event.sequence > sequence) Queue.offerUnsafe(queue, event);
					}
					const listener = (event: LiveSessionEvent) => Queue.offerUnsafe(queue, event);
					this.#listeners.add(listener);
					return listener;
				}),
				(listener) => Effect.sync(() => void this.#listeners.delete(listener)),
			),
		);
	readonly dispose = Effect.fn("LiveSession.reconnect.dispose")(function* (
		this: ReconnectingLiveSession,
	) {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#forwarder !== undefined) yield* Fiber.interrupt(this.#forwarder);
		this.#listeners.clear();
		yield* this.#service.dispose();
	});

	#trackSelection(
		operation: Effect.Effect<ControlLiveSessionOutcome>,
	): Effect.Effect<ControlLiveSessionOutcome> {
		return operation.pipe(
			Effect.tap((outcome) =>
				Effect.sync(() => {
					if (outcome._tag === "acknowledged") {
						this.#selectedSessionId = outcome.session.sessionId;
					}
				}),
			),
		);
	}

	#publishDiagnostic(
		code: "selected-lease-unavailable" | "reconnect-exhausted",
		message: string,
		sessionId?: string,
	): void {
		const diagnostic = resilienceDiagnostic({
			category: "protocol",
			code,
			message,
			action: "Check the pi transport and retry the selection; no command was replayed",
			...(sessionId === undefined ? {} : {sessionId}),
		});
		this.#publish({
			_tag: "diagnostic",
			sequence: 0,
			sessionId: sessionId ?? null,
			message: diagnostic.message,
			diagnostic,
		});
	}

	#publish(event: LiveSessionEvent): void {
		const sequenced = {...event, sequence: ++this.#sequence} as LiveSessionEvent;
		this.#events.push(sequenced);
		if (this.#events.length > 500) this.#events.shift();
		for (const listener of this.#listeners) listener(sequenced);
	}
}

export const makeResilientPiLiveSession = Effect.fn("LiveSession.resilientConnect")(function* (
	transportFactory: ByteTransportFactory,
	options: LiveSessionStateOptions & LiveSessionReconnectOptions = {},
) {
	const reconnects = yield* Queue.dropping<void>(1);
	const service = new ReconnectingLiveSession();
	const stateOptions: LiveSessionStateOptions = {
		...options,
		onDisconnected: () => {
			options.onDisconnected?.();
			Queue.offerUnsafe(reconnects, undefined);
		},
	};
	const connect = () =>
		connectLiveSessionWithBackoff(PiLiveSession.connect(transportFactory, stateOptions), options);
	yield* service.replace(yield* connect());
	yield* Effect.forkScoped(
		Effect.forever(
			Queue.take(reconnects).pipe(
				Effect.flatMap(() => connect()),
				Effect.flatMap((next) =>
					service.replace(next).pipe(Effect.andThen(service.restoreSelection())),
				),
				Effect.catch((error) => Effect.sync(() => service.publishReconnectFailure(error))),
			),
		),
	);
	yield* Effect.addFinalizer(() => service.dispose().pipe(Effect.ignore));
	return service as LiveSessionService;
});

export const makeDurableLiveSession = (
	service: LiveSessionService,
	checkpoint: () => Effect.Effect<boolean>,
): LiveSessionService => {
	const durableControl = (
		operation: Effect.Effect<ControlLiveSessionOutcome>,
	): Effect.Effect<ControlLiveSessionOutcome> =>
		operation.pipe(
			Effect.flatMap((outcome): Effect.Effect<ControlLiveSessionOutcome> => {
				if (outcome._tag !== "acknowledged") return Effect.succeed(outcome);
				return checkpoint().pipe(
					Effect.map(
						(durable): ControlLiveSessionOutcome =>
							durable
								? outcome
								: {
										_tag: "refused",
										command: outcome.command,
										correlationId: outcome.correlationId,
										code: "protocol",
										reason: "Acknowledged selection could not be persisted",
										session: outcome.session,
									},
					),
				);
			}),
		);
	return {
		current: service.current,
		attach: (sessionId) =>
			service.attach(sessionId).pipe(
				Effect.flatMap((outcome): Effect.Effect<AttachLiveSessionOutcome> => {
					if (outcome._tag !== "attached") return Effect.succeed(outcome);
					return checkpoint().pipe(
						Effect.map(
							(durable): AttachLiveSessionOutcome =>
								durable
									? outcome
									: {
											_tag: "refused",
											sessionId,
											code: "protocol",
											reason: "Attached selection could not be persisted",
										},
						),
					);
				}),
			),
		prompt: service.prompt,
		create: (request) => durableControl(service.create(request)),
		open: (request) => durableControl(service.open(request)),
		steer: service.steer,
		abort: service.abort,
		setModel: service.setModel,
		setThinking: service.setThinking,
		release: () =>
			service.release().pipe(
				Effect.flatMap((outcome): Effect.Effect<ReleaseLiveSessionOutcome> => {
					if (outcome._tag !== "released") return Effect.succeed(outcome);
					return checkpoint().pipe(
						Effect.map(
							(durable): ReleaseLiveSessionOutcome =>
								durable
									? outcome
									: {
											_tag: "failed",
											sessionId: outcome.sessionId,
											code: "persistence",
											reason: "Released selection could not be persisted",
										},
						),
					);
				}),
			),
		eventsAfter: service.eventsAfter,
		events: service.events,
		dispose: service.dispose,
	};
};

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
