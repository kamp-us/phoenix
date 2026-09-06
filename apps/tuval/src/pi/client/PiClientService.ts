/**
 * The lease handling around the 0.84.3 `PiClient`, running in Node inside the Pi process. Every
 * `Promise` the pin throws is folded into one of the four refusals in [`errors.ts`](./errors.ts),
 * so nothing below this file's surface returns a `Promise` or throws a Pi error class.
 *
 * Hand-derived from the spike's `play.ts` (#7469, founder gist), which proved the dial, the lease
 * and the reconnect-then-reacquire behaviours; nothing is imported from it or from the `epic/7140`
 * POC branch.
 *
 * Two behaviours of the pin the service is built around, both read off `pi-client`'s `client.js` at
 * 0.84.3 rather than assumed:
 *
 * - **A drop invalidates every lease.** `#handleConnectionStateChange` clears the attachments and
 *   bumps every session's lease generation, so the handles this service holds are dead the moment
 *   the socket goes. Reconnect therefore reacquires by session id; it never preserves a handle.
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
import {PiClient, type PiSessionHandle} from "@earendil-works/pi-client";
import type {
	ModelMetadata,
	ModelRef,
	SessionSnapshot,
	ThinkingLevel,
} from "@earendil-works/pi-protocol";
import {Context, Effect, Layer, Queue, Schedule, type Scope, Stream} from "effect";
import {
	type ConnectionRefusal,
	Disconnected,
	ProtocolRefused,
	SessionLocked,
	SessionNotFound,
	type SessionRefusal,
} from "./errors.ts";
import {connectionRefusalOf, sessionRefusalOf} from "./refusals.ts";
import {webSocketTransportFactory} from "./transport.ts";

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
	 * The catalog the server put in its `hello` frame, already cut to the authenticated,
	 * describable set by the host's `offered()`. Empty before the first dial, and a fact about the
	 * server rather than about any session — which is why it is not on `PiSessionRef`.
	 */
	readonly models: Effect.Effect<ReadonlyArray<ModelMetadata>>;
	/** Every snapshot the server pushes for this session, for as long as the stream is pulled. */
	readonly snapshots: (sessionId: string) => Stream.Stream<SessionSnapshot>;
	/** One element per connection loss, so a caller can decide whether and when to reconnect. */
	readonly disconnections: Stream.Stream<Disconnected>;
}

export interface PiClientConfig {
	readonly transportFactory: ByteTransportFactory;
	readonly maxFrameLength?: number;
}

