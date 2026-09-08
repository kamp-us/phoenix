/**
 * The lease handling around `@earendil-works/pi-client`'s `Client`, running in Node inside the Pi
 * process. Every `Promise` the pin throws is folded into one of the four refusals in
 * [`errors.ts`](./errors.ts), so nothing below this file's surface returns a `Promise` or throws a
 * Pi error class.
 *
 * At 0.85.1 `Client` is a request/response pipe and nothing more: the 0.84.3 pin's session handle
 * is gone, so the session table, the leases and the snapshot each lease landed with are this file's
 * (ADR 0366). A lease is now a `SessionTarget` the host issued — `{serverId, sessionId,
 * attachmentId}` — and it is the envelope's own fence, so a call on a replaced lease is refused by
 * the host rather than by bookkeeping here.
 *
 * Two behaviours of the pin the service is built around, both read off `pi-client`'s `client.js` at
 * 0.85.1 rather than assumed:
 *
 * - **A drop invalidates every lease.** `#handleConnectionStateChange` rejects every pending
 *   request and clears the client's own state, and the host releases the connection's sessions when
 *   its socket closes. Reconnect therefore reacquires by session id; it never preserves a lease.
 * - **`reconnect()` is `connect()`.** It opens a fresh transport through the factory and refuses
 *   when the client is not disconnected, which is why reconnect is a caller's call here.
 *
 * Nothing here dials on its own — one drop is one `Disconnected` and the next dial is a caller's
 * call; retry policy over a whole start belongs to the handlers and stays declared data (#7371).
 * The one wait this service keeps is `reacquireWait` below, which is not a policy but the wire's
 * own missing sequencing: it holds a reacquire against the server's release of the socket it is
 * replacing, and reaches nothing else.
 */

import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {Client} from "@earendil-works/pi-client";
import {Context, Effect, Layer, Queue, Schedule, type Scope, Stream} from "effect";
import {boundedTeardown} from "../teardown.ts";
import type {
	Command,
	CommandResult,
	ModelMetadata,
	ModelRef,
	RpcTarget,
	ServerEvent,
	SessionSnapshot,
	SessionTarget,
	ThinkingLevel,
} from "../wire/index.ts";
import {SERVICE_ID} from "../wire/index.ts";
import {
	type ConnectionRefusal,
	Disconnected,
	ProtocolRefused,
	SessionLocked,
	SessionNotFound,
	type SessionRefusal,
} from "./errors.ts";
import {connectionRefusalOf, sessionRefusalOf} from "./refusals.ts";
import {webSocketTransportFactory, withSessionEvents} from "./transport.ts";

/** What a caller needs to keep about a session it holds a lease on. */
export interface PiSessionRef {
	readonly id: string;
	readonly cwd: string;
	/**
	 * What the session is running on now, off its own snapshot. This is the session's current
	 * model and not the last turn's billed one — the two are different facts and the picker reads
	 * this one (#7981).
	 */
	readonly model: ModelRef;
	/** The level the session is thinking at now, off that same snapshot (#8062). */
	readonly thinkingLevel: ThinkingLevel;
}

export interface OpenSessionOptions {
	readonly name?: string;
	readonly model?: ModelRef;
	readonly thinkingLevel?: ThinkingLevel;
}

