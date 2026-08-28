import {spawn} from "node:child_process";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {fileURLToPath} from "node:url";
import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {
	type CurrentUser,
	FateInterpreter,
	type LivePublisher,
	type LiveTopicPublisher,
} from "@kampus/fate-effect";
import {Effect, Fiber, FileSystem, Layer, Queue, Schema, Stream} from "effect";
import {TuvalFateServerLive} from "./fate.js";
import {
	LiveSession,
	type LiveSessionService,
	makeUnavailableLiveSession,
	PiLiveSession,
} from "./live-session.js";
import {PiDiscoveryLive, type PiDiscoveryOptions} from "./pi-discovery.js";

export const TUVAL_HOST = "127.0.0.1";

export class StartupFailure extends Schema.TaggedErrorClass<StartupFailure>()(
	"tuval/StartupFailure",
	{message: Schema.String, cause: Schema.optionalKey(Schema.Defect())},
) {
	override readonly name = "StartupFailure";
}

export interface StartTuvalOptions extends PiDiscoveryOptions {
	readonly port?: number;
	readonly openBrowser?: (url: string) => Effect.Effect<void, unknown>;
	readonly staticAsset?: string;
	readonly log?: (line: string) => void;
	readonly liveSession?: LiveSessionService;
	readonly liveSessionTransport?: ByteTransportFactory;
}

export interface RunningTuval {
	readonly host: typeof TUVAL_HOST;
	readonly port: number;
	readonly url: string;
	readonly pid: number;
	readonly close: () => Effect.Effect<void, StartupFailure>;
}

const bodyOf = Effect.fn("TuvalServer.bodyOf")((request: IncomingMessage) =>
	Effect.tryPromise({
		try: async () => {
			if (request.method === "GET" || request.method === "HEAD") return undefined;
			const chunks: Array<Buffer> = [];
			for await (const chunk of request) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			return Buffer.concat(chunks);
		},
		catch: (cause) => new StartupFailure({message: "Tuval could not read the request body", cause}),
	}),
);

const toWebRequest = Effect.fn("TuvalServer.toWebRequest")(function* (
	request: IncomingMessage,
	origin: string,
) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	const body = yield* bodyOf(request);
	return new Request(new URL(request.url ?? "/", origin), {
		method: request.method ?? "GET",
		headers,
		...(body === undefined ? {} : {body}),
	});
});

const writeWebResponse = Effect.fn("TuvalServer.writeWebResponse")(
	(response: Response, target: ServerResponse) =>
		Effect.tryPromise({
			try: async () => {
				target.statusCode = response.status;
				response.headers.forEach((value, name) => {
					target.setHeader(name, value);
				});
				target.end(Buffer.from(await response.arrayBuffer()));
			},
			catch: (cause) => new StartupFailure({message: "Tuval could not write the response", cause}),
		}),
);

const defaultOpenBrowser = Effect.fn("TuvalServer.openBrowser")((url: string) =>
	Effect.callback<void, StartupFailure>((resume) => {
		const command =
			process.platform === "darwin"
				? {file: "open", args: [url]}
				: process.platform === "win32"
					? {file: "cmd", args: ["/c", "start", "", url]}
					: {file: "xdg-open", args: [url]};
		const child = spawn(command.file, command.args, {detached: true, stdio: "ignore"});
		child.once("error", (cause) =>
			resume(Effect.fail(new StartupFailure({message: "Tuval could not open the browser", cause}))),
		);
		child.once("spawn", () => {
			child.unref();
			resume(Effect.void);
		});
	}),
);

const closeServer = Effect.fn("TuvalServer.close")((server: Server) =>
	Effect.callback<void, StartupFailure>((resume) => {
		server.close((cause) =>
			resume(
				cause === undefined
					? Effect.void
					: Effect.fail(new StartupFailure({message: "Tuval failed while shutting down", cause})),
			),
		);
	}),
);

const noTopicPublisher: LiveTopicPublisher = {
	appendNode: () => Effect.void,
	prependNode: () => Effect.void,
	deleteEdge: () => Effect.void,
	invalidate: () => Effect.void,
};

const fateContext = {
	currentUser: {user: undefined} satisfies typeof CurrentUser.Service,
	livePublisher: {
		update: () => Effect.void,
		delete: () => Effect.void,
		invalidate: () => Effect.void,
		topic: () => noTopicPublisher,
	} satisfies typeof LivePublisher.Service,
};

const sseFrame = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;

const afterSequenceOf = (url: URL): number | undefined => {
	const value = url.searchParams.get("afterSequence");
	if (value === null) return 0;
	if (!/^\d+$/.test(value)) return undefined;
	const sequence = Number(value);
	return Number.isSafeInteger(sequence) ? sequence : undefined;
};

const writeFailure = (response: ServerResponse, error: unknown): void => {
	if (response.headersSent) {
		response.end();
		return;
	}
	response.statusCode = 500;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(
		JSON.stringify({
			error: error instanceof Error ? error.message : "Unknown Tuval server failure",
		}),
	);
};

const responseClosed = (response: ServerResponse) =>
	Effect.callback<void>((resume) => {
		const close = () => resume(Effect.void);
		response.once("close", close);
		return Effect.sync(() => response.off("close", close));
	});

