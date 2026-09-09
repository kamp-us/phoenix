/**
 * An in-process protocol server for this folder's unit tests: a real `ws` listener on loopback that
 * decodes with `createClientMessageDecoder` and answers with `encodeServerMessage`, so the transport and
 * the lease service are exercised over the real codec and a real socket without a model, an
 * `AgentSession` or the loopback `PiServerService`.
 *
 * It is deliberately dumb — no session table, no ownership, no pushed snapshots. Those live on the
 * real server, and the suites that need them are this folder's integration tier.
 */

import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {Effect, type Scope} from "effect";
import {type WebSocket, WebSocketServer} from "ws";
import {
	type ClientMessage,
	createClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	SESSION_SUBSCRIPTION_ID,
	type ServerMessage,
} from "../wire/index.ts";

export interface ProtocolServer {
	readonly url: string;
	/** What a `PiClientService` under test must be told to dial this fixture. */
	readonly serverId: string;
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

/** One id for the module, because a fixture's clients are constructed against it before they dial. */
export const fixtureServerId = randomUUID();

/** The target every request under this fixture is addressed to. */
export const fixtureServerTarget = {serverId: fixtureServerId} as const;

/** The `hello` handshake and an empty `list` for everything else, exported as a fallback arm. */
export const defaultAnswer = (message: ClientMessage): ServerMessage | undefined => {
	if (message.type === "hello") {
		return {type: "hello", version: PROTOCOL_VERSION, serverId: fixtureServerId};
	}
	if (message.type === "cancel") return undefined;
	return {type: "response", id: message.id, ok: true, result: {command: "list", sessions: []}};
};

/** The server snapshot the real host pushes right after its `hello`, as the fixture's own arm. */
export const serverSnapshotUpdate = (): ServerMessage => ({
	type: "service_update",
	subscriptionId: SESSION_SUBSCRIPTION_ID,
	update: {
		type: "server_snapshot",
		snapshot: {
			serverId: fixtureServerId,
			protocolVersion: PROTOCOL_VERSION,
			revision: 0,
			sessions: [],
			models: [],
		},
	},
});

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
					const decoder = createClientMessageDecoder();
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
			serverId: fixtureServerId,
			received: () => [...received],
			connectionCount: () => connectionCount,
			dropAll: () => {
				for (const socket of sockets) socket.terminate();
				sockets.clear();
			},
		};
	});
