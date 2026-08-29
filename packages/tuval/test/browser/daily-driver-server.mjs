import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {createServer as createUnixServer} from "node:net";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createUnixTransportFactory} from "@earendil-works/pi-client/unix";
import {DefaultPackageManager, SettingsManager} from "@earendil-works/pi-coding-agent";
import {
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
} from "@earendil-works/pi-protocol";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {
	makeFileWorkspaceStateStore,
	makeOperationalWorkspaceSettings,
} from "../../dist/backend/resilience.js";
import {startTuval} from "../../dist/backend/server.js";

const port = Number(process.argv[2] ?? "0");
const root = process.env.TUVAL_DAILY_DRIVER_ROOT;
if (root === undefined) throw new Error("TUVAL_DAILY_DRIVER_ROOT is required");

const piStatePath = join(root, "pi-state.json");
const socketPath = join(root, "pi.sock");
const unavailablePath = join(root, "child-unavailable");
const packageRoot = fileURLToPath(new URL("../fixtures", import.meta.url));
const packagePaths = [
	fileURLToPath(new URL("../fixtures/plain-pi", import.meta.url)),
	fileURLToPath(new URL("../fixtures/extension-ui-peer", import.meta.url)),
];

const model = {
	provider: "synthetic",
	id: "daily-driver",
	name: "Daily driver",
	api: "synthetic",
	reasoning: true,
	input: ["text"],
	contextWindow: 10_000,
	maxTokens: 1_000,
	cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
	supportedThinkingLevels: ["off", "low", "medium", "high"],
	authenticated: true,
};

const loadPiState = () => JSON.parse(readFileSync(piStatePath, "utf8"));
const savePiState = (state) => writeFileSync(piStatePath, `${JSON.stringify(state, null, 2)}\n`);
const visibleSessions = (state) =>
	existsSync(unavailablePath)
		? state.sessions.filter(({id}) => id !== "daily-child")
		: state.sessions;

const startPiFixture = Effect.fn("dailyDriver.startPiFixture")(function* () {
	const sockets = new Set();
	const server = createUnixServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		const decoder = new ClientMessageDecoder();
		socket.on("data", (chunk) => {
			for (const message of decoder.push(chunk)) {
				const state = loadPiState();
				const sessions = visibleSessions(state);
				if (message.type === "hello") {
					socket.write(
						encodeServerMessage({
							type: "hello",
							version: PROTOCOL_VERSION,
							connectionId: "daily-driver-fixture",
							snapshot: {
								serverId: "daily-driver-fixture",
								protocolVersion: PROTOCOL_VERSION,
								revision: state.revision,
								sessions: sessions.map(({id, createdAt, updatedAt, cwd}) => ({
									id,
									createdAt,
									updatedAt,
									cwd,
								})),
								models: [model],
							},
						}),
					);
					continue;
				}
				const request = message.request;
				const respond = (result) =>
					socket.write(encodeServerMessage({type: "response", id: message.id, ok: true, result}));
				const refuse = (code, text) =>
					socket.write(
						encodeServerMessage({
							type: "response",
							id: message.id,
							ok: false,
							error: {code, message: text},
						}),
					);
				if (request.command === "list") {
					respond({
						command: "list",
						sessions: sessions.map(({id, createdAt, updatedAt, cwd}) => ({
							id,
							createdAt,
							updatedAt,
							cwd,
						})),
					});
					continue;
				}
				if (request.command === "attach") {
					const session = sessions.find(({id}) => id === request.sessionId);
					if (session === undefined) refuse("not_found", "fixture session is unavailable");
					else respond({command: "attach", session});
					continue;
				}
				if (request.command === "detach") {
					respond({command: "detach", sessionId: request.sessionId});
					continue;
				}
				const index = state.sessions.findIndex(({id}) => id === request.sessionId);
				if (index < 0 || !sessions.some(({id}) => id === request.sessionId)) {
					refuse("not_found", "fixture session is unavailable");
					continue;
				}
				const current = state.sessions[index];
				if (request.command === "prompt") {
					const promptIndex = state.commands.filter(({command}) => command === "prompt").length + 1;
					state.sessions[index] = {
						...current,
						revision: current.revision + 1,
						updatedAt: current.updatedAt + 1,
						transcript: [
							...current.transcript,
							{
								id: `daily-prompt-${promptIndex}`,
								role: "user",
								content: [{type: "text", text: request.text}],
								timestamp: current.updatedAt + 1,
							},
						],
					};
					state.commands.push({command: "prompt", text: request.text});
					state.revision += 1;
					savePiState(state);
					respond({command: "prompt", session: state.sessions[index]});
					const event = encodeServerMessage({
						type: "event",
						event: {type: "session_snapshot", snapshot: state.sessions[index]},
					});
					for (const client of sockets) client.write(event);
					continue;
				}
				if (request.command === "set_thinking") {
					state.sessions[index] = {
						...current,
						revision: current.revision + 1,
						updatedAt: current.updatedAt + 1,
						thinkingLevel: request.thinkingLevel,
					};
					state.commands.push({command: "set_thinking", value: request.thinkingLevel});
					state.revision += 1;
					savePiState(state);
					respond({command: "set_thinking", session: state.sessions[index]});
					const event = encodeServerMessage({
						type: "event",
						event: {type: "session_snapshot", snapshot: state.sessions[index]},
					});
					for (const client of sockets) client.write(event);
					continue;
				}
				refuse("not_implemented", `fixture does not implement ${request.command}`);
			}
		});
	});
	yield* Effect.callback((resume) => {
		const onError = (error) => resume(Effect.fail(error));
		server.once("error", onError);
		server.listen(socketPath, () => {
			server.off("error", onError);
			resume(Effect.void);
		});
	});
	yield* Effect.addFinalizer(() =>
		Effect.callback((resume) => {
			for (const socket of sockets) socket.destroy();
			server.close(() => resume(Effect.void));
		}),
	);
});

const settingsManager = SettingsManager.inMemory({packages: packagePaths}, {projectTrusted: true});
const packageManager = new DefaultPackageManager({
	cwd: packageRoot,
	agentDir: root,
	settingsManager,
});

NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			yield* startPiFixture();
			const workspaceStateStore = yield* makeFileWorkspaceStateStore(
				join(root, "tuval", "workspace-state.json"),
			);
			yield* startTuval({
				port,
				workspaceStateStore,
				operationalWorkspaceSettings: makeOperationalWorkspaceSettings(),
				packageContributions: {
					cwd: packageRoot,
					agentDir: root,
					settingsManager,
					packageManager,
				},
				sessionRoots: [join(root, "sessions")],
				lineage: {
					runRoots: [join(root, "sessions")],
					storePath: join(root, "tuval", "lineage.json"),
				},
				liveSessionTransport: createUnixTransportFactory({path: socketPath}),
				openBrowser: () => Effect.void,
				log: (line) => console.log(line),
			});
			yield* Effect.never;
		}),
	).pipe(Effect.provide(NodeServices.layer)),
);
