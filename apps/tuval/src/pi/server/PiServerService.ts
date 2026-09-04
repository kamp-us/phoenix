/**
 * The loopback Pi server the 0.84.3 pin does not ship. Hand-ported into Effect from the spike's
 * `spike-server.mjs` (#7469, founder gist), which proved the behaviours; the production half —
 * the per-launch token, the Host/Origin guard, the frame and queue bounds — is new (#7465).
 *
 * One server per Pi process, on 127.0.0.1 and port 0 (founder ruling, 2026-09-02, on #7567): two
 * Pi processes on one machine run two servers on two ports and share nothing.
 *
 * The service is acquire/release scoped. Closing its scope closes every socket, ends every
 * connection's fibers and disposes every session exactly once — the table is drained before the
 * handles are disposed, so nothing can be disposed twice.
 */

import {randomUUID} from "node:crypto";
import {createServer, type Server as HttpServer, type IncomingMessage} from "node:http";
import type {AddressInfo} from "node:net";
import type {Duplex} from "node:stream";
import {
	type ClientMessage,
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerMessage,
} from "@earendil-works/pi-protocol";
import {Context, Effect, FiberSet, Layer, Queue, Redacted, type Scope} from "effect";
import {type WebSocket, WebSocketServer} from "ws";
import {dispatch} from "./dispatch.ts";
import {FrameRefused, MessageNotEncodable, ServerBindFailed} from "./errors.ts";
import {authorizeUpgrade, isRefused, refusalResponse} from "./handshake.ts";
import {
	CLOSE_FRAME_TOO_LARGE,
	CLOSE_INTERNAL,
	CLOSE_PROTOCOL_VIOLATION,
	CLOSE_QUEUE_OVERFLOW,
	defaultLimits,
	type PiServerLimits,
} from "./limits.ts";
import {makeOutbound} from "./outbound.ts";
import {type PiSessionHandle, PiSessionHost} from "./PiSessionHost.ts";
import {type ConnectionId, makeSessionRecords} from "./records.ts";
import {serverSnapshot, sessionSnapshot} from "./snapshots.ts";
import {mintCapabilityToken} from "./token.ts";

export interface PiServerAddress {
	readonly host: string;
	readonly port: number;
}

export interface PiServerConfig {
	readonly host?: string;
	readonly limits?: Partial<PiServerLimits>;
}

export interface PiServerApi {
	readonly address: PiServerAddress;
	/** The dial URL, token included — redacted so it cannot reach a log or the checkpoint. */
	readonly url: Redacted.Redacted<string>;
	readonly token: Redacted.Redacted<string>;
	readonly openConnections: Effect.Effect<number>;
	readonly openSessions: Effect.Effect<number>;
}

export class PiServerService extends Context.Service<PiServerService, PiServerApi>()(
	"tuval/pi/PiServerService",
) {
	static readonly layer = (
		config: PiServerConfig = {},
	): Layer.Layer<PiServerService, ServerBindFailed, PiSessionHost> =>
		Layer.effect(PiServerService, make(config));
}

const listen = (server: HttpServer, host: string): Effect.Effect<AddressInfo, ServerBindFailed> =>
	Effect.callback<AddressInfo, ServerBindFailed>((resume) => {
		const onError = (error: Error): void => {
			resume(Effect.fail(new ServerBindFailed({host, detail: error.message})));
		};
		server.once("error", onError);
		server.listen({host, port: 0}, () => {
			server.removeListener("error", onError);
			resume(Effect.succeed(server.address() as AddressInfo));
		});
	});

const detailOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const closeServer = (server: HttpServer): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		server.closeAllConnections();
		server.close(() => resume(Effect.void));
	});

