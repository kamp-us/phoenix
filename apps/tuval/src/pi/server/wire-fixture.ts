/**
 * A minimal wire client for the server's own tests: real framed CBOR over a real socket. The
 * product client is #7568's; this exists so this ticket's suite does not wait on that one, and it
 * is deliberately dumb — no reconnect, no lease, no transcript state.
 */

import {Effect, Queue, type Scope} from "effect";
import {WebSocket} from "ws";
import type {ClientMessage, Command, RpcTarget, ServerMessage} from "../wire/index.ts";
import {createServerMessageDecoder, encodeClientMessage} from "../wire/index.ts";

export interface WireClient {
	readonly send: (message: ClientMessage) => Effect.Effect<void>;
	/**
	 * Addresses the request for the caller: a command naming a session this fixture holds an
	 * attachment on goes out on that attachment, everything else on the bare server target. Both ids
	 * are learned off the wire — the `serverId` from the `hello`, the `attachmentId` from whatever
	 * `create` or `attach` answered — so a test states the command and nothing else.
	 */
	readonly request: (id: string, request: Command) => Effect.Effect<void>;
	/** The first server message matching, from the ones already in or the next one to arrive. */
	readonly next: (match: (message: ServerMessage) => boolean) => Effect.Effect<ServerMessage>;
	readonly received: () => ReadonlyArray<ServerMessage>;
	/** Completes when the socket closes, carrying the code and reason the server named. */
	readonly closure: Effect.Effect<{readonly code: number; readonly reason: string}>;
	readonly sendRaw: (bytes: Uint8Array) => Effect.Effect<void>;
}

export const connectWire = (
	url: string,
	options: {readonly headers?: Record<string, string>} = {},
): Effect.Effect<WireClient, never, Scope.Scope> =>
	Effect.gen(function* () {
		const decoder = createServerMessageDecoder();
		const inbox: ServerMessage[] = [];
		const arrivals = yield* Queue.unbounded<ServerMessage>();
		const closures = yield* Queue.unbounded<{code: number; reason: string}>();

		const socket = yield* Effect.acquireRelease(
			Effect.sync(
				() => new WebSocket(url, options.headers === undefined ? {} : {headers: options.headers}),
			),
			(ws) => Effect.sync(() => ws.close()),
		);
		socket.binaryType = "nodebuffer";
		socket.on("message", (data: Buffer) => {
			for (const message of decoder.push(new Uint8Array(data))) {
				remember(message);
				inbox.push(message);
				Queue.offerUnsafe(arrivals, message);
			}
		});
		socket.on("close", (code: number, reason: Buffer) => {
			Queue.offerUnsafe(closures, {code, reason: reason.toString("utf8")});
		});
		socket.on("error", (error: Error) => {
			Queue.offerUnsafe(closures, {code: 0, reason: error.message});
		});

		yield* Effect.callback<void>((resume) => {
			socket.once("open", () => resume(Effect.void));
			socket.once("error", () => resume(Effect.void));
		});

		let serverId: string | undefined;
		const hellos = yield* Queue.unbounded<string>();
		const attachments = new Map<string, string>();

		const send = (message: ClientMessage): Effect.Effect<void> =>
			Effect.sync(() => {
				socket.send(encodeClientMessage(message));
			});

		const remember = (message: ServerMessage): void => {
			if (message.type === "hello") Queue.offerUnsafe(hellos, message.serverId);
			if (message.type !== "response" || !message.ok) return;
			const result = message.result;
			if (result.command === "create" || result.command === "attach") {
				attachments.set(result.session.id, result.attachmentId);
			}
		};

		/**
		 * The server's id arrives in its `hello`, which a test never waits for explicitly, so the
		 * first request waits it out here. Every protocol-8 target needs it.
		 */
		const targetFor = (request: Command): Effect.Effect<RpcTarget> =>
			Effect.gen(function* () {
				serverId ??= yield* Queue.take(hellos);
				const id = serverId;
				if (!("sessionId" in request)) return {serverId: id};
				const attachmentId = attachments.get(request.sessionId);
				return attachmentId === undefined
					? {serverId: id}
					: {serverId: id, sessionId: request.sessionId, attachmentId};
			});

		const takeUntil = (match: (message: ServerMessage) => boolean): Effect.Effect<ServerMessage> =>
			Effect.flatMap(Queue.take(arrivals), (message) =>
				match(message) ? Effect.succeed(message) : takeUntil(match),
			);

		return {
			send,
			request: (id, request) =>
				Effect.flatMap(targetFor(request), (target) =>
					send({type: "request", id, target, request}),
				),
			next: (match) =>
				Effect.suspend(() => {
					const seen = inbox.find(match);
					return seen === undefined ? takeUntil(match) : Effect.succeed(seen);
				}),
			received: () => [...inbox],
			closure: Queue.take(closures),
			sendRaw: (bytes) => Effect.sync(() => socket.send(bytes)),
		};
	});
