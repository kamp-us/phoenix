import {type ChildProcess, spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {promises as fs} from "node:fs";
import type {IncomingMessage, ServerResponse} from "node:http";
import {tmpdir} from "node:os";
import {dirname, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import type {Plugin} from "vite";

const PI_ROUTE = "/__pi";
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_PROJECT_FILES = 6_000;
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sessionDirectory = resolve(tmpdir(), "phoenix-pi-atolye-sessions");
const ignoredDirectories = new Set([
	".alchemy",
	".fate",
	".git",
	".pi",
	".turbo",
	".wrangler",
	"coverage",
	"dist",
	"node_modules",
]);

type JsonRecord = Record<string, unknown>;
type ProjectTrust = "approve" | "no-approve";

interface PiResponse extends JsonRecord {
	readonly type: "response";
	readonly success: boolean;
}

interface PendingRequest {
	readonly resolve: (response: PiResponse) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function projectTrustValue(value: unknown): ProjectTrust | undefined {
	return value === "approve" || value === "no-approve" ? value : undefined;
}

function respondJson(response: ServerResponse, status: number, body: JsonRecord): void {
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.setHeader("Cache-Control", "no-store");
	response.end(JSON.stringify(body));
}

function respondError(response: ServerResponse, status: number, message: string): void {
	respondJson(response, status, {error: message});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Pi harness request failed.";
}

function isLocalRequest(request: IncomingMessage): boolean {
	const host = request.headers.host ?? "";
	return (
		host === "localhost" ||
		host.startsWith("localhost:") ||
		host === "127.0.0.1" ||
		host.startsWith("127.0.0.1:") ||
		host === "[::1]" ||
		host.startsWith("[::1]:")
	);
}

async function readJson(request: IncomingMessage): Promise<JsonRecord> {
	let body = "";
	for await (const chunk of request) {
		body += String(chunk);
		if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
			throw new Error("Pi harness request is too large.");
		}
	}
	const parsed: unknown = body.length > 0 ? JSON.parse(body) : {};
	if (!isRecord(parsed)) throw new Error("Pi harness request must be a JSON object.");
	return parsed;
}

class PiRpcHarness {
	private child: ChildProcess | undefined;
	private starting: Promise<void> | undefined;
	private stdout = "";
	private readonly pending = new Map<string, PendingRequest>();
	private readonly subscribers = new Set<ServerResponse>();
	private files: readonly string[] | undefined;
	private lastError: string | undefined;
	private projectTrust: ProjectTrust = "approve";

	async call(command: JsonRecord): Promise<PiResponse> {
		await this.ensureStarted();
		const stdin = this.child?.stdin;
		if (!stdin?.writable) throw new Error("Pi harness is not available.");

		const id = randomUUID();
		return new Promise<PiResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Pi harness did not answer in time."));
			}, 30_000);
			this.pending.set(id, {resolve, reject, timeout});
			stdin.write(`${JSON.stringify({...command, id})}\n`, (error) => {
				if (!error) return;
				const request = this.pending.get(id);
				if (!request) return;
				clearTimeout(request.timeout);
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	async answerExtension(request: JsonRecord): Promise<void> {
		await this.ensureStarted();
		const stdin = this.child?.stdin;
		if (!stdin?.writable) throw new Error("Pi harness is not available.");
		await new Promise<void>((resolve, reject) => {
			stdin.write(`${JSON.stringify(request)}\n`, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	subscribe(response: ServerResponse): void {
		response.writeHead(200, {
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"Content-Type": "text/event-stream; charset=utf-8",
		});
		response.write(`data: ${JSON.stringify({type: "harness_status", status: this.status()})}\n\n`);
		this.subscribers.add(response);
		response.on("close", () => this.subscribers.delete(response));
	}

	status(): JsonRecord {
		return {
			available: this.child?.exitCode === null,
			projectTrust: this.projectTrust,
			...(this.lastError ? {message: this.lastError} : {}),
		};
	}

	projectTrustMode(): ProjectTrust {
		return this.projectTrust;
	}

	async setProjectTrust(projectTrust: ProjectTrust): Promise<void> {
		if (projectTrust === this.projectTrust) return;
		const state = unwrap(await this.call({type: "get_state"}));
		if (isRecord(state) && state.isStreaming === true) {
			throw new Error("Pi çalışırken proje izni değiştirilemez.");
		}
		this.projectTrust = projectTrust;
		this.stop();
		await this.ensureStarted();
	}

	invalidateFiles(): void {
		this.files = undefined;
	}

	async findFiles(query: string): Promise<readonly string[]> {
		const files = await this.projectFiles();
		return files
			.map((path) => ({path, score: fuzzyScore(path, query)}))
			.filter((entry): entry is {path: string; score: number} => entry.score !== undefined)
			.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
			.slice(0, 8)
			.map((entry) => entry.path);
	}

	stop(): void {
		const child = this.child;
		this.child = undefined;
		if (child?.exitCode === null) child.kill();
		this.rejectPending("Pi harness stopped.");
	}

	private async ensureStarted(): Promise<void> {
		if (this.child?.exitCode === null) return;
		if (this.starting) return this.starting;

		this.starting = this.start();
		try {
			await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	private async start(): Promise<void> {
		await fs.mkdir(sessionDirectory, {recursive: true});
		this.lastError = undefined;
		this.emit({type: "harness_status", status: {available: false, state: "starting"}});

		const binary = process.env.PI_HARNESS_BIN ?? "pi";
		const child = spawn(
			binary,
			[
				"--mode",
				"rpc",
				this.projectTrust === "approve" ? "--approve" : "--no-approve",
				"--session-dir",
				sessionDirectory,
				"--name",
				"atolye",
			],
			{
				cwd: workspaceRoot,
				env: {
					...process.env,
					PI_OFFLINE: "1",
					PI_SKIP_VERSION_CHECK: "1",
				},
				stdio: "pipe",
			},
		);
		this.child = child;
		child.stdout?.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			const message = chunk.toString("utf8").trim();
			if (message.length > 0) this.lastError = message;
		});
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.lastError = `Pi process ended (${signal ?? code ?? "unknown"}).`;
			this.rejectPending(this.lastError);
			this.emit({type: "harness_status", status: this.status()});
		});

		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
	}

	private consumeStdout(chunk: Buffer): void {
		this.stdout += chunk.toString("utf8");
		const lines = this.stdout.split("\n");
		this.stdout = lines.pop() ?? "";
		for (const line of lines) {
			const record = this.parseLine(line);
			if (!record) continue;
			const type = stringValue(record, "type");
			const id = stringValue(record, "id");
			if (type === "response" && id) {
				const request = this.pending.get(id);
				if (!request) continue;
				clearTimeout(request.timeout);
				this.pending.delete(id);
				request.resolve(record as PiResponse);
				continue;
			}
			if (type === "agent_settled") this.invalidateFiles();
			this.emit(record);
		}
	}

	private parseLine(line: string): JsonRecord | undefined {
		if (line.length === 0) return undefined;
		try {
			const parsed: unknown = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
			return isRecord(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	private emit(event: JsonRecord): void {
		const frame = `data: ${JSON.stringify(event)}\n\n`;
		for (const response of this.subscribers) {
			if (response.writableEnded) {
				this.subscribers.delete(response);
				continue;
			}
			response.write(frame);
		}
	}

	private rejectPending(message: string): void {
		for (const [id, request] of this.pending) {
			clearTimeout(request.timeout);
			request.reject(new Error(message));
			this.pending.delete(id);
		}
	}

	private async projectFiles(): Promise<readonly string[]> {
		if (this.files) return this.files;
		const files: string[] = [];
		await collectProjectFiles(workspaceRoot, files);
		this.files = files.sort((a, b) => a.localeCompare(b));
		return this.files;
	}
}

async function collectProjectFiles(directory: string, files: string[]): Promise<void> {
	if (files.length >= MAX_PROJECT_FILES) return;
	try {
		const entries = await fs.readdir(directory, {encoding: "utf8", withFileTypes: true});
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (files.length >= MAX_PROJECT_FILES) return;
			if (entry.isSymbolicLink()) continue;
			const fullPath = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				if (!ignoredDirectories.has(entry.name)) await collectProjectFiles(fullPath, files);
				continue;
			}
			if (entry.isFile()) files.push(relative(workspaceRoot, fullPath));
		}
	} catch {
		return;
	}
}

function fuzzyScore(path: string, query: string): number | undefined {
	const needle = query.toLocaleLowerCase();
	if (needle.length === 0) return path.length;
	const haystack = path.toLocaleLowerCase();
	let cursor = 0;
	let score = 0;
	for (const character of needle) {
		const index = haystack.indexOf(character, cursor);
		if (index === -1) return undefined;
		score += index - cursor;
		cursor = index + 1;
	}
	return score + path.length / 10;
}

function unwrap(response: PiResponse): unknown {
	if (response.success) return response.data;
	throw new Error(stringValue(response, "error") ?? "Pi harness rejected the request.");
}

function requestPath(url: string | undefined): string {
	const pathname = new URL(url ?? "/", "http://localhost").pathname;
	return pathname.startsWith(PI_ROUTE) ? pathname.slice(PI_ROUTE.length) || "/" : pathname;
}

async function handlePiRequest(
	harness: PiRpcHarness,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	if (!isLocalRequest(request)) {
		respondError(response, 403, "Pi harness is available only from localhost.");
		return;
	}

	const url = new URL(request.url ?? "/", "http://localhost");
	const path = requestPath(request.url);
	try {
		if (request.method === "GET" && path === "/events") {
			harness.subscribe(response);
			return;
		}
		if (request.method === "GET" && path === "/state") {
			const data = unwrap(await harness.call({type: "get_state"}));
			respondJson(response, 200, {state: data, projectTrust: harness.projectTrustMode()});
			return;
		}
		if (request.method === "GET" && path === "/models") {
			const data = unwrap(await harness.call({type: "get_available_models"}));
			respondJson(response, 200, {models: data});
			return;
		}
		if (request.method === "GET" && path === "/thinking-levels") {
			const data = unwrap(await harness.call({type: "get_available_thinking_levels"}));
			respondJson(response, 200, {levels: data});
			return;
		}
		if (request.method === "GET" && path === "/commands") {
			const data = unwrap(await harness.call({type: "get_commands"}));
			respondJson(response, 200, {commands: data});
			return;
		}
		if (request.method === "GET" && path === "/files") {
			const query = url.searchParams.get("q") ?? "";
			respondJson(response, 200, {files: await harness.findFiles(query)});
			return;
		}
		if (request.method === "POST" && path === "/model") {
			const body = await readJson(request);
			const provider = stringValue(body, "provider");
			const modelId = stringValue(body, "modelId");
			if (!provider || !modelId) {
				respondError(response, 400, "Pi model selection needs a provider and model id.");
				return;
			}
			const data = unwrap(await harness.call({type: "set_model", provider, modelId}));
			respondJson(response, 200, {model: data});
			return;
		}
		if (request.method === "POST" && path === "/thinking-level") {
			const body = await readJson(request);
			const level = stringValue(body, "level");
			if (!level) {
				respondError(response, 400, "Pi thinking selection needs a level.");
				return;
			}
			unwrap(await harness.call({type: "set_thinking_level", level}));
			respondJson(response, 200, {thinkingLevel: level});
			return;
		}
		if (request.method === "POST" && path === "/project-trust") {
			const body = await readJson(request);
			const projectTrust = projectTrustValue(body.projectTrust);
			if (!projectTrust) {
				respondError(response, 400, "Unknown Pi project trust mode.");
				return;
			}
			await harness.setProjectTrust(projectTrust);
			respondJson(response, 200, {projectTrust});
			return;
		}
		if (request.method === "POST" && path === "/prompt") {
			const body = await readJson(request);
			const type = stringValue(body, "type");
			const message = stringValue(body, "message");
			if (type !== "prompt" && type !== "steer" && type !== "follow_up") {
				respondError(response, 400, "Unknown Pi delivery mode.");
				return;
			}
			if (!message) {
				respondError(response, 400, "Pi needs a message.");
				return;
			}
			const streamingBehavior = stringValue(body, "streamingBehavior");
			if (
				streamingBehavior !== undefined &&
				streamingBehavior !== "steer" &&
				streamingBehavior !== "followUp"
			) {
				respondError(response, 400, "Unknown Pi streaming behavior.");
				return;
			}
			const images = Array.isArray(body.images) ? body.images.filter(isImagePayload) : [];
			const data = unwrap(
				await harness.call({
					type,
					message,
					...(images.length > 0 ? {images} : {}),
					...(streamingBehavior ? {streamingBehavior} : {}),
				}),
			);
			respondJson(response, 200, {accepted: data});
			return;
		}
		if (request.method === "POST" && path === "/abort") {
			unwrap(await harness.call({type: "abort"}));
			respondJson(response, 200, {aborted: true});
			return;
		}
		if (request.method === "POST" && path === "/extension-response") {
			const body = await readJson(request);
			const id = stringValue(body, "id");
			if (!id) {
				respondError(response, 400, "Extension responses need an id.");
				return;
			}
			const extensionResponse: JsonRecord = {type: "extension_ui_response", id};
			if (typeof body.value === "string") extensionResponse.value = body.value;
			if (typeof body.confirmed === "boolean") extensionResponse.confirmed = body.confirmed;
			if (body.cancelled === true) extensionResponse.cancelled = true;
			await harness.answerExtension(extensionResponse);
			respondJson(response, 200, {accepted: true});
			return;
		}
		respondError(response, 404, "Unknown Pi harness endpoint.");
	} catch (error) {
		respondError(response, 503, errorMessage(error));
	}
}

function isImagePayload(value: unknown): value is JsonRecord {
	if (!isRecord(value)) return false;
	return typeof value.data === "string" && typeof value.mimeType === "string";
}

export function piHarness(): Plugin {
	const harness = new PiRpcHarness();
	return {
		name: "phoenix-pi-harness",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				if (!(request.url ?? "").startsWith(PI_ROUTE)) return next();
				void handlePiRequest(harness, request, response);
			});
			server.httpServer?.once("close", () => harness.stop());
		},
	};
}