const make = (
	config: PiServerConfig,
): Effect.Effect<PiServerApi, ServerBindFailed, PiSessionHost | Scope.Scope> =>
	Effect.gen(function* () {
		const host = yield* PiSessionHost;
		const limits: PiServerLimits = {...defaultLimits, ...config.limits};
		const bindHost = config.host ?? "127.0.0.1";
		const token = mintCapabilityToken();
		const serverId = randomUUID();
		const records = makeSessionRecords();
		const connections = new Set<WebSocket>();
		const accepted = yield* Queue.unbounded<WebSocket>();
		const fibers = yield* FiberSet.make();

		const httpServer = yield* Effect.acquireRelease(
			Effect.sync(() => createServer()).pipe(
				Effect.tap((server) =>
					Effect.sync(() => {
						const wss = new WebSocketServer({noServer: true});
						server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
							const verdict = authorizeUpgrade(
								{
									url: request.url,
									headers: {host: request.headers.host, origin: request.headers.origin},
								},
								token,
							);
							if (isRefused(verdict)) {
								socket.write(refusalResponse(verdict));
								socket.destroy();
								return;
							}
							wss.handleUpgrade(request, socket, head, (ws) => {
								connections.add(ws);
								Queue.offerUnsafe(accepted, ws);
							});
						});
					}),
				),
			),
			(server) =>
				Effect.sync(() => {
					for (const ws of connections) ws.terminate();
					connections.clear();
				}).pipe(
					Effect.andThen(closeServer(server)),
					Effect.andThen(
						Effect.suspend(() =>
							Effect.forEach(records.drain(), (handle) => handle.dispose, {
								concurrency: 1,
								discard: true,
							}),
						),
					),
				),
		);

		const address = yield* listen(httpServer, bindHost);

		yield* FiberSet.run(
			fibers,
			Effect.forever(
				Queue.take(accepted).pipe(
					Effect.flatMap((ws) => FiberSet.run(fibers, serveConnection(ws))),
				),
			),
		);

		/**
		 * One connection. The socket's callbacks only enqueue; every decision runs on this
		 * connection's own fibers, so a slow `create` never blocks the `list` behind it and both
		 * answers carry their own request id.
		 */
		function serveConnection(ws: WebSocket): Effect.Effect<void> {
			return Effect.gen(function* () {
				const connection: ConnectionId = randomUUID();
				const decoder = new ClientMessageDecoder({maxFrameLength: limits.maxInboundFrameLength});
				const frames = yield* Queue.unbounded<Uint8Array>();
				const closed = yield* Queue.unbounded<void>();
				const requests = yield* FiberSet.make();

				const closeWith = (code: number, reason: string): void => {
					ws.close(code, reason);
				};

				const outbound = yield* makeOutbound({
					capacity: limits.maxOutboundFrames,
					send: (frame) =>
						Effect.callback<void>((resume) => {
							ws.send(frame, () => resume(Effect.void));
						}),
				});

				const write = (message: ServerMessage): Effect.Effect<void> =>
					Effect.try({
						try: () => encodeServerMessage(message),
						catch: (cause) => new MessageNotEncodable({detail: detailOf(cause)}),
					}).pipe(
						Effect.flatMap((frame) =>
							Effect.sync(() => {
								if (!outbound.offer(frame)) {
									closeWith(CLOSE_QUEUE_OVERFLOW, "outbound queue over bound");
								}
							}),
						),
						Effect.catch((error) =>
							Effect.logError(error).pipe(
								Effect.andThen(Effect.sync(() => closeWith(CLOSE_INTERNAL, "encode failed"))),
							),
						),
					);

				/**
				 * The socket callback only enqueues bytes; decoding runs on a fiber, so a refused
				 * frame is a typed failure that names its close code rather than a throw inside a
				 * listener nobody can catch.
				 */
				ws.on("message", (data: Buffer) => {
					Queue.offerUnsafe(frames, new Uint8Array(data));
				});
				ws.on("close", () => {
					Queue.offerUnsafe(closed, undefined);
				});
				ws.on("error", () => {
					Queue.offerUnsafe(closed, undefined);
				});

				const decodeFrame = (bytes: Uint8Array) =>
					Effect.try({
						try: () => decoder.push(bytes),
						catch: (cause) => {
							const detail = detailOf(cause);
							return new FrameRefused({
								detail,
								overLengthBound:
									detail.toLowerCase().includes("length") ||
									detail.toLowerCase().includes("exceeds"),
							});
						},
					});

				yield* FiberSet.run(requests, outbound.run);

				const snapshotFor = (sessionId: string) =>
					Effect.gen(function* () {
						const record = records.get(sessionId);
						if (record === undefined) return;
						const view = yield* record.handle.read;
						yield* write({
							type: "event",
							event: {
								type: "session_snapshot",
								snapshot: sessionSnapshot(record, view, connection),
							},
						});
					});

				const context = {
					connection,
					records,
					host,
					now: () => Date.now(),
					onChanged: (sessionId: string) =>
						Effect.sync(() => {
							records.bump(sessionId, Date.now());
						}),
				};

				/**
				 * A session's own pushes: the host says it changed, the record's revision advances and
				 * the owner sees the new snapshot. Forked once per session this connection touches,
				 * over the handle rather than the id so a drained table cannot strand the loop.
				 */
				const followSession = (handle: PiSessionHandle) =>
					Effect.forever(
						handle.changes.pipe(
							Effect.andThen(Effect.sync(() => records.bump(handle.id, Date.now()))),
							Effect.andThen(snapshotFor(handle.id)),
						),
					);

				const models = yield* host.models;
				yield* write({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: connection,
					snapshot: serverSnapshot({
						serverId,
						revision: 0,
						records: records.list(),
						models,
					}),
				});

				const followed = new Set<string>();
				const handle = (message: ClientMessage): Effect.Effect<void> => {
					if (message.type === "hello") {
						return message.version === PROTOCOL_VERSION
							? Effect.void
							: write({
									type: "hello_error",
									error: {
										code: "version",
										message: `protocol version ${message.version} is not supported`,
									},
								});
					}
					return dispatch(context, message.request).pipe(
						Effect.tap((answer) =>
							Effect.gen(function* () {
								if (!answer.ok) return;
								const result = answer.result;
								if (result.command === "list" || result.command === "detach") return;
								const record = records.get(result.session.id);
								if (record === undefined || followed.has(result.session.id)) return;
								followed.add(result.session.id);
								yield* FiberSet.run(requests, followSession(record.handle));
							}),
						),
						Effect.flatMap((answer) =>
							write(
								answer.ok
									? {type: "response", id: message.id, ok: true, result: answer.result}
									: {type: "response", id: message.id, ok: false, error: answer.error},
							),
						),
					);
				};

				yield* FiberSet.run(
					requests,
					Effect.forever(
						Queue.take(frames).pipe(
							Effect.flatMap(decodeFrame),
							Effect.flatMap((messages) =>
								Effect.forEach(messages, (message) => FiberSet.run(requests, handle(message)), {
									concurrency: 1,
									discard: true,
								}),
							),
							Effect.catch((error: FrameRefused) =>
								Effect.sync(() => {
									closeWith(
										error.overLengthBound ? CLOSE_FRAME_TOO_LARGE : CLOSE_PROTOCOL_VIOLATION,
										error.detail.slice(0, 120),
									);
								}),
							),
						),
					),
				);

				yield* Queue.take(closed);
				records.releaseConnection(connection);
				connections.delete(ws);
			}).pipe(Effect.scoped);
		}

		return {
			address: {host: address.address, port: address.port},
			url: Redacted.make(`ws://${bindHost}:${address.port}/?token=${Redacted.value(token)}`),
			token,
			openConnections: Effect.sync(() => connections.size),
			openSessions: Effect.sync(() => records.list().length),
		};
	});
