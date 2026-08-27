import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import type {DiscoveryOutcome} from "../shared/wire.ts";
import {startTuvalServer, type TuvalServer} from "./server.ts";

const empty: DiscoveryOutcome = {kind: "empty", sessions: [], sources: []};
const running: Array<TuvalServer> = [];
afterEach(async () => {
	await Promise.all(running.splice(0).map((server) => server.close()));
});

describe("Tuval local server", () => {
	it("binds loopback, reports readiness before browser open, serves static and fate", async () => {
		const events: Array<string> = [];
		const server = await startTuvalServer({
			discover: async () => empty,
			assetPath: fileURLToPath(new URL("../../frontend-shell/index.html", import.meta.url)),
			onReady: (url) => {
				events.push(`ready:${url.href}`);
			},
			openBrowser: (url) => {
				events.push(`open:${url.href}`);
			},
		});
		running.push(server);
		expect(server.address.address).toBe("127.0.0.1");
		expect(events).toEqual([`ready:${server.url.href}`, `open:${server.url.href}`]);

		const shell = await fetch(server.url);
		expect(shell.status).toBe(200);
		expect(shell.headers.get("content-type")).toContain("text/html");
		expect(await shell.text()).toContain("The local workspace is ready.");

		const fate = await fetch(new URL("/fate", server.url), {
			method: "POST",
			headers: {"content-type": "application/json"},
			body: JSON.stringify({
				version: 1,
				operations: [{id: "discover", kind: "query", name: "discoverSessions", select: []}],
			}),
		});
		expect(fate.status).toBe(200);
		expect(await fate.json()).toMatchObject({
			version: 1,
			results: [{id: "discover", ok: true, data: {kind: "empty", sessions: []}}],
		});
	});

	it("turns a bind collision into an actionable startup failure", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen({host: "127.0.0.1", port: 0}, () => resolve());
		});
		const port = (blocker.address() as AddressInfo).port;
		try {
			await expect(startTuvalServer({port, discover: async () => empty})).rejects.toThrow(
				new RegExp(`Tuval could not bind 127\\.0\\.0\\.1:${port}`),
			);
		} finally {
			await new Promise<void>((resolve, reject) =>
				blocker.close((error) => (error === undefined ? resolve() : reject(error))),
			);
		}
	});
});
