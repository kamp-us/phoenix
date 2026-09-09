/**
 * The reservation, against real sockets — the incident of #8593 reproduced: a program holding
 * `[::1]:<port>` while the desk is asked for that same port. A fake would pin nothing here, because
 * what is being tested is which addresses the kernel says are free.
 */

import {createServer, type Server} from "node:net";
import {afterEach, describe, expect, it} from "vitest";
import {displayHost, forwardLoopback, LOOPBACK_HOSTS, reserveLoopbackPort} from "./loopback.ts";

const open: Array<Server> = [];

const listen = (host: string, port: number): Promise<Server> =>
	new Promise((resolve, reject) => {
		const socket = createServer();
		open.push(socket);
		socket.once("error", reject);
		socket.listen({host, port}, () => resolve(socket));
	});

const portOf = (socket: Server): number => {
	const address = socket.address();
	if (typeof address !== "object" || address === null) throw new Error("no port");
	return address.port;
};

afterEach(async () => {
	await Promise.all(open.splice(0).map((socket) => new Promise((done) => socket.close(done))));
});

describe("reserving a requested port", () => {
	it("refuses when another program holds it on ::1 only, naming that address", async () => {
		const squatter = await listen("::1", 0);
		const port = portOf(squatter);
		await expect(reserveLoopbackPort(port)).rejects.toThrow(
			`port ${port} is already taken on [::1]`,
		);
	});

	it("refuses when another program holds it on 127.0.0.1 only, naming that address", async () => {
		const squatter = await listen("127.0.0.1", 0);
		const port = portOf(squatter);
		await expect(reserveLoopbackPort(port)).rejects.toThrow(
			`port ${port} is already taken on 127.0.0.1`,
		);
	});

	it("hands back the requested port, with both families to bind, when nobody holds it", async () => {
		const free = await listen("127.0.0.1", 0);
		const port = portOf(free);
		await new Promise((done) => free.close(done));
		expect(await reserveLoopbackPort(port)).toEqual({port, hosts: [...LOOPBACK_HOSTS]});
	});
});

describe("reserving a free port", () => {
	it("keeps its fallback: a port taken on ::1 is skipped rather than refused", async () => {
		const squatter = await listen("::1", 0);
		const reserved = await reserveLoopbackPort(0);
		expect(reserved.port).not.toBe(portOf(squatter));
		expect(reserved.hosts).toEqual([...LOOPBACK_HOSTS]);
	});
});

describe("the forwarded address", () => {
	it("is answered by the server that bound the other family", async () => {
		const {createServer: createHttpServer} = await import("node:http");
		const app = createHttpServer((_request, response) => response.end("desk"));
		const reserved = await reserveLoopbackPort(0);
		await new Promise<void>((done) =>
			app.listen({host: LOOPBACK_HOSTS[0], port: reserved.port}, () => done()),
		);
		const forwarder = await forwardLoopback(app, LOOPBACK_HOSTS[1], reserved.port);
		try {
			const answered = await fetch(`http://[::1]:${reserved.port}/`).then((r) => r.text());
			expect(answered).toBe("desk");
		} finally {
			await new Promise((done) => forwarder.close(done));
			await new Promise((done) => app.close(done));
		}
	});
});

describe("displayHost", () => {
	it("brackets an IPv6 address, so a message reads as a URL authority", () => {
		expect(displayHost("::1")).toBe("[::1]");
		expect(displayHost("127.0.0.1")).toBe("127.0.0.1");
	});
});