const handleRequest = Effect.fn("TuvalServer.handleRequest")(function* (
	request: IncomingMessage,
	response: ServerResponse,
	origin: string,
	staticAsset: string,
	fs: typeof FileSystem.FileSystem.Service,
) {
	const url = new URL(request.url ?? "/", origin);
	if (request.method === "GET" && url.pathname === "/health") {
		response.setHeader("content-type", "application/json; charset=utf-8");
		response.end(JSON.stringify({status: "ready", url: origin, pid: process.pid}));
		return;
	}
	if (request.method === "POST" && url.pathname === "/fate") {
		const webRequest = yield* toWebRequest(request, origin);
		const webResponse = yield* FateInterpreter.handleRequest(webRequest, fateContext);
		yield* writeWebResponse(webResponse, response);
		return;
	}
	if (request.method === "GET" && url.pathname === "/fate/live") {
		const afterSequence = afterSequenceOf(url);
		if (afterSequence === undefined) {
			response.statusCode = 400;
			response.end("afterSequence must be a non-negative safe integer");
			return;
		}
		const liveSession = yield* LiveSession;
		response.statusCode = 200;
		response.setHeader("content-type", "text/event-stream; charset=utf-8");
		response.setHeader("cache-control", "no-cache");
		response.setHeader("connection", "keep-alive");
		response.flushHeaders();
		yield* liveSession
			.events(afterSequence)
			.pipe(Stream.runForEach((event) => Effect.sync(() => response.write(sseFrame(event)))));
		return;
	}
	if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(yield* fs.readFile(staticAsset));
		return;
	}
	response.statusCode = 404;
	response.end("Not found");
});

export const startTuval = Effect.fn("TuvalServer.start")(function* (
	options: StartTuvalOptions = {},
) {
	const fs = yield* FileSystem.FileSystem;
	const liveSession =
		options.liveSession ??
		(options.liveSessionTransport === undefined
			? makeUnavailableLiveSession()
			: yield* PiLiveSession.connect(options.liveSessionTransport).pipe(
					Effect.mapError(
						(error) =>
							new StartupFailure({
								message: "Tuval could not connect to the pi live protocol",
								cause: error.cause,
							}),
					),
				));
	yield* Effect.addFinalizer(() => liveSession.dispose().pipe(Effect.ignore));

	const serviceLayers = Layer.merge(
		PiDiscoveryLive(options),
		Layer.succeed(LiveSession, liveSession),
	);
	const fateLayer = TuvalFateServerLive.pipe(Layer.provide(serviceLayers));
	const appContext = yield* Layer.build(
		Layer.merge(fateLayer, Layer.succeed(LiveSession, liveSession)),
	);
	const staticAsset =
		options.staticAsset ?? fileURLToPath(new URL("../frontend-shell/index.html", import.meta.url));
	let origin = `http://${TUVAL_HOST}`;
	type RequestJob = {readonly request: IncomingMessage; readonly response: ServerResponse};
	const requests = yield* Queue.unbounded<RequestJob>();
	const requestSupervisor = yield* Effect.forkScoped(
		Effect.forever(
			Queue.take(requests).pipe(
				Effect.flatMap(({request, response}) =>
					Effect.forkChild(
						Effect.raceFirst(
							handleRequest(request, response, origin, staticAsset, fs).pipe(
								Effect.catch((error) => Effect.sync(() => writeFailure(response, error))),
								Effect.provideContext(appContext),
							),
							responseClosed(response),
						).pipe(
							Effect.ensuring(
								Effect.sync(() => {
									if (!response.writableEnded) response.end();
								}),
							),
						),
					),
				),
			),
		),
	);
	const server = createServer((request, response) => {
		Queue.offerUnsafe(requests, {request, response});
	});
	const port = options.port ?? 0;
	yield* Effect.callback<void, StartupFailure>((resume) => {
		const onError = (cause: Error) => {
			server.off("listening", onListening);
			resume(
				Effect.fail(
					new StartupFailure({
						message: `Tuval could not bind ${TUVAL_HOST}:${port}. Check whether the port is already in use.`,
						cause,
					}),
				),
			);
		};
		const onListening = () => {
			server.off("error", onError);
			resume(Effect.void);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, TUVAL_HOST);
	});

	let closed = false;
	const close = Effect.fn("TuvalServer.close")(() =>
		Effect.suspend(() => {
			if (closed) return Effect.void;
			closed = true;
			return Effect.gen(function* () {
				yield* Fiber.interrupt(requestSupervisor);
				yield* Queue.shutdown(requests);
				yield* closeServer(server);
			});
		}),
	);
	yield* Effect.addFinalizer(() => close().pipe(Effect.ignore));

	const address = server.address();
	if (address === null || typeof address === "string") {
		return yield* new StartupFailure({message: "Tuval bound without a TCP address"});
	}
	origin = `http://${TUVAL_HOST}:${address.port}`;
	options.log?.(`Tuval ready at ${origin}`);
	yield* (options.openBrowser ?? defaultOpenBrowser)(origin).pipe(
		Effect.catch((error) =>
			Effect.sync(() =>
				options.log?.(
					`Tuval is ready, but the browser could not be opened: ${
						error instanceof Error ? error.message : String(error)
					}`,
				),
			),
		),
	);
	return {
		host: TUVAL_HOST,
		port: address.port,
		url: origin,
		pid: process.pid,
		close,
	} satisfies RunningTuval;
});
