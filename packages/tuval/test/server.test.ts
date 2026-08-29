import {spawn} from "node:child_process";
import {createServer as createHttpServer} from "node:http";
import {createServer as createUnixServer, type Socket} from "node:net";
import {fileURLToPath} from "node:url";
import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {DefaultPackageManager, SettingsManager} from "@earendil-works/pi-coding-agent";
import {
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type SessionMetadata,
	type SessionSnapshot,
} from "@earendil-works/pi-protocol";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit, Fiber, FileSystem, Path} from "effect";
import * as Latch from "effect/Latch";
import {makeExtensionUI} from "../src/backend/extension-ui.js";
import {makeDiscoveryTransport} from "../src/backend/pi-protocol.js";
import {
	makeMemoryWorkspaceStateStore,
	makeOperationalPackageRegistrations,
	makeOperationalWorkspaceSettings,
} from "../src/backend/resilience.js";
import {startTuval, TUVAL_HOST} from "../src/backend/server.js";
import {sessionIdentity} from "../src/shared/discovery.js";
import {TestFailure, tryPromise} from "./test-effect.js";

const fixture = Effect.fn("test.fixture")(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-server-"});
	const asset = path.join(root, "index.html");
	yield* fs.writeFileString(asset, "<!doctype html><main>Tuval test shell</main>");
	return {root, asset, socket: path.join(root, "pi.sock")};
});

const contributionPackage = Effect.fn("test.contributionPackage")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const packageRoot = path.join(root, "package");
	const contributionAsset = path.join(packageRoot, "contribution.js");
	yield* fs.makeDirectory(packageRoot);
	yield* fs.writeFileString(path.join(packageRoot, "extension.js"), "export default function() {}");
	yield* fs.writeFileString(contributionAsset, "export const contribution = 'loaded';\n");
	yield* fs.writeFileString(
		path.join(packageRoot, "package.json"),
		JSON.stringify({
			name: "server-contribution-fixture",
			type: "module",
			pi: {extensions: ["./extension.js"]},
			tuval: {
				contractVersion: 1,
				frontend: {nodes: [{key: "server.fixture", asset: "./contribution.js"}]},
			},
		}),
	);
	const settingsManager = SettingsManager.inMemory(
		{packages: [packageRoot]},
		{projectTrusted: true},
	);
	return {
		contributionAsset,
		options: {
			cwd: root,
			agentDir: root,
			settingsManager,
			packageManager: new DefaultPackageManager({
				cwd: root,
				agentDir: root,
				settingsManager,
			}),
		},
	};
});

const waitForUrl = (child: ReturnType<typeof spawn>) =>
	Effect.callback<string, TestFailure>((resume) => {
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(
			() =>
				resume(
					Effect.fail(
						new TestFailure({
							cause: new Error(
								`tuval bin did not report readiness${stderr === "" ? "" : `: ${stderr}`}`,
							),
						}),
					),
				),
			10_000,
		);
		const onData = (chunk: Buffer) => {
			stdout += chunk.toString();
			const match = /Tuval ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
			if (match?.[1] !== undefined) resume(Effect.succeed(match[1]));
		};
		const onStderr = (chunk: Buffer) => {
			stderr += chunk.toString();
		};
		const onError = (cause: Error) => resume(Effect.fail(new TestFailure({cause})));
		const onExit = (code: number | null) =>
			resume(
				Effect.fail(
					new TestFailure({
						cause: new Error(
							`tuval bin exited before readiness (${code})${stderr === "" ? "" : `: ${stderr}`}`,
						),
					}),
				),
			);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onStderr);
		child.once("error", onError);
		child.once("exit", onExit);
		return Effect.sync(() => {
			clearTimeout(timeout);
			child.stdout?.off("data", onData);
			child.stderr?.off("data", onStderr);
			child.off("error", onError);
			child.off("exit", onExit);
		});
	});

const waitForExit = (child: ReturnType<typeof spawn>) =>
	Effect.callback<number | null>((resume) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resume(Effect.succeed(child.exitCode));
			return;
		}
		const exit = (code: number | null) => resume(Effect.succeed(code));
		child.once("exit", exit);
		return Effect.sync(() => child.off("exit", exit));
	});

const liveSnapshot: SessionSnapshot = {
	id: "cold-live-session",
	cwd: "/tmp/tuval",
	createdAt: 1,
	updatedAt: 1,
	phase: "idle",
	model: {provider: "anthropic", id: "claude-sonnet"},
	thinkingLevel: "high",
	attached: true,
	locked: false,
	revision: 1,
	transcript: [],
	queuedSteer: [],
	queuedSteerCount: 0,
};

