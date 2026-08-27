import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";
import {fileURLToPath} from "node:url";
import {createFateServer} from "@nkzw/fate/server";
import type {DiscoveryOutcome} from "../shared/wire.ts";
import {type Discover, handlePiProtocol} from "./pi-protocol.ts";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface TuvalServer {
	readonly url: URL;
	readonly address: AddressInfo;
	readonly close: () => Promise<void>;
}

export interface StartServerOptions {
	readonly port?: number;
	readonly discover: Discover;
	readonly assetPath?: string;
	readonly onReady?: (url: URL) => void | Promise<void>;
	readonly openBrowser?: (url: URL) => void | Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<Uint8Array> => {
	const chunks: Array<Buffer> = [];
	let total = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.byteLength;
		if (total > MAX_REQUEST_BYTES) throw new Error("request body exceeds 1 MiB");
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
};

const sendWebResponse = async (source: Response, target: ServerResponse): Promise<void> => {
	target.statusCode = source.status;
	for (const [name, value] of source.headers) target.setHeader(name, value);
	target.end(Buffer.from(await source.arrayBuffer()));
};

const toWebRequest = async (request: IncomingMessage, url: URL): Promise<Request> => {
	const method = request.method ?? "GET";
	const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	return new Request(url, {
		method,
		headers,
		...(body === undefined ? {} : {body}),
	});
};

const makeFateServer = (discover: Discover) =>
	createFateServer({
		roots: {},
		queries: {
			discoverSessions: {
				type: "TuvalDiscoveryOutcome",
				resolve: discover,
			},
		},
		sources: {
			registry: new Map(),
			getSource: () => {
				throw new Error("Tuval discovery has no fate entity sources");
			},
		},
	});

const writeError = (response: ServerResponse, error: unknown): void => {
	response.statusCode = 500;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(
		JSON.stringify({
			kind: "fatal" satisfies DiscoveryOutcome["kind"],
			message: error instanceof Error ? error.message : String(error),
		}),
	);
};

const listen = (server: Server, port: number): Promise<AddressInfo> =>
	new Promise((resolveListen, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("server did not report a TCP address"));
				return;
			}
			resolveListen(address);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({host: LOOPBACK_HOST, port});
	});

export const closeServer = (server: Server): Promise<void> =>
	new Promise((resolveClose, reject) => {
		server.close((error) => (error === undefined ? resolveClose() : reject(error)));
	});

export const defaultOpenBrowser = (url: URL): Promise<void> => {
	const command =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url.href] : [url.href];
	return new Promise((resolveOpen, reject) => {
		const child = spawn(command, args, {detached: true, stdio: "ignore"});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolveOpen();
		});
	});
};

export const startTuvalServer = async (options: StartServerOptions): Promise<TuvalServer> => {
	const assetPath =
		options.assetPath ?? fileURLToPath(new URL("../frontend-shell/index.html", import.meta.url));
	const fate = makeFateServer(options.discover);
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
			if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
				response.statusCode = 200;
				response.setHeader("content-type", "text/html; charset=utf-8");
				response.end(await readFile(assetPath));
				return;
			}
			if (request.method === "POST" && url.pathname === "/pi") {
				const result = await handlePiProtocol([await readBody(request)], options.discover);
				response.statusCode = 200;
				response.setHeader("content-type", "application/cbor");
				response.end(result);
				return;
			}
			if (url.pathname === "/fate") {
				await sendWebResponse(await fate.handleRequest(await toWebRequest(request, url)), response);
				return;
			}
			response.statusCode = 404;
			response.end("Not found");
		} catch (error) {
			writeError(response, error);
		}
	});

	let address: AddressInfo;
	try {
		address = await listen(server, options.port ?? 0);
	} catch (error) {
		throw new Error(
			`Tuval could not bind ${LOOPBACK_HOST}:${options.port ?? 0}: ${error instanceof Error ? error.message : String(error)}`,
			{cause: error},
		);
	}
	const url = new URL(`http://${LOOPBACK_HOST}:${address.port}/`);
	try {
		await options.onReady?.(url);
		await options.openBrowser?.(url);
	} catch (error) {
		await closeServer(server);
		throw new Error(
			`Tuval became ready at ${url.href} but browser launch failed: ${error instanceof Error ? error.message : String(error)}`,
			{cause: error},
		);
	}
	return {url, address, close: () => closeServer(server)};
};
