import {randomUUID} from "node:crypto";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {CallToolRequestSchema, ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {Effect, Fiber, Option, Queue, Schema, Scope, Stream} from "effect";
import {KernelBridge} from "../ai-agent/tools/KernelBridge.ts";
import {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {disconnected} from "./transport.ts";

class UnknownKernelTool extends Schema.TaggedError<UnknownKernelTool>()(
	"tuval/codex/UnknownKernelTool",
	{name: Schema.String},
) {}

const Spawn = Schema.Struct({program: ProgramId});
const Send = Schema.Struct({process: ProcessId, port: Schema.String, payload: Schema.Unknown});
const Read = Schema.Struct({process: ProcessId, port: Schema.String});
const tool = (
	name: string,
	description: string,
	properties: object,
	required: ReadonlyArray<string>,
) => ({
	name,
	description,
	inputSchema: {type: "object" as const, properties, required, additionalProperties: false},
});
const string = {type: "string"};
export const kernelTools = [
	tool(
		"spawn",
		"Start a registered Tuval program. Returns the new process id.",
		{program: string},
		["program"],
	),
	tool(
		"send",
		"Write a payload to a Tuval process in-port. Its declared port type decides which payloads it accepts.",
		{process: string, port: string, payload: {}},
		["process", "port", "payload"],
	),
	tool(
		"read",
		"Read the current value of a Tuval process out-port. Returns empty if it has not published.",
		{process: string, port: string},
		["process", "port"],
	),
];

export const callKernelTool = Effect.fn("Codex.kernelTool")(function* (
	name: string,
	input: unknown,
) {
	const bridge = yield* KernelBridge;
	switch (name) {
		case "spawn": {
			const args = yield* Schema.decodeUnknownEffect(Spawn)(input);
			return {process: yield* bridge.spawn(args.program)};
		}
		case "send": {
			const args = yield* Schema.decodeUnknownEffect(Send)(input);
			return yield* bridge.send(args.process, args.port, args.payload);
		}
		case "read": {
			const args = yield* Schema.decodeUnknownEffect(Read)(input);
			const value = yield* bridge.read(args.process, args.port);
			return Option.isSome(value) ? {empty: false, value: value.value} : {empty: true};
		}
		default:
			return yield* new UnknownKernelTool({name});
	}
});

// HTTP MCP works on resumed CLI threads too; dynamicTools can only be supplied at thread/start.
export const serveKernelTools = Effect.fn("Codex.serveKernelTools")(function* () {
	const scope = yield* Scope.Scope;
	const bridge = yield* KernelBridge;
	const services = yield* Effect.context<never>();
	const run = Effect.runPromiseWith(services);
	const token = randomUUID();
	const requests = yield* Queue.unbounded<{request: IncomingMessage; response: ServerResponse}>();
	const server = createServer((request, response) => {
		if (
			request.url !== "/mcp" ||
			request.headers.origin !== undefined ||
			request.headers.authorization !== `Bearer ${token}`
		) {
			response.writeHead(403).end();
			return;
		}
		Queue.offerUnsafe(requests, {request, response});
	});
	yield* Effect.addFinalizer(() =>
		Effect.callback<void>((resume) => {
			server.closeAllConnections();
			server.close(() => resume(Effect.void));
		}).pipe(Effect.andThen(Queue.shutdown(requests))),
	);
	yield* Effect.callback<void, ReturnType<typeof disconnected>>((resume) => {
		const onError = (error: Error) => resume(Effect.fail(disconnected(error)));
		server.once("error", onError);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", onError);
			resume(Effect.void);
		});
	});
	const handle = Effect.fn("Codex.mcpRequest")(function* ({
		request,
		response,
	}: {
		request: IncomingMessage;
		response: ServerResponse;
	}) {
		const mcp = new Server({name: "tuval", version: "0.0.0"}, {capabilities: {tools: {}}});
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		mcp.setRequestHandler(ListToolsRequestSchema, async () => ({tools: kernelTools}));
		mcp.setRequestHandler(CallToolRequestSchema, ({params}) =>
			run(
				callKernelTool(params.name, params.arguments).pipe(
					Effect.provideService(KernelBridge, bridge),
					Effect.map((value) => ({
						content: [{type: "text" as const, text: JSON.stringify(value)}],
					})),
					Effect.catch((error) =>
						Effect.succeed({
							isError: true,
							content: [{type: "text" as const, text: String(error)}],
						}),
					),
					Effect.forkIn(scope),
					Effect.flatMap(Fiber.join),
				),
			),
		);
		yield* Effect.acquireRelease(
			Effect.tryPromise({try: () => mcp.connect(transport), catch: disconnected}),
			() => Effect.tryPromise({try: () => mcp.close(), catch: disconnected}).pipe(Effect.ignore),
		);
		yield* Effect.tryPromise({
			try: () => transport.handleRequest(request, response),
			catch: disconnected,
		});
	});
	// Each request owns its transport; the listener only enqueues into the layer's scope.
	yield* Stream.fromQueue(requests).pipe(
		Stream.runForEach((request) =>
			Effect.forkIn(
				Effect.scoped(handle(request)).pipe(
					Effect.catch(() =>
						Effect.sync(() => {
							if (!request.response.headersSent) request.response.writeHead(500);
							request.response.end();
						}),
					),
				),
				scope,
			),
		),
		Effect.forkIn(scope),
	);
	const address = server.address();
	if (address === null || typeof address === "string")
		return yield* disconnected("The Tuval tool server did not bind a TCP port");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		http_headers: {Authorization: `Bearer ${token}`},
	};
});
