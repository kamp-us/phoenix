/**
 * An in-process protocol server for this folder's unit tests: a real `ws` listener on loopback that
 * decodes with `ClientMessageDecoder` and answers with `encodeServerMessage`, so the transport and
 * the lease service are exercised over the real codec and a real socket without a model, an
 * `AgentSession` or the loopback `PiServerService`.
 *
 * It is deliberately dumb — no session table, no ownership, no pushed snapshots. Those live on the
 * real server, and the suites that need them are this folder's integration tier.
 */

import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {
	type ClientMessage,
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerMessage,
} from "@earendil-works/pi-protocol";
import {Effect, type Scope} from "effect";
import {type WebSocket, WebSocketServer} from "ws";

export interface ProtocolServer {
	readonly url: string;
	/** Every client message the server decoded, in arrival order across all connections. */
	readonly received: () => ReadonlyArray<ClientMessage>;
	/** How many sockets have been accepted since the server started. */
	readonly connectionCount: () => number;
	/** Kills every open socket without a close frame — a drop, not an orderly close. */
	readonly dropAll: () => void;
}

export interface ProtocolServerOptions {
	/**
	 * Answers one decoded client message. Returning `undefined` sends nothing. The default answers
	 * `hello` with a `hello` and every request with an empty `list` result.
	 */
	readonly answer?: (message: ClientMessage) => ServerMessage | undefined;
}

const serverId = randomUUID();

const defaultAnswer = (message: ClientMessage): ServerMessage | undefined => {
	if (message.type === "hello") {
		return {
			type: "hello",
			version: PROTOCOL_VERSION,
			connectionId: randomUUID(),
			snapshot: {
				serverId,
				protocolVersion: PROTOCOL_VERSION,
				revision: 0,
				sessions: [],
				models: [],
			},
		};
	}
	return {type: "response", id: message.id, ok: true, result: {command: "list", sessions: []}};
};

export const startProtocolServer = (
	options: ProtocolServerOptions = {},
): Effect.Effect<ProtocolServer, never, Scope.Scope> =>
	Effect.gen(function* () {
		const answer = options.answer ?? defaultAnswer;
		const received: ClientMessage[] = [];
		const sockets = new Set<WebSocket>();
		let connectionCount = 0;

		const httpServer = yield* Effect.acquireRelease(
			Effect.sync(() => {
				const http = createServer();
				const wss = new WebSocketServer({server: http});
				wss.on("connection", (socket) => {
					connectionCount += 1;
					sockets.add(socket);
					const decoder = new ClientMessageDecoder();
					socket.on("error", () => {});
					socket.on("close", () => sockets.delete(socket));
					socket.on("message", (data: Buffer) => {
						for (const message of decoder.push(new Uint8Array(data))) {
							received.push(message);
							const reply = answer(message);
							if (reply !== undefined) socket.send(encodeServerMessage(reply));
						}
					});
				});
				return http;
			}),
			(http) =>
				Effect.callback<void>((resume) => {
					for (const socket of sockets) socket.terminate();
					sockets.clear();
					http.closeAllConnections();
					http.close(() => resume(Effect.void));
				}),
		);

		const address = yield* Effect.callback<AddressInfo>((resume) => {
			httpServer.listen({host: "127.0.0.1", port: 0}, () => {
				const bound = httpServer.address();
				resume(bound === null || typeof bound === "string" ? Effect.never : Effect.succeed(bound));
			});
		});

		return {
			url: `ws://127.0.0.1:${address.port}/`,
			received: () => [...received],
			connectionCount: () => connectionCount,
			dropAll: () => {
				for (const socket of sockets) socket.terminate();
				sockets.clear();
			},
		};
	});