const createdSnapshot: SessionSnapshot = {
	...liveSnapshot,
	id: "created-live-session",
	createdAt: 2,
	updatedAt: 2,
};

const syntheticUnixPiServer = Effect.fn("test.syntheticUnixPiServer")(function* (
	socketPath: string,
) {
	const commands: Array<string> = [];
	const sockets = new Set<Socket>();
	let closed = false;
	const server = createUnixServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		const decoder = new ClientMessageDecoder();
		socket.on("data", (chunk) => {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			for (const message of decoder.push(bytes)) {
				if (message.type === "hello") {
					socket.write(
						encodeServerMessage({
							type: "hello",
							version: PROTOCOL_VERSION,
							connectionId: "cold-tuval-test",
							snapshot: {
								serverId: "synthetic",
								protocolVersion: PROTOCOL_VERSION,
								revision: 1,
								sessions: [liveSnapshot, createdSnapshot].map(({id, createdAt, cwd}) => ({
									id,
									createdAt,
									cwd,
								})),
								models: [],
							},
						}),
					);
					continue;
				}
				const request = message.request;
				commands.push(request.command);
				if (request.command === "list") {
					socket.write(
						encodeServerMessage({
							type: "response",
							id: message.id,
							ok: true,
							result: {
								command: "list",
								sessions: [liveSnapshot, createdSnapshot].map(({id, createdAt, cwd}) => ({
									id,
									createdAt,
									cwd,
								})),
							},
						}),
					);
					continue;
				}
				if (request.command === "prompt" || request.command === "create") {
					socket.write(
						encodeServerMessage({
							type: "response",
							id: message.id,
							ok: true,
							result: {command: request.command, session: createdSnapshot},
						}),
					);
					continue;
				}
				if (request.command === "attach") {
					socket.write(
						encodeServerMessage({
							type: "response",
							id: message.id,
							ok: true,
							result: {
								command: "attach",
								session: request.sessionId === createdSnapshot.id ? createdSnapshot : liveSnapshot,
							},
						}),
					);
					continue;
				}
				if (request.command === "detach") {
					socket.write(
						encodeServerMessage({
							type: "response",
							id: message.id,
							ok: true,
							result: {command: "detach", sessionId: request.sessionId},
						}),
					);
				}
			}
		});
	});
	yield* Effect.callback<void, Error>((resume) => {
		const error = (cause: Error) => resume(Effect.fail(cause));
		server.once("error", error);
		server.listen(socketPath, () => {
			server.off("error", error);
			resume(Effect.void);
		});
	});
	const close = Effect.suspend(() => {
		if (closed) return Effect.void;
		closed = true;
		return Effect.callback<void>((resume) => {
			for (const socket of [...sockets]) socket.destroy();
			server.close(() => resume(Effect.void));
		});
	});
	yield* Effect.addFinalizer(() => close);
	return {commands, close};
});

