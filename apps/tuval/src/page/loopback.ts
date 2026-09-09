/**
 * `localhost` on both loopback addresses — the desk's supported address (ADR 0370, #8593).
 *
 * A browser resolving `localhost` may pick `::1` or `127.0.0.1`, and Vite binds exactly one of them:
 * `resolveHostname` turns `server.host` into a single name and `httpServerStart` hands that one name
 * to `tryBindServer` (`vite/dist/node/chunks/node.js` at the installed 8.1.5). So a desk on
 * `127.0.0.1:5173` leaves `[::1]:5173` free for any other program, and the founder's `localhost`
 * lands there instead, with nothing failing anywhere.
 *
 * The fix is not a second HTTP server but a second accepting socket: a `net.Server` on the other
 * family hands each connection to the page's own `http.Server` with `emit("connection", …)`, so one
 * server — one middleware stack, one HMR websocket, one module graph — answers both addresses.
 */

import {createServer, type Server as NetServer, type Socket} from "node:net";

/** The two addresses `localhost` resolves to. The first is the one Vite itself binds. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

/** How many free ports to try before giving up, on the `port: 0` path only. */
const FREE_PORT_ATTEMPTS = 10;

/** A host as a URL authority writes it, which is the spelling an error message has to carry. */
export const displayHost = (host: string): string => (host.includes(":") ? `[${host}]` : host);

type Availability = "free" | "taken" | "absent";

/**
 * `absent` is a machine with that address family switched off: binding it answers `EADDRNOTAVAIL`
 * (or `EAFNOSUPPORT`), which is not a collision and must not refuse the desk — there is no second
 * family for anything to hide on.
 */
const availability = (host: string, port: number): Promise<Availability> =>
	new Promise((resolve, reject) => {
		const socket = createServer();
		socket.once("error", (error: NodeJS.ErrnoException) => {
			socket.close();
			if (error.code === "EADDRINUSE") resolve("taken");
			else if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") resolve("absent");
			else reject(error);
		});
		socket.listen({host, port}, () => socket.close(() => resolve("free")));
	});

/** A port the kernel picked as free on `host`, released again before it is returned. */
const freePort = (host: string): Promise<number> =>
	new Promise((resolve, reject) => {
		const socket = createServer();
		socket.once("error", reject);
		socket.listen({host, port: 0}, () => {
			const address = socket.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			socket.close(() =>
				port === 0 ? reject(new Error("the kernel named no port")) : resolve(port),
			);
		});
	});

/** Which loopback addresses this machine can serve, and the port every one of them is free on. */
export interface LoopbackReservation {
	readonly port: number;
	/** The addresses to bind, in `LOOPBACK_HOSTS` order, minus any family this machine lacks. */
	readonly hosts: ReadonlyArray<string>;
}

/**
 * Reserve one port across both loopback families.
 *
 * A requested port binds both families or neither: falling back would put the desk on a port the
 * founder did not ask for while whatever they collided with keeps answering the URL they typed,
 * which is the silent swap of #8593 with an extra step. A requested `0` is `pnpm dev`'s ask for
 * "any free port" and keeps its fallback — here that means retrying until one port is free on both.
 *
 * The reservation is released before it is used, so a program that binds the port in between still
 * wins the race. That loss is loud: the page server binds `strictPort`, so it refuses rather than
 * moving.
 */
export const reserveLoopbackPort = async (requested: number): Promise<LoopbackReservation> => {
	if (requested !== 0) {
		const hosts: Array<string> = [];
		for (const host of LOOPBACK_HOSTS) {
			const state = await availability(host, requested);
			if (state === "taken") {
				throw new Error(
					`port ${requested} is already taken on ${displayHost(host)} — the desk answers localhost on every loopback address it can, so it binds them all or none`,
				);
			}
			if (state === "free") hosts.push(host);
		}
		return {port: requested, hosts};
	}
	for (let attempt = 0; attempt < FREE_PORT_ATTEMPTS; attempt++) {
		const port = await freePort(LOOPBACK_HOSTS[0]);
		const hosts: Array<string> = [LOOPBACK_HOSTS[0]];
		const other = await availability(LOOPBACK_HOSTS[1], port);
		if (other === "taken") continue;
		if (other === "free") hosts.push(LOOPBACK_HOSTS[1]);
		return {port, hosts};
	}
	throw new Error(
		`no port was free on both ${displayHost(LOOPBACK_HOSTS[0])} and ${displayHost(LOOPBACK_HOSTS[1])} after ${FREE_PORT_ATTEMPTS} tries`,
	);
};

/** Whatever adopts the socket: Vite's server is an `http.Server` or an HTTP/2 one. */
export interface ConnectionSink {
	emit(event: "connection", socket: Socket): boolean;
}

/**
 * Accept on `host:port` and hand every connection to `target`.
 *
 * `emit("connection", socket)` is how an `http.Server` adopts a socket it did not accept: it runs
 * the same connection listener the server's own socket would, so requests, `upgrade` events and the
 * HMR websocket all behave as they do on the address Vite bound itself.
 */
export const forwardLoopback = (
	target: ConnectionSink,
	host: string,
	port: number,
): Promise<NetServer> =>
	new Promise((resolve, reject) => {
		// The handler is registered with the server rather than after it listens: a connection that
		// arrives in between would otherwise be accepted and dropped.
		const socket = createServer((connection) => target.emit("connection", connection));
		socket.once("error", (error) => {
			socket.close();
			reject(error);
		});
		socket.listen({host, port}, () => resolve(socket));
	});