export interface PiClientApi {
	readonly connect: Effect.Effect<void, ConnectionRefusal>;
	/** Dials again after a drop. The leases from before are gone; reacquire by session id. */
	readonly reconnect: Effect.Effect<void, ConnectionRefusal>;
	readonly connected: Effect.Effect<boolean>;
	readonly createSession: (
		cwd: string,
		options?: OpenSessionOptions,
	) => Effect.Effect<PiSessionRef, ConnectionRefusal>;
	readonly attachSession: (sessionId: string) => Effect.Effect<PiSessionRef, SessionRefusal>;
	/**
	 * The snapshot the lease on this session landed with — the transcript Pi had already sent by
	 * the time `createSession` or `attachSession` answered. `PiSessionRef` keeps only the three
	 * fields a caller needs to run the session; a resume needs the transcript itself, to seed its
	 * snapshot diff so the first push after reattaching folds to zero events (#8369).
	 */
	readonly heldSnapshot: (sessionId: string) => Effect.Effect<SessionSnapshot, SessionRefusal>;
	/** Needs a lease this client took through `createSession` or `attachSession`. */
	readonly prompt: (
		sessionId: string,
		text: string,
	) => Effect.Effect<SessionSnapshot, SessionRefusal>;
	/** Cuts the running turn short. Needs the same lease `prompt` does. */
	readonly abort: (sessionId: string) => Effect.Effect<SessionSnapshot, SessionRefusal>;
	/** Switches the session's model. Needs the same lease `prompt` does. */
	readonly setModel: (
		sessionId: string,
		model: ModelRef,
	) => Effect.Effect<SessionSnapshot, SessionRefusal>;
	/**
	 * Switches how hard the session thinks, over the pin's `set_thinking` verb. Needs the same lease
	 * `prompt` does, and applies to the running session rather than to the next one.
	 */
	readonly setThinkingLevel: (
		sessionId: string,
		level: ThinkingLevel,
	) => Effect.Effect<SessionSnapshot, SessionRefusal>;
	/**
	 * The catalog the server put in the session stream's first update, already cut to the
	 * authenticated, describable set by the host's `offered()`. Empty before the first dial, and a
	 * fact about the server rather than about any session — which is why it is not on
	 * `PiSessionRef`.
	 */
	readonly models: Effect.Effect<ReadonlyArray<ModelMetadata>>;
	/** Every snapshot the server pushes for this session, for as long as the stream is pulled. */
	readonly snapshots: (sessionId: string) => Stream.Stream<SessionSnapshot>;
	/** One element per connection loss, so a caller can decide whether and when to reconnect. */
	readonly disconnections: Stream.Stream<Disconnected>;
}

export interface PiClientConfig {
	readonly transportFactory: ByteTransportFactory;
	/** The `PiServerService`'s own `serverId`; the pin refuses a dial that names another. */
	readonly serverId: string;
	readonly maxFrameLength?: number;
}

export interface PiClientWebSocketConfig {
	/** The `PiServerService`'s dial URL, token included. */
	readonly url: string;
	readonly serverId: string;
	readonly maxFrameLength?: number;
	readonly maxPendingBytes?: number;
}

export class PiClientService extends Context.Service<PiClientService, PiClientApi>()(
	"tuval/pi/PiClientService",
) {
	static readonly layer = (config: PiClientConfig): Layer.Layer<PiClientService> =>
		Layer.effect(PiClientService, make(config));

	/** The production wiring: the WebSocket transport of [`transport.ts`](./transport.ts). */
	static readonly layerWebSocket = (
		config: PiClientWebSocketConfig,
	): Layer.Layer<PiClientService> =>
		// `exactOptionalPropertyTypes` refuses an explicit `undefined` on an optional field, so an
		// absent bound stays absent instead of being forwarded as one.
		PiClientService.layer({
			serverId: config.serverId,
			transportFactory: webSocketTransportFactory({
				url: config.url,
				...(config.maxPendingBytes === undefined ? {} : {maxPendingBytes: config.maxPendingBytes}),
			}),
			...(config.maxFrameLength === undefined ? {} : {maxFrameLength: config.maxFrameLength}),
		});
}

/**
 * How long a reacquire waits out the server's release of the connection it replaces.
 *
 * The server keys session ownership by a connection id it mints per accepted socket and clears the
 * old owner only once that socket's `close` lands (`../server/records.ts`). `reconnect()` opens a
 * fresh transport, so a reacquire is a different connection racing that release, and losing the
 * race reads as `session_locked` for a session this client just held. Protocol 8 carries no message
 * naming the connection being replaced, so a client cannot ask the server to retire the old owner
 * first; waiting is the only sequencing available on this side of the wire.
 *
 * Six tries over roughly 630ms, and only where this client already held the session — a client
 * attaching a session it never owned is still refused on its first try.
 */
const reacquireWait = {
	while: (refusal: SessionRefusal) => refusal instanceof SessionLocked,
	times: 6,
	schedule: Schedule.exponential("10 millis", 2),
} as const;

/**
 * One command as the envelope's `call`.
 *
 * `Client.request` types its call as Chord's `ServiceCall`, whose `args` are index-signature
 * `JsonValue`s. A `Command` is JSON but an interface never widens to that, and there is nothing to
 * decode against on this side — the wire seam's `asTuval` carries the same note at the same
 * boundary.
 */
type ServiceCall = Parameters<Client["request"]>[1];