export interface PiClientWebSocketConfig {
	/** The `PiServerService`'s dial URL, token included. */
	readonly url: string;
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
 * race reads as `session_locked` for a session this client just held. The 0.84.3 protocol carries
 * no message naming the connection being replaced, so a client cannot ask the server to retire the
 * old owner first; waiting is the only sequencing available on this side of the wire.
 *
 * Six tries over roughly 630ms, and only where this client already held the session — a client
 * attaching a session it never owned is still refused on its first try.
 */
const reacquireWait = {
	while: (refusal: SessionRefusal) => refusal instanceof SessionLocked,
	times: 6,
	schedule: Schedule.exponential("10 millis", 2),
} as const;

const make = (config: PiClientConfig): Effect.Effect<PiClientApi, never, Scope.Scope> =>
	Effect.gen(function* () {
		const listenerErrors = yield* Queue.unbounded<Error>();

		const client = yield* Effect.acquireRelease(
			Effect.sync(
				() =>
					new PiClient({
						transportFactory: config.transportFactory,
						...(config.maxFrameLength === undefined ? {} : {maxFrameLength: config.maxFrameLength}),
						onListenerError: (error) => {
							Queue.offerUnsafe(listenerErrors, error);
						},
					}),
			),
			// A release has no error channel to model into, and the pin's `dispose` resolves an
			// already-settled promise, so the fold exists to keep the ban's shape rather than to
			// carry a failure that can happen.
			(open) =>
				Effect.tryPromise({try: () => open.dispose(), catch: connectionRefusalOf}).pipe(
					Effect.ignore,
				),
		);

		yield* Effect.forkScoped(
			Effect.forever(Queue.take(listenerErrors).pipe(Effect.flatMap(Effect.logError))),
		);

		/**
		 * The leases this client holds, keyed by session id. A drop leaves the entries in place
		 * *invalidated* rather than removing them, so a call after a drop refuses `Disconnected`
		 * off the pin's own dead handle instead of `SessionNotFound` off an emptied table — the
		 * session did not go anywhere, the connection did. A reacquire overwrites its entry.
		 */
		const leases = new Map<string, PiSessionHandle>();

		/**
		 * A lease carries the session's own snapshot the moment its `create`/`attach` result is
		 * applied, so an absent one is the server having answered something the protocol does not
		 * allow — a refusal rather than a `cwd` this service would have to invent.
		 */
		const refOf = (lease: PiSessionHandle): Effect.Effect<PiSessionRef, ProtocolRefused> =>
			lease.snapshot === undefined
				? Effect.fail(
						new ProtocolRefused({
							code: "internal_error",
							detail: `no snapshot arrived for session ${lease.id}`,
						}),
					)
				: Effect.succeed({
						id: lease.id,
						cwd: lease.snapshot.cwd,
						model: lease.snapshot.model,
					});

		const dial = (open: () => Promise<unknown>): Effect.Effect<void, ConnectionRefusal> =>
			Effect.tryPromise({try: open, catch: connectionRefusalOf}).pipe(Effect.asVoid);

		const createSession = Effect.fn("PiClientService.createSession")(function* (
			cwd: string,
			options: OpenSessionOptions = {},
		) {
			const lease = yield* Effect.tryPromise({
				try: () => client.createSession({...options, cwd}),
				catch: connectionRefusalOf,
			});
			leases.set(lease.id, lease);
			return yield* refOf(lease);
		});

		const attachSession = Effect.fn("PiClientService.attachSession")(function* (sessionId: string) {
			const held = leases.get(sessionId);
			if (held?.active) return yield* refOf(held);
			const attach = Effect.tryPromise({
				try: () => client.attachSession(sessionId),
				catch: (cause) => sessionRefusalOf(sessionId, cause),
			});
			// A dead entry is this client having owned the session on the socket that just went, so
			// this call is a reacquire and the server's release of the old owner may lag it.
			const lease = yield* held === undefined ? attach : Effect.retry(attach, reacquireWait);
			leases.set(lease.id, lease);
			return yield* refOf(lease);
		});

		/**
		 * The lease every session-scoped call needs. An absent one is this client never having
		 * taken the session, which is a different fact from the server not knowing it — the
		 * detail says which, because both arrive as `SessionNotFound`.
		 */
		const leased = (sessionId: string): Effect.Effect<PiSessionHandle, SessionNotFound> => {
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

		const prompt = Effect.fn("PiClientService.prompt")(function* (sessionId: string, text: string) {
			const lease = yield* leased(sessionId);
			return yield* Effect.tryPromise({
				try: () => lease.prompt(text),
				catch: (cause) => sessionRefusalOf(sessionId, cause),
			});
		});

		const abort = Effect.fn("PiClientService.abort")(function* (sessionId: string) {
			const lease = yield* leased(sessionId);
			return yield* Effect.tryPromise({
				try: () => lease.abort(),
				catch: (cause) => sessionRefusalOf(sessionId, cause),
			});
		});

		const setModel = Effect.fn("PiClientService.setModel")(function* (
			sessionId: string,
			model: ModelRef,
		) {
			const lease = yield* leased(sessionId);
			return yield* Effect.tryPromise({
				try: () => lease.setModel(model),
				catch: (cause) => sessionRefusalOf(sessionId, cause),
			});
		});

		const snapshots = (sessionId: string): Stream.Stream<SessionSnapshot> =>
			Stream.callback<SessionSnapshot>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() =>
						client.onEvent((event) => {
							if (event.type === "session_snapshot" && event.snapshot.id === sessionId) {
								Queue.offerUnsafe(queue, event.snapshot);
							}
						}),
					),
					(unsubscribe) => Effect.sync(unsubscribe),
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
			prompt,
			abort,
			setModel,
			models: Effect.sync(() => client.snapshot?.models ?? []),
			snapshots,
			disconnections,
		};
	});
