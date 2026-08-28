import {spawn} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeServices} from "@effect/platform-node";
import {Effect, Exit, Scope} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {type RunningTuval, StartupFailure, startTuval, TUVAL_HOST} from "../src/backend/server.js";

const running: Array<RunningTuval> = [];
const scopes: Array<Scope.Closeable> = [];
const temporary: Array<string> = [];

const start = async (options: Parameters<typeof startTuval>[0]): Promise<RunningTuval> => {
	const scope = await Effect.runPromise(Scope.make());
	scopes.push(scope);
	const server = await Effect.runPromise(
		startTuval(options).pipe(
			Effect.provideService(Scope.Scope, scope),
			Effect.provide(NodeServices.layer),
		),
	);
	running.push(server);
	return server;
};

afterEach(async () => {
	await Promise.all(
		scopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))),
	);
	running.splice(0);
	await Promise.all(temporary.splice(0).map((path) => rm(path, {recursive: true, force: true})));
});

const fixture = async (): Promise<{root: string; asset: string}> => {
	const root = await mkdtemp(join(tmpdir(), "tuval-server-"));
	temporary.push(root);
	const asset = join(root, "index.html");
	await writeFile(asset, "<!doctype html><main>Tuval test shell</main>");
	return {root, asset};
};

describe("Tuval local server", () => {
	it("binds loopback, serves static and fate discovery, then opens after readiness", async () => {
		const {root, asset} = await fixture();
		let opened: string | undefined;
		const server = await start({
			staticAsset: asset,
			sessionRoots: [join(root, "missing-sessions")],
			openBrowser: (url) =>
				Effect.tryPromise({
					try: async () => {
						const health = await fetch(`${url}/health`).then((response) => response.json());
						expect(health).toMatchObject({status: "ready", url});
						opened = url;
					},
					catch: (cause) => new StartupFailure({message: "Health probe failed", cause}),
				}),
		});

		expect(server.host).toBe(TUVAL_HOST);
		expect(server.url).toBe(opened);
		await expect(fetch(server.url).then((response) => response.text())).resolves.toContain(
			"Tuval test shell",
		);

		const fate = await fetch(`${server.url}/fate`, {
			method: "POST",
			headers: {"content-type": "application/json"},
			body: JSON.stringify({
				version: 1,
				operations: [{id: "discovery", kind: "query", name: "discovery", select: []}],
			}),
		}).then((response) => response.json());
		expect(fate).toEqual({
			version: 1,
			results: [{id: "discovery", ok: true, data: {_tag: "empty", sessions: []}}],
		});
	});

	it("returns an actionable startup failure and never opens the browser when binding fails", async () => {
		const occupied = createServer();
		await new Promise<void>((resolve) => occupied.listen(0, TUVAL_HOST, resolve));
		const port = (occupied.address() as AddressInfo).port;
		let opened = false;
		try {
			await expect(
				start({
					port,
					openBrowser: () =>
						Effect.sync(() => {
							opened = true;
						}),
				}),
			).rejects.toMatchObject({
				name: "StartupFailure",
				message: expect.stringContaining(`could not bind ${TUVAL_HOST}:${port}`),
			});
			expect(opened).toBe(false);

			const bin = fileURLToPath(new URL("../dist/backend/bin.js", import.meta.url));
			const child = spawn(process.execPath, [bin, "--no-open", "--port", String(port)], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
			expect(exitCode).not.toBe(0);
			expect(stderr).toContain(`could not bind ${TUVAL_HOST}:${port}`);
		} finally {
			await new Promise<void>((resolve, reject) =>
				occupied.close((error) => (error === undefined ? resolve() : reject(error))),
			);
		}
	});

	it("runs the declared bin cold with the HTTP server in the same process", async () => {
		const {root} = await fixture();
		const bin = fileURLToPath(new URL("../dist/backend/bin.js", import.meta.url));
		const child = spawn(process.execPath, [bin, "--no-open"], {
			env: {...process.env, PI_CODING_AGENT_DIR: root},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const url = await new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error("tuval bin did not report readiness")),
				10_000,
			);
			let stdout = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
				const match = /Tuval ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
				if (match?.[1] !== undefined) {
					clearTimeout(timeout);
					resolve(match[1]);
				}
			});
			child.once("error", reject);
			child.once("exit", (code) =>
				reject(new Error(`tuval bin exited before readiness (${code})`)),
			);
		});
		try {
			const health = (await fetch(`${url}/health`).then((response) => response.json())) as {
				status: string;
				pid: number;
			};
			expect(health).toEqual(expect.objectContaining({status: "ready", pid: child.pid}));
		} finally {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		}
	});
});
