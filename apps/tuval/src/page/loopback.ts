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

/**
 * One port, free on every loopback family this machine has. The families are split into the one the
 * page server binds itself and the rest, because that is the split the caller acts on — and it
 * leaves no way to state "bind this family" for a family the reservation never cleared.
 */
export interface LoopbackReservation {
	readonly port: number;
	/** The address the page server binds. Never a family this machine lacks. */
	readonly host: string;
	/** The remaining addresses, each needing an accepting socket of its own. */
	readonly forwards: ReadonlyArray<string>;
}

const reservationOf = (port: number, hosts: ReadonlyArray<string>): LoopbackReservation => {
	const [host, ...forwards] = hosts;
	if (host === undefined) throw new Error("this machine has no loopback address to bind");
	return {port, host, forwards};
};

/** The families this machine has at all: binding port 0 on one it lacks answers `absent`. */
const presentHosts = async (): Promise<ReadonlyArray<string>> => {
	const present: Array<string> = [];
	for (const host of LOOPBACK_HOSTS) {
		if ((await availability(host, 0)) !== "absent") present.push(host);
	}
	return present;
};

/**
 * Reserve one port across every loopback family.
 *
 * A requested port binds them all or none: falling back would put the desk on a port the founder did
 * not ask for while whatever they collided with keeps answering the URL they typed, which is the
 * silent swap of #8593 with an extra step. A requested `0` is `pnpm dev`'s ask for "any free port"
 * and keeps its fallback — here that means retrying until one port is free on every family.
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
		return reservationOf(requested, hosts);
	}
	const present = await presentHosts();
	const [first, ...rest] = present;
	if (first === undefined) throw new Error("this machine has no loopback address to bind");
	for (let attempt = 0; attempt < FREE_PORT_ATTEMPTS; attempt++) {
		const port = await freePort(first);
		const taken: Array<string> = [];
		for (const host of rest) {
			if ((await availability(host, port)) === "taken") taken.push(host);
		}
		if (taken.length === 0) return reservationOf(port, present);
	}
	throw new Error(
		`no port was free on ${present.map(displayHost).join(" and ")} after ${FREE_PORT_ATTEMPTS} tries`,
	);
};

/** Whatever adopts the socket: Vite's server is an `http.Server` or an HTTP/2 one. */
export interface ConnectionSink {
	emit(event: "connection", socket: Socket): boolean;
}

/** An accepting socket on one loopback address, and the way to take it down. */
export interface LoopbackForwarder {
	/** Stop accepting, end what was accepted, and settle. */
	readonly close: () => Promise<void>;
}

/**
 * Accept on `host:port` and hand every connection to `target`.
 *
 * `emit("connection", socket)` is how an `http.Server` adopts a socket it did not accept: it runs
 * the same connection listener the server's own socket would, so requests, `upgrade` events and the
 * HMR websocket all behave as they do on the address Vite bound itself.
 *
 * The forwarder destroys what it accepted before it closes, because `net.Server.close` settles only
 * once every accepted connection has ended. The connections here are adopted by `target`, which is
 * torn down after this one, so waiting on them alone would wait forever — an open HMR websocket is a
 * browser tab, and the hang lands on Ctrl-C, in front of the kernel's checkpoint (#8804).
 */
export const forwardLoopback = (
	target: ConnectionSink,
	host: string,
	port: number,
): Promise<LoopbackForwarder> =>
	new Promise((resolve, reject) => {
		const accepted = new Set<Socket>();
		// The handler is registered with the server rather than after it listens: a connection that
		// arrives in between would otherwise be accepted and dropped.
		const socket: NetServer = createServer((connection) => {
			accepted.add(connection);
			connection.once("close", () => accepted.delete(connection));
			target.emit("connection", connection);
		});
		socket.once("error", (error) => {
			socket.close();
			reject(error);
		});
		socket.listen({host, port}, () =>
			resolve({
				close: () =>
					new Promise((done) => {
						for (const connection of accepted) connection.destroy();
						accepted.clear();
						socket.close(() => done());
					}),
			}),
		);
	});