describe("Tuval local server", () => {
	it.layer(NodeServices.layer)((it) => {
		it.effect(
			"restores a fresh lease after killing and restarting the executable and transport",
			() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const path = yield* Path.Path;
					const {root, socket} = yield* fixture();
					const protocol = yield* syntheticUnixPiServer(socket);
					const bin = fileURLToPath(new URL("../dist/backend/bin.js", import.meta.url));
					const spawnTuval = () =>
						spawn(process.execPath, [bin, "--no-open", "--pi-socket", socket], {
							env: {...process.env, PI_CODING_AGENT_DIR: root},
							stdio: ["ignore", "pipe", "pipe"],
						});
					const first = spawnTuval();
					yield* Effect.addFinalizer(() => Effect.sync(() => first.kill("SIGKILL")));
					const firstUrl = yield* waitForUrl(first);
					const attached = (yield* tryPromise(() =>
						fetch(`${firstUrl}/fate`, {
							method: "POST",
							headers: {"content-type": "application/json"},
							body: JSON.stringify({
								version: 1,
								operations: [
									{
										id: "attach",
										kind: "mutation",
										name: "liveSession.attach",
										input: {sessionId: liveSnapshot.id},
										select: [],
									},
								],
							}),
						}).then((response) => response.json()),
					)) as {results: Array<{ok: boolean; data: {_tag: string}}>};
					assert.isTrue(attached.results[0]?.ok ?? false);
					assert.strictEqual(attached.results[0]?.data._tag, "attached");
					const mutate = (name: string, input: Record<string, unknown>) =>
						tryPromise(() =>
							fetch(`${firstUrl}/fate`, {
								method: "POST",
								headers: {"content-type": "application/json"},
								body: JSON.stringify({
									version: 1,
									operations: [{id: name, kind: "mutation", name, input, select: []}],
								}),
							}).then((response) => response.json()),
						);
					const control = (yield* mutate("liveSession.create", {
						correlationId: "before-kill-control",
						cwd: liveSnapshot.cwd,
					})) as {results: Array<{data: {_tag: string; reason?: string}}>};
					assert.strictEqual(
						control.results[0]?.data._tag,
						"acknowledged",
						control.results[0]?.data.reason,
					);
					const prompt = (yield* mutate("liveSession.prompt", {
						correlationId: "before-kill-prompt",
						text: "must run exactly once",
					})) as {results: Array<{data: {_tag: string; reason?: string}}>};
					assert.strictEqual(
						prompt.results[0]?.data._tag,
						"acknowledged",
						prompt.results[0]?.data.reason,
					);
					const statePath = path.join(root, "tuval", "workspace-state.json");
					const persistedState = yield* fs.readFileString(statePath);
					assert.include(persistedState, createdSnapshot.id);
					const firstExit = yield* Effect.forkChild(waitForExit(first));
					first.kill("SIGKILL");
					yield* Fiber.join(firstExit);
					yield* protocol.close;
					yield* fs.remove(socket).pipe(Effect.ignore);
					const restartedProtocol = yield* syntheticUnixPiServer(socket);

					const second = spawnTuval();
					yield* Effect.addFinalizer(() => Effect.sync(() => second.kill("SIGTERM")));
					const secondUrl = yield* waitForUrl(second);
					const current = (yield* tryPromise(() =>
						fetch(`${secondUrl}/fate`, {
							method: "POST",
							headers: {"content-type": "application/json"},
							body: JSON.stringify({
								version: 1,
								operations: [
									{id: "current", kind: "query", name: "liveSession.current", select: []},
								],
							}),
						}).then((response) => response.json()),
					)) as {results: Array<{data: {_tag: string; sessionId: string}}>};
					assert.deepInclude(current.results[0]?.data, {
						_tag: "attached",
						sessionId: createdSnapshot.id,
					});
					const allCommands = [...protocol.commands, ...restartedProtocol.commands];
					assert.lengthOf(
						allCommands.filter((command) => command === "attach"),
						2,
					);
					assert.lengthOf(
						allCommands.filter((command) => command === "prompt"),
						1,
					);
					assert.lengthOf(
						allCommands.filter((command) => command === "create"),
						1,
					);
					const secondExit = yield* Effect.forkChild(waitForExit(second));
					second.kill("SIGTERM");
					yield* Fiber.join(secondExit);
				}),
			30_000,
		);
		it.effect(
			"reconnects headlessly after transport replacement while the Tuval server stays up",
			() =>
				Effect.gen(function* () {
					const {asset} = yield* fixture();
					const commands: Array<string> = [];
					let connections = 0;
					let activeHandlers: Parameters<ByteTransportFactory>[0] | undefined;
					let truth = liveSnapshot;
					const transport: ByteTransportFactory = (handlers) => {
						connections += 1;
						activeHandlers = handlers;
						const decoder = new ClientMessageDecoder();
						return {
							send: async (chunk) => {
								for (const message of decoder.push(chunk)) {
									if (message.type === "hello") {
										handlers.onData(
											encodeServerMessage({
												type: "hello",
												version: PROTOCOL_VERSION,
												connectionId: `headless-${connections}`,
												snapshot: {
													serverId: "headless",
													protocolVersion: PROTOCOL_VERSION,
													revision: truth.revision,
													sessions: [{id: truth.id, createdAt: truth.createdAt, cwd: truth.cwd}],
													models: [],
												},
											}),
										);
										continue;
									}
									commands.push(message.request.command);
									if (message.request.command === "attach") {
										handlers.onData(
											encodeServerMessage({
												type: "response",
												id: message.id,
												ok: true,
												result: {command: "attach", session: truth},
											}),
										);
									} else if (message.request.command === "prompt") {
										handlers.onData(
											encodeServerMessage({
												type: "response",
												id: message.id,
												ok: true,
												result: {command: "prompt", session: truth},
											}),
										);
									} else if (message.request.command === "detach") {
										handlers.onData(
											encodeServerMessage({
												type: "response",
												id: message.id,
												ok: true,
												result: {command: "detach", sessionId: truth.id},
											}),
										);
									}
								}
							},
							close: handlers.onClose,
						};
					};
					const server = yield* startTuval({
						staticAsset: asset,
						liveSessionTransport: transport,
						reconnect: {retries: 0, baseDelayMs: 1, maxDelayMs: 1},
						openBrowser: () => Effect.void,
					});
					const mutate = (name: string, input: Record<string, unknown>) =>
						tryPromise(() =>
							fetch(`${server.url}/fate`, {
								method: "POST",
								headers: {"content-type": "application/json"},
								body: JSON.stringify({
									version: 1,
									operations: [{id: name, kind: "mutation", name, input, select: []}],
								}),
							}).then((response) => response.json()),
						);
					yield* mutate("liveSession.attach", {sessionId: truth.id});
					yield* mutate("liveSession.prompt", {
						correlationId: "headless-before-reconnect",
						text: "run once",
					});
					truth = {...truth, revision: 2, updatedAt: 2};
					activeHandlers?.onClose();
					for (let attempt = 0; attempt < 50; attempt += 1) {
						if (commands.filter((command) => command === "attach").length === 2) break;
						yield* Effect.yieldNow;
					}
					const current = (yield* tryPromise(() =>
						fetch(`${server.url}/fate`, {
							method: "POST",
							headers: {"content-type": "application/json"},
							body: JSON.stringify({
								version: 1,
								operations: [
									{id: "current", kind: "query", name: "liveSession.current", select: []},
								],
							}),
						}).then((response) => response.json()),
					)) as {results: Array<{data: {sessionId: string; revision: number}}>};
					assert.deepInclude(current.results[0]?.data, {sessionId: truth.id, revision: 2});
					assert.strictEqual(connections, 2);
					assert.lengthOf(
						commands.filter((command) => command === "attach"),
						2,
					);
					assert.lengthOf(
						commands.filter((command) => command === "prompt"),
						1,
					);
				}),
		);

		it.effect("continues independent restoration after initial transport exhaustion", () =>
			Effect.gen(function* () {
				const {asset} = yield* fixture();
				let attempts = 0;
				let restoredSettings: Record<string, string> | undefined;
				const unavailable: ByteTransportFactory = () => {
					attempts += 1;
					return Promise.reject(new Error("transport unavailable at /Users/alice/private.sock"));
				};
				const server = yield* startTuval({
					staticAsset: asset,
					liveSessionTransport: unavailable,
					reconnect: {retries: 0, rearmDelayMs: 10_000},
					workspaceStateStore: makeMemoryWorkspaceStateStore({
						version: 1,
						selectedSessionId: null,
						settings: {theme: "dark"},
						packageRegistrations: [],
						extensionUI: [],
					}),
					operationalWorkspaceSettings: {
						read: () => Effect.succeed(restoredSettings ?? {}),
						restore: (settings) =>
							Effect.sync(() => {
								restoredSettings = {...settings};
							}),
					},
					openBrowser: () => Effect.void,
				});
				assert.strictEqual(attempts, 2);
				assert.deepStrictEqual(restoredSettings, {theme: "dark"});
				const resilience = (yield* tryPromise(() =>
					fetch(`${server.url}/api/resilience`).then((response) => response.json()),
				)) as {diagnostics: Array<{code: string; message: string}>};
				assert.isTrue(resilience.diagnostics.some(({code}) => code === "reconnect-exhausted"));
				assert.notInclude(JSON.stringify(resilience), "alice");
			}),
		);

		it.effect("degrades package resolution without aborting independent startup restoration", () =>
			Effect.gen(function* () {
				const {root, asset} = yield* fixture();
				const settingsManager = SettingsManager.inMemory({}, {projectTrusted: true});
				const packageManager = new DefaultPackageManager({
					cwd: root,
					agentDir: root,
					settingsManager,
				});
				packageManager.resolve = () =>
					Promise.reject(new Error("resolution failed at /Users/alice/private-package"));
				let restoredSettings: Record<string, string> = {};
				const server = yield* startTuval({
					staticAsset: asset,
					packageContributions: {cwd: root, agentDir: root, settingsManager, packageManager},
					workspaceStateStore: makeMemoryWorkspaceStateStore({
						version: 1,
						selectedSessionId: null,
						settings: {theme: "dark"},
						packageRegistrations: [],
						extensionUI: [],
					}),
					operationalWorkspaceSettings: {
						read: () => Effect.succeed(restoredSettings),
						restore: (settings) =>
							Effect.sync(() => {
								restoredSettings = {...settings};
							}),
					},
					openBrowser: () => Effect.void,
				});
				assert.deepStrictEqual(restoredSettings, {theme: "dark"});
				const catalog = (yield* tryPromise(() =>
					fetch(`${server.url}/api/contributions`).then((response) => response.json()),
				)) as {diagnostics: Array<{reason: string}>; frontend: unknown[]};
				assert.deepStrictEqual(catalog.frontend, []);
				assert.deepInclude(catalog.diagnostics[0], {reason: "package-resolution-failed"});
				const resilience = (yield* tryPromise(() =>
					fetch(`${server.url}/api/resilience`).then((response) => response.json()),
				)) as {diagnostics: Array<{code: string}>};
				assert.isTrue(
					resilience.diagnostics.some(({code}) => code === "package-resolution-failed"),
				);
			}),
		);

		it.effect("rolls back catalog and replay when registration persistence fails", () =>
			Effect.gen(function* () {
				const {root, asset} = yield* fixture();
				const contribution = yield* contributionPackage(root);
				const packageName = "server-contribution-fixture";
				const store = makeMemoryWorkspaceStateStore({
					version: 1,
					selectedSessionId: null,
					settings: {},
					packageRegistrations: [packageName],
					extensionUI: [
						{
							scope: {packageName, sessionId: "registration-failure-session"},
							statuses: [{key: "stale", text: "must-not-replay"}],
							widgets: [],
						},
					],
				});
				const server = yield* startTuval({
					staticAsset: asset,
					packageContributions: contribution.options,
					workspaceStateStore: store,
					operationalPackageRegistrations: {
						available: [packageName],
						read: () => Effect.succeed([packageName]),
						restore: () => Effect.fail("registration persistence refused"),
					},
					openBrowser: () => Effect.void,
				});
				const catalog = (yield* tryPromise(() =>
					fetch(`${server.url}/api/contributions`).then((response) => response.json()),
				)) as {frontend: unknown[]};
				assert.deepStrictEqual(catalog.frontend, []);
				assert.deepStrictEqual(store.current().packageRegistrations, []);
				assert.deepStrictEqual(store.current().extensionUI, []);
				const resilience = (yield* tryPromise(() =>
					fetch(`${server.url}/api/resilience`).then((response) => response.json()),
				)) as {diagnostics: Array<{code: string}>; packageRegistrations: string[]};
				assert.deepStrictEqual(resilience.packageRegistrations, []);
				assert.isTrue(
					resilience.diagnostics.some(({code}) => code === "package-registration-restore-failed"),
				);
			}),
		);

		it.effect("clears proven-missing selection intent durably", () =>
			Effect.gen(function* () {
				const {asset} = yield* fixture();
				const unavailable: ByteTransportFactory = () => Promise.reject(new Error("offline"));
				const missingStore = makeMemoryWorkspaceStateStore({
					version: 1,
					selectedSessionId: "proven-missing-session",
					settings: {},
					packageRegistrations: [],
					extensionUI: [],
				});
				const missing = yield* startTuval({
					staticAsset: asset,
					protocolTransport: makeDiscoveryTransport([]),
					liveSessionTransport: unavailable,
					reconnect: {retries: 0, rearmDelayMs: 10_000},
					workspaceStateStore: missingStore,
					openBrowser: () => Effect.void,
				});
				assert.isNull(missingStore.current().selectedSessionId);
				const missingResilience = (yield* tryPromise(() =>
					fetch(`${missing.url}/api/resilience`).then((response) => response.json()),
				)) as {diagnostics: Array<{code: string}>};
				assert.isTrue(
					missingResilience.diagnostics.some(({code}) => code === "selected-session-unavailable"),
				);
			}),
		);

		it.effect("commits registrations and replay state only for activated backend packages", () =>
			Effect.gen(function* () {
				const {root, asset} = yield* fixture();
				const plain = fileURLToPath(new URL("./fixtures/plain-pi", import.meta.url));
				const failing = fileURLToPath(new URL("./fixtures/backend-failure", import.meta.url));
				const settingsManager = SettingsManager.inMemory(
					{packages: [plain, failing]},
					{projectTrusted: true},
				);
				const store = makeMemoryWorkspaceStateStore({
					version: 1,
					selectedSessionId: null,
					settings: {},
					packageRegistrations: ["fixture-plain-pi", "backend-failure"],
					extensionUI: [
						{
							scope: {packageName: "fixture-plain-pi", sessionId: "healthy-session"},
							statuses: [{key: "health", text: "ready"}],
							widgets: [],
						},
						{
							scope: {packageName: "backend-failure", sessionId: "failed-session"},
							statuses: [{key: "stale", text: "must-not-replay"}],
							widgets: [],
						},
					],
				});
				const server = yield* startTuval({
					staticAsset: asset,
					packageContributions: {
						cwd: root,
						agentDir: root,
						settingsManager,
						packageManager: new DefaultPackageManager({
							cwd: root,
							agentDir: root,
							settingsManager,
						}),
					},
					workspaceStateStore: store,
					openBrowser: () => Effect.void,
				});
				assert.deepStrictEqual(store.current().packageRegistrations, ["fixture-plain-pi"]);
				assert.deepStrictEqual(
					store.current().extensionUI.map(({scope}) => scope.packageName),
					["fixture-plain-pi"],
				);
				const resilience = (yield* tryPromise(() =>
					fetch(`${server.url}/api/resilience`).then((response) => response.json()),
				)) as {diagnostics: Array<{code: string}>; packageRegistrations: string[]};
				assert.deepStrictEqual(resilience.packageRegistrations, ["fixture-plain-pi"]);
				assert.isTrue(
					resilience.diagnostics.some(({code}) => code === "backend-layer-build-failed"),
				);
			}),
		);

		it.effect("binds loopback, serves static and fate discovery, then opens after readiness", () =>
			Effect.gen(function* () {
				const {root, asset} = yield* fixture();
				let opened: string | undefined;
				const server = yield* startTuval({
					staticAsset: asset,
					sessionRoots: [`${root}/missing-sessions`],
					openBrowser: (url) =>
						tryPromise(async () => {
							const health = (await fetch(`${url}/health`).then((response) => response.json())) as {
								status?: unknown;
								url?: unknown;
							};
							assert.strictEqual(health.status, "ready");
							assert.strictEqual(health.url, url);
							opened = url;
						}),
				});

				assert.strictEqual(server.host, TUVAL_HOST);
				assert.strictEqual(server.url, opened);
				assert.include(
					yield* tryPromise(() => fetch(server.url).then((response) => response.text())),
					"Tuval test shell",
				);
				const fate = yield* tryPromise(() =>
					fetch(`${server.url}/fate`, {
						method: "POST",
						headers: {"content-type": "application/json"},
						body: JSON.stringify({
							version: 1,
							operations: [{id: "discovery", kind: "query", name: "discovery", select: []}],
						}),
					}).then((response) => response.json()),
				);
				assert.deepEqual(fate, {
					version: 1,
					results: [{id: "discovery", ok: true, data: {_tag: "empty", sessions: []}}],
				});
			}),
		);

		it.effect("serves only loaded exact contribution assets as JavaScript", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const {root, asset} = yield* fixture();
				const contribution = yield* contributionPackage(root);
				const server = yield* startTuval({
					staticAsset: asset,
					packageContributions: contribution.options,
					openBrowser: () => Effect.void,
				});
				const catalogResponse = yield* tryPromise(() => fetch(`${server.url}/api/contributions`));
				const catalog = (yield* tryPromise(() => catalogResponse.json())) as {
					frontend: Array<{asset: string}>;
				};
				const assetUrl = catalog.frontend[0]?.asset;
				assert.isDefined(assetUrl);
				assert.notInclude(JSON.stringify(catalog), root);

				const loaded = yield* tryPromise(() => fetch(`${server.url}${assetUrl}`));
				assert.strictEqual(loaded.status, 200);
				assert.include(loaded.headers.get("content-type") ?? "", "text/javascript");
				assert.strictEqual(loaded.headers.get("cache-control"), "no-cache");
				assert.strictEqual(
					yield* tryPromise(() => loaded.text()),
					"export const contribution = 'loaded';\n",
				);

				for (const refused of [
					"/api/contribution-assets/v1-1.js",
					"/api/contribution-assets/../package.json",
					"/api/contribution-assets/%2e%2e%2fpackage.json",
				]) {
					const response = yield* tryPromise(() => fetch(`${server.url}${refused}`));
					assert.strictEqual(response.status, 404);
					assert.notInclude(yield* tryPromise(() => response.text()), root);
				}

				yield* fs.remove(contribution.contributionAsset);
				const unreadable = yield* tryPromise(() => fetch(`${server.url}${assetUrl}`));
				assert.strictEqual(unreadable.status, 404);
				assert.notInclude(yield* tryPromise(() => unreadable.text()), root);
			}),
		);

		it.effect("keeps unreadable, invalid, and nameless package diagnostics path-free", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const {root, asset} = yield* fixture();
				const packageRoots = ["unreadable", "invalid", "nameless"].map((name) =>
					path.join(root, name),
				);
				for (const [index, packageRoot] of packageRoots.entries()) {
					yield* fs.makeDirectory(packageRoot);
					yield* fs.writeFileString(
						path.join(packageRoot, "extension.js"),
						"export default function() {}",
					);
					yield* fs.writeFileString(
						path.join(packageRoot, "package.json"),
						JSON.stringify({
							name: `diagnostic-fixture-${index}`,
							type: "module",
							pi: {extensions: ["./extension.js"]},
						}),
					);
				}
				const settingsManager = SettingsManager.inMemory(
					{packages: packageRoots},
					{projectTrusted: true},
				);
				const packageManager = new DefaultPackageManager({
					cwd: root,
					agentDir: root,
					settingsManager,
				});
				const resolved = yield* tryPromise(() => packageManager.resolve());
				packageManager.resolve = async () => resolved;
				yield* fs.remove(path.join(packageRoots[0] ?? "", "package.json"));
				yield* fs.writeFileString(path.join(packageRoots[1] ?? "", "package.json"), "{");
				yield* fs.writeFileString(
					path.join(packageRoots[2] ?? "", "package.json"),
					JSON.stringify({type: "module", pi: {extensions: ["./extension.js"]}}),
				);

				const server = yield* startTuval({
					staticAsset: asset,
					packageContributions: {
						cwd: root,
						agentDir: root,
						settingsManager,
						packageManager,
					},
					openBrowser: () => Effect.void,
				});
				const response = yield* tryPromise(() => fetch(`${server.url}/api/contributions`));
				const catalog = (yield* tryPromise(() => response.json())) as {
					diagnostics: Array<{packageName: string; reason: string; message: string}>;
				};
				assert.deepStrictEqual(
					catalog.diagnostics.map(({reason, message}) => ({reason, message})),
					[
						{
							reason: "package-manifest-unreadable",
							message: "Package manifest is unreadable",
						},
						{
							reason: "package-manifest-invalid-json",
							message: "Package manifest is not valid JSON",
						},
						{
							reason: "package-name-invalid",
							message: "Package manifest has no valid public package identity",
						},
					],
				);
				for (const diagnostic of catalog.diagnostics) {
					assert.match(
						diagnostic.packageName,
						/^unidentified-(?:user|project|temporary)-package-\d+$/,
					);
					assert.isFalse(path.isAbsolute(diagnostic.packageName));
					assert.notInclude(JSON.stringify(diagnostic), root);
				}
				assert.strictEqual(
					new Set(catalog.diagnostics.map(({packageName}) => packageName)).size,
					packageRoots.length,
				);
				const reloaded = (yield* tryPromise(() =>
					fetch(`${server.url}/api/contributions`).then((value) => value.json()),
				)) as {diagnostics: Array<{packageName: string; reason: string; message: string}>};
				assert.deepStrictEqual(reloaded.diagnostics, catalog.diagnostics);
			}),
		);

		it.effect("uses configured live-protocol session metadata as authoritative lineage", () =>
			Effect.gen(function* () {
				const {root, asset} = yield* fixture();
				const path = yield* Path.Path;
				const sessions: ReadonlyArray<SessionMetadata> = [
					{id: "protocol-parent", createdAt: 1, cwd: "/tmp/parent"},
					{
						id: "protocol-child",
						createdAt: 2,
						parentSessionId: "protocol-parent",
						cwd: "/tmp/child",
					},
				];
				const server = yield* startTuval({
					staticAsset: asset,
					sessionRoots: [path.join(root, "missing-sessions")],
					lineage: {
						runRoots: [path.join(root, "missing-runs")],
						storePath: path.join(root, "lineage.json"),
					},
					liveSessionTransport: makeDiscoveryTransport(sessions),
					openBrowser: () => Effect.void,
				});
				const response = (yield* tryPromise(() =>
					fetch(`${server.url}/fate`, {
						method: "POST",
						headers: {"content-type": "application/json"},
						body: JSON.stringify({
							version: 1,
							operations: [{id: "lineage", kind: "query", name: "lineage", select: []}],
						}),
					}).then((value) => value.json()),
				)) as {
					results: Array<{data?: {graph?: {edges?: Array<Record<string, unknown>>}}}>;
				};
				assert.deepInclude(response.results[0]?.data?.graph?.edges?.[0], {
					kind: "fork",
					parent: sessionIdentity("protocol-parent"),
					child: sessionIdentity("protocol-child"),
					source: "protocol",
				});
			}),
		);

		it.effect(
			"persists and deterministically restores headless workspace state across server restart",
			() =>
				Effect.gen(function* () {
					const {root, asset} = yield* fixture();
					const path = yield* Path.Path;
					const store = makeMemoryWorkspaceStateStore({
						version: 1,
						selectedSessionId: null,
						settings: {theme: "dark"},
						packageRegistrations: ["restart-package"],
						extensionUI: [
							{
								scope: {packageName: "restart-package", sessionId: "restart-session"},
								statuses: [{key: "phase", text: "cold"}],
								widgets: [],
							},
						],
					});
					const restoredSettings: Array<Record<string, string>> = [];
					const settingsState = makeOperationalWorkspaceSettings();
					const operationalWorkspaceSettings = {
						read: settingsState.read,
						restore: (settings: Record<string, string>) =>
							settingsState
								.restore(settings)
								.pipe(
									Effect.tap(() => Effect.sync(() => void restoredSettings.push({...settings}))),
								),
					};
					const firstUI = makeExtensionUI();
					const common = {
						staticAsset: asset,
						sessionRoots: [path.join(root, "missing-sessions")],
						lineage: {
							runRoots: [path.join(root, "missing-runs")],
							storePath: path.join(root, "lineage.json"),
						},
						workspaceStateStore: store,
						operationalWorkspaceSettings,
						operationalPackageRegistrations: makeOperationalPackageRegistrations([
							"restart-package",
						]),
						openBrowser: () => Effect.void,
					};
					const first = yield* startTuval({...common, extensionUI: firstUI});
					const firstRestoration = (yield* tryPromise(() =>
						fetch(`${first.url}/api/resilience`).then((response) => response.json()),
					)) as {stages: Array<{stage: string}>};
					assert.deepStrictEqual(
						firstRestoration.stages.map(({stage}) => stage),
						[
							"discovery",
							"lineage",
							"selection",
							"settings",
							"package-registrations",
							"extension-ui-current",
						],
					);
					yield* firstUI.dispatch(
						{packageName: "restart-package", sessionId: "restart-session"},
						{
							type: "extension_ui_request",
							id: "phase-done",
							method: "setStatus",
							statusKey: "phase",
							statusText: "warm",
						},
					);
					yield* first.close();

					const secondUI = makeExtensionUI();
					const second = yield* startTuval({...common, extensionUI: secondUI});
					assert.deepStrictEqual(yield* secondUI.snapshots(), [
						{
							scope: {packageName: "restart-package", sessionId: "restart-session"},
							statuses: [{key: "phase", text: "warm"}],
							widgets: [],
						},
					]);
					assert.deepStrictEqual(restoredSettings, [{theme: "dark"}, {theme: "dark"}]);
					yield* second.close();
				}),
		);

		it.effect(
			"returns an actionable startup failure and never opens the browser when binding fails",
			() =>
				Effect.gen(function* () {
					const occupied = createHttpServer();
					yield* Effect.callback<void>((resume) => {
						occupied.listen(0, TUVAL_HOST, () => resume(Effect.void));
					});
					yield* Effect.addFinalizer(() =>
						Effect.callback<void>((resume) => {
							occupied.close(() => resume(Effect.void));
						}),
					);
					const address = occupied.address();
					if (address === null || typeof address === "string") {
						return yield* Effect.die(new Error("occupied server did not expose a TCP address"));
					}
					let opened = false;
					const exit = yield* Effect.exit(
						startTuval({
							port: address.port,
							openBrowser: () =>
								Effect.sync(() => {
									opened = true;
								}),
						}),
					);
					assert.isTrue(Exit.isFailure(exit));
					assert.isFalse(opened);
				}),
		);

		it.effect("ends a queued request before waiting for Node server close", () =>
			Effect.gen(function* () {
				const gate = yield* Latch.make();
				let markQueued: () => void = () => {};
				const queued = new Promise<void>((resolve) => {
					markQueued = resolve;
				});
				const server = yield* startTuval({
					requestDispatchGate: gate.await,
					onRequestQueued: markQueued,
					openBrowser: () => Effect.void,
				});
				const pending = yield* tryPromise(() => fetch(`${server.url}/health`)).pipe(
					Effect.forkChild,
				);
				yield* tryPromise(() => queued);

				yield* server.close();
				const exit = yield* Effect.exit(Fiber.join(pending));
				assert.isTrue(Exit.isFailure(exit));
			}),
		);
	});
});
