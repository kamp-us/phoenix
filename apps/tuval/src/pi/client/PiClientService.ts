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
 * There is no retry loop in this service — one drop is one `Disconnected` and nothing dials again
 * until a caller asks. Retry policy belongs to the handlers and stays declared data (#7371).
 */

import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {PiClient, type PiSessionHandle} from "@earendil-works/pi-client";
import type {ModelRef, SessionSnapshot, ThinkingLevel} from "@earendil-works/pi-protocol";
import {Context, Effect, Layer, Queue, type Scope, Stream} from "effect";
import {
	type ConnectionRefusal,
	Disconnected,
	ProtocolRefused,
	SessionNotFound,
	type SessionRefusal,
} from "./errors.ts";
import {connectionRefusalOf, sessionRefusalOf} from "./refusals.ts";
import {webSocketTransportFactory} from "./transport.ts";

/** What a caller needs to keep about a session it holds a lease on. */
export interface PiSessionRef {
	readonly id: string;
	readonly cwd: string;
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
				: Effect.succeed({id: lease.id, cwd: lease.snapshot.cwd});

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
			const lease = yield* Effect.tryPromise({
				try: () => client.attachSession(sessionId),
				catch: (cause) => sessionRefusalOf(sessionId, cause),
			});
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
			snapshots,
			disconnections,
		};
	});
