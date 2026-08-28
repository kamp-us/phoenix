import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";
import {fileURLToPath} from "node:url";
import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {Effect, ManagedRuntime} from "effect";
import {makeFateServer} from "./fate.js";
import {
	type LiveSessionService,
	makeUnavailableLiveSession,
	PiLiveSession,
} from "./live-session.js";
import {PiDiscovery, PiDiscoveryLive, type PiDiscoveryOptions} from "./pi-discovery.js";

export const TUVAL_HOST = "127.0.0.1";

export class StartupFailure extends Error {
	override readonly name = "StartupFailure";
	override readonly cause: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.cause = cause;
	}
}

export interface StartTuvalOptions extends PiDiscoveryOptions {
	readonly port?: number;
	readonly openBrowser?: (url: string) => Promise<void>;
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
	readonly close: () => Promise<void>;
}

const bodyOf = async (request: IncomingMessage): Promise<Uint8Array | undefined> => {
	if (request.method === "GET" || request.method === "HEAD") return undefined;
	const chunks: Array<Buffer> = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
};

const toWebRequest = async (request: IncomingMessage, origin: string): Promise<Request> => {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	const body = await bodyOf(request);
	return new Request(new URL(request.url ?? "/", origin), {
		method: request.method ?? "GET",
		headers,
		...(body === undefined ? {} : {body}),
	});
};

const writeWebResponse = async (response: Response, target: ServerResponse): Promise<void> => {
	target.statusCode = response.status;
	response.headers.forEach((value, name) => {
		target.setHeader(name, value);
	});
	target.end(Buffer.from(await response.arrayBuffer()));
};

const defaultOpenBrowser = async (url: string): Promise<void> => {
	const command =
		process.platform === "darwin"
			? {file: "open", args: [url]}
			: process.platform === "win32"
				? {file: "cmd", args: ["/c", "start", "", url]}
				: {file: "xdg-open", args: [url]};
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command.file, command.args, {detached: true, stdio: "ignore"});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
};

const closeServer = (server: Server): Promise<void> =>
	new Promise((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});

export const startTuval = async (options: StartTuvalOptions = {}): Promise<RunningTuval> => {
	const runtime = ManagedRuntime.make(PiDiscoveryLive(options));
	const liveSession =
		options.liveSession ??
		(options.liveSessionTransport === undefined
			? makeUnavailableLiveSession()
			: await PiLiveSession.connect(options.liveSessionTransport));
	const fateServer = makeFateServer(
		() => runtime.runPromise(Effect.flatMap(PiDiscovery, (service) => service.discover)),
		liveSession,
	);
	const staticAsset =
		options.staticAsset ?? fileURLToPath(new URL("../frontend-shell/index.html", import.meta.url));
	let origin = `http://${TUVAL_HOST}`;
	const server = createServer(async (request, response) => {
		// biome-ignore lint/plugin: The Node HTTP callback must turn boundary failures into an HTTP response.
		try {
			const url = new URL(request.url ?? "/", origin);
			if (request.method === "GET" && url.pathname === "/health") {
				response.setHeader("content-type", "application/json; charset=utf-8");
				response.end(JSON.stringify({status: "ready", url: origin, pid: process.pid}));
				return;
			}
			if (request.method === "POST" && url.pathname === "/fate") {
				const webRequest = await toWebRequest(request, origin);
				const webResponse = await fateServer.handleRequest(webRequest);
				await writeWebResponse(webResponse, response);
				return;
			}
			if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
				response.setHeader("content-type", "text/html; charset=utf-8");
				response.end(await readFile(staticAsset));
				return;
			}
			response.statusCode = 404;
			response.end("Not found");
		} catch (error) {
			response.statusCode = 500;
			response.setHeader("content-type", "application/json; charset=utf-8");
			response.end(
				JSON.stringify({
					error: error instanceof Error ? error.message : "Unknown Tuval server failure",
				}),
			);
		}
	});
	// biome-ignore lint/plugin: Binding occurs before the Effect runtime is handed to the caller and needs an actionable StartupFailure.
	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server.once("error", onError);
			server.listen(options.port ?? 0, TUVAL_HOST, () => {
				server.off("error", onError);
				resolve();
			});
		});
	} catch (error) {
		await liveSession.dispose();
		await runtime.dispose();
		throw new StartupFailure(
			`Tuval could not bind ${TUVAL_HOST}:${options.port ?? 0}. Check whether the port is already in use.`,
			error,
		);
	}
	const address = server.address() as AddressInfo;
	origin = `http://${TUVAL_HOST}:${address.port}`;
	options.log?.(`Tuval ready at ${origin}`);
	// biome-ignore lint/plugin: Browser launch is deliberately best-effort after the server is already ready.
	try {
		await (options.openBrowser ?? defaultOpenBrowser)(origin);
	} catch (error) {
		options.log?.(
			`Tuval is ready, but the browser could not be opened: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let closed = false;
	return {
		host: TUVAL_HOST,
		port: address.port,
		url: origin,
		pid: process.pid,
		close: async () => {
			if (closed) return;
			closed = true;
			await closeServer(server);
			await liveSession.dispose();
			await runtime.dispose();
		},
	};
};