const serviceCall = (command: Command): ServiceCall => {
	const call: unknown = {serviceId: SERVICE_ID, member: command.command, args: [command]};
	return call as ServiceCall;
};

/** A session this client holds: the envelope address it calls on, and its last known snapshot. */
interface Lease {
	readonly target: SessionTarget;
	snapshot: SessionSnapshot;
}

const make = (config: PiClientConfig): Effect.Effect<PiClientApi, never, Scope.Scope> =>
	Effect.gen(function* () {
		const listenerErrors = yield* Queue.unbounded<Error>();

		/**
		 * The leases this client holds, keyed by session id. A drop leaves the entries in place
		 * rather than removing them, so a call after a drop refuses `Disconnected` off the pin's
		 * own dead connection instead of `SessionNotFound` off an emptied table — the session did
		 * not go anywhere, the connection did. A reacquire overwrites its entry.
		 */
		const leases = new Map<string, Lease>();
		const eventListeners = new Set<(event: ServerEvent) => void>();
		let models: ReadonlyArray<ModelMetadata> = [];

		const onEvent = (event: ServerEvent): void => {
			if (event.type === "server_snapshot") models = event.snapshot.models;
			if (event.type === "session_snapshot") {
				const lease = leases.get(event.snapshot.id);
				if (lease !== undefined) lease.snapshot = event.snapshot;
			}
			for (const listener of eventListeners) listener(event);
		};

		const client = yield* Effect.acquireRelease(
			Effect.sync(
				() =>
					new Client({
						serverId: config.serverId,
						transportFactory: withSessionEvents(
							config.transportFactory,
							onEvent,
							config.maxFrameLength === undefined ? {} : {maxFrameLength: config.maxFrameLength},
						),
						...(config.maxFrameLength === undefined ? {} : {maxFrameLength: config.maxFrameLength}),
						onListenerError: (error) => {
							Queue.offerUnsafe(listenerErrors, error);
						},
					}),
			),
			// A release has no error channel to model into, so the settle is one arm either way: a
			// rejection is nothing this scope can act on. The wait is the one thing that matters
			// here and it runs under `../teardown.ts`'s ceiling, because a `dispose` that never
			// resolves would hang the close for good. `dispose()` is not `async` at this pin, so it
			// can throw before returning its promise; the ceiling folds that throw rather than
			// letting it escape this uninterruptible finalizer.
			(open) =>
				boundedTeardown("the Pi client's dispose", (settled) => {
					open.dispose().then(settled, settled);
				}),
		);

		yield* Effect.forkScoped(
			Effect.forever(Queue.take(listenerErrors).pipe(Effect.flatMap(Effect.logError))),
		);

		const serverTarget: RpcTarget = {serverId: config.serverId};

		/**
		 * One command, one answer. `Client.request` puts the call through Chord's `parseServiceCall`
		 * and hands back whatever the host put in `result`, which is Tuval's own `CommandResult`;
		 * a result under another verb is the server answering something the protocol does not allow.
		 */
		const call = <TResult extends CommandResult>(
			target: RpcTarget,
			command: Command,
		): Promise<TResult> =>
			client.request(target, serviceCall(command)).then((result) => {
				const answer = result as CommandResult | undefined;
				return answer === undefined || answer.command !== command.command
					? Promise.reject(
							new ProtocolRefused({
								code: "internal_error",
								detail: `the server answered ${String(answer?.command)} to a ${command.command}`,
							}),
						)
					: (answer as TResult);
			});

		const refOf = (snapshot: SessionSnapshot): PiSessionRef => ({
			id: snapshot.id,
			cwd: snapshot.cwd,
			model: snapshot.model,
			thinkingLevel: snapshot.thinkingLevel,
		});

		const hold = (snapshot: SessionSnapshot, attachmentId: string): PiSessionRef => {
			leases.set(snapshot.id, {
				target: {serverId: config.serverId, sessionId: snapshot.id, attachmentId},
				snapshot,
			});
			return refOf(snapshot);
		};

		const dial = (open: () => Promise<unknown>): Effect.Effect<void, ConnectionRefusal> =>
			Effect.tryPromise({try: open, catch: connectionRefusalOf}).pipe(Effect.asVoid);

		const createSession = Effect.fn("PiClientService.createSession")(function* (
			cwd: string,
			options: OpenSessionOptions = {},
		) {
			const result = yield* Effect.tryPromise({
				try: () =>
					call<Extract<CommandResult, {command: "create"}>>(serverTarget, {
						command: "create",
						cwd,
						...options,
					}),
				catch: connectionRefusalOf,
			});
			return hold(result.session, result.attachmentId);
		});

		const attachSession = Effect.fn("PiClientService.attachSession")(function* (sessionId: string) {
			const held = leases.get(sessionId);
			const attach = Effect.tryPromise({
				try: () =>
					call<Extract<CommandResult, {command: "attach"}>>(serverTarget, {
						command: "attach",
						sessionId,
					}),
				catch: (cause) => sessionRefusalOf(sessionId, cause),
			});
			// A held entry is this client having owned the session on the socket that just went, so
			// this call is a reacquire and the server's release of the old owner may lag it.
			const result = yield* held === undefined ? attach : Effect.retry(attach, reacquireWait);
			return hold(result.session, result.attachmentId);
		});

		/**
		 * The lease every session-scoped call needs. An absent one is this client never having
		 * taken the session, which is a different fact from the server not knowing it — the
		 * detail says which, because both arrive as `SessionNotFound`.
		 */
		const leased = (sessionId: string): Effect.Effect<Lease, SessionNotFound> => {
			const lease = leases.get(sessionId);
			return lease === undefined
				? Effect.fail(
						new SessionNotFound({
							sessionId,
							detail: "this client holds no lease on the session; attach it first",
						}),
					)
				: Effect.succeed(lease);
		};

		const heldSnapshot = Effect.fn("PiClientService.heldSnapshot")(function* (sessionId: string) {
			return (yield* leased(sessionId)).snapshot;
		});

		/** A session call's shared tail: send it on this session's lease, keep the snapshot it answers. */
		const onSession = (sessionId: string, command: Command) =>
			leased(sessionId).pipe(
				Effect.flatMap((lease) =>
					Effect.tryPromise({
						try: () =>
							call<Extract<CommandResult, {session: SessionSnapshot}>>(lease.target, command),
						catch: (cause) => sessionRefusalOf(sessionId, cause),
					}).pipe(
						Effect.map((result) => {
							lease.snapshot = result.session;
							return result.session;
						}),
					),
				),
			);

		const prompt = Effect.fn("PiClientService.prompt")(function* (sessionId: string, text: string) {
			return yield* onSession(sessionId, {command: "prompt", sessionId, text});
		});

		const abort = Effect.fn("PiClientService.abort")(function* (sessionId: string) {
			return yield* onSession(sessionId, {command: "abort", sessionId});
		});

		const setModel = Effect.fn("PiClientService.setModel")(function* (
			sessionId: string,
			model: ModelRef,
		) {
			return yield* onSession(sessionId, {command: "set_model", sessionId, model});
		});

		const setThinkingLevel = Effect.fn("PiClientService.setThinkingLevel")(function* (
			sessionId: string,
			level: ThinkingLevel,
		) {
			return yield* onSession(sessionId, {
				command: "set_thinking",
				sessionId,
				thinkingLevel: level,
			});
		});

		const snapshots = (sessionId: string): Stream.Stream<SessionSnapshot> =>
			Stream.callback<SessionSnapshot>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						const listener = (event: ServerEvent): void => {
							if (event.type === "session_snapshot" && event.snapshot.id === sessionId) {
								Queue.offerUnsafe(queue, event.snapshot);
							}
						};
						eventListeners.add(listener);
						return listener;
					}),
					(listener) => Effect.sync(() => eventListeners.delete(listener)),
				),
			);

		const disconnections = Stream.callback<Disconnected>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() =>
					client.onConnectionStateChange((change) => {
						if (change.state !== "disconnected") return;
						Queue.offerUnsafe(
							queue,
							new Disconnected({detail: change.error?.message ?? "the transport closed"}),
						);
					}),
				),
				(unsubscribe) => Effect.sync(unsubscribe),
			),
		);

		return {
			connect: dial(() => client.connect()),
			reconnect: dial(() => client.reconnect()),
			connected: Effect.sync(() => client.connected),
			createSession,
			attachSession,
			heldSnapshot,
			prompt,
			abort,
			setModel,
			setThinkingLevel,
			models: Effect.sync(() => models),
			snapshots,
			disconnections,
		};
	});
