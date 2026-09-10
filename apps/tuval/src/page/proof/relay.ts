/**
 * A WebSocket relay the browser proof puts between the page and the kernel's transport, so the
 * proof can take connectivity away and give it back **without touching the kernel**. Cutting the
 * transport itself would stop the thing whose survival is the claim; cutting here leaves every
 * process running and every handle the kernel holds untouched, which is exactly the drop a laptop
 * sleeping produces.
 *
 * Two cuts, because a socket outage is two facts and the page answers them differently: the pairs
 * that are up are killed abruptly (`terminate`, which the browser reads as a 1006 close), and new
 * upgrades are refused for as long as the cut lasts.
 *
 * The relay's own upstream connection carries no `Origin`, which the transport's fence allows and
 * gates on the token alone (`../../shell/transport/handshake.ts`) — the query string the page
 * offered is passed through untouched, so the kernel still admits or refuses this page's own token
 * and nothing here weakens that check.
 */

import {Effect} from "effect";
import type {RawData} from "ws";
import {WebSocket, WebSocketServer} from "ws";

export interface ProofRelay {
	/** What the page attaches to: the upstream launch URL with this relay's address in front of it. */
	readonly url: string;
	readonly port: number;
	/** Kill every live pair and refuse new upgrades until `restore`. */
	readonly cut: () => void;
	readonly restore: () => void;
	readonly live: () => number;
}

interface Pair {
	readonly client: WebSocket;
	readonly server: WebSocket;
}

export const serveRelay = Effect.fn("tuval.proof.serveRelay")(function* (options: {
	readonly upstreamUrl: string;
}) {
	const upstream = new URL(options.upstreamUrl);
	const pairs = new Set<Pair>();
	let cutNow = false;

	const server = yield* Effect.acquireRelease(
		Effect.sync(
			() => new WebSocketServer({host: "127.0.0.1", port: 0, verifyClient: () => !cutNow}),
		),
		(running) => Effect.sync(() => running.close()),
	);

	server.on("connection", (client, request) => {
		const target = new URL(request.url ?? "/", `ws://${upstream.host}`);
		const forward = new WebSocket(target.toString());
		const pair: Pair = {client, server: forward};
		pairs.add(pair);
		// Frames the page sends before the upstream socket is open are the attach the page makes the
		// instant it connects. Dropping them would make every reconnect look like a kernel that never
		// answers, which is the failure this relay would be manufacturing rather than measuring.
		const queued: Array<{readonly data: RawData; readonly binary: boolean}> = [];
		forward.on("open", () => {
			for (const held of queued) forward.send(held.data, {binary: held.binary});
			queued.length = 0;
		});
		client.on("message", (data, binary) => {
			if (forward.readyState === WebSocket.OPEN) forward.send(data, {binary});
			else queued.push({data, binary});
		});
		forward.on("message", (data, binary) => {
			if (client.readyState === WebSocket.OPEN) client.send(data, {binary});
		});
		const end = () => {
			pairs.delete(pair);
			client.terminate();
			forward.terminate();
		};
		for (const socket of [client, forward]) {
			socket.on("close", end);
			socket.on("error", end);
		}
	});

	yield* Effect.callback<void>((resume) => {
		server.once("listening", () => resume(Effect.void));
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		return yield* Effect.die(new Error("the proof relay bound no port"));
	}
	const url = new URL(options.upstreamUrl);
	url.host = `127.0.0.1:${address.port}`;

	return {
		url: url.toString(),
		port: address.port,
		cut: () => {
			cutNow = true;
			for (const pair of [...pairs]) {
				pair.client.terminate();
				pair.server.terminate();
			}
		},
		restore: () => {
			cutNow = false;
		},
		live: () => pairs.size,
	} satisfies ProofRelay;
});
