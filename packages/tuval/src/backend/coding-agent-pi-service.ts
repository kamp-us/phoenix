import {randomUUID} from "node:crypto";
import {stat} from "node:fs/promises";
import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	ClientMessageDecoder,
	type Command,
	encodeServerMessage,
	type JsonValue,
	type ModelMetadata,
	PROTOCOL_VERSION,
	type ServerMessage,
	type SessionPhase,
	type SessionSnapshot,
	type ThinkingLevel,
	type TranscriptItem,
	type TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type {LoadOlderTranscriptOutcome, TranscriptArchiveState} from "../shared/live-session.js";
import {makeCodingAgentSessionIndex} from "./coding-agent-session-index.js";
import {
	type RuntimeLifecycle,
	type RuntimeLifecycleSource,
	RuntimeOwnership,
} from "./runtime-lifecycle.js";
import {
	archiveEntryOf,
	archiveStateBefore,
	decodeArchiveCursor,
	encodeArchiveCursor,
} from "./transcript-archive.js";

interface CodingAgentPiServiceOptions {
	readonly agentDir?: string;
	readonly cwd?: string;
	readonly sessionRoots?: ReadonlyArray<string>;
	readonly settingsManager?: SettingsManager;
	readonly modelRuntime?: ModelRuntime;
	readonly operationTimeoutMs?: number;
	readonly createAgentSession?: typeof createAgentSession;
}

type CodingMessage = AgentSession["messages"][number];
type CodingModel = ReturnType<ModelRuntime["getModels"]>[number];
type UserTranscriptContent = Extract<TranscriptItem, {role: "user"}>["content"];
type AssistantTranscriptContent = Extract<TranscriptItem, {role: "assistant"}>["content"];
type ToolTranscriptContent = Extract<TranscriptItem, {role: "tool"}>["content"];

interface SessionRuntime {
	readonly session: AgentSession;
	readonly createdAt: number;
	readonly unsubscribe: () => void;
	publishedTranscript: Array<TranscriptItem>;
	revision: number;
}

interface PendingConstruction {
	readonly lifecycle: RuntimeLifecycle;
	readonly manager: SessionManager;
	readonly snapshot: SessionSnapshot;
	active: boolean;
}

export interface TranscriptArchiveSource {
	archiveState: (
		sessionId: string,
		transcript: ReadonlyArray<TranscriptItem>,
	) => TranscriptArchiveState;
	loadOlder: (cursor: string) => Promise<LoadOlderTranscriptOutcome>;
}

export type CodingAgentPiTransport = ByteTransportFactory &
	TranscriptArchiveSource &
	RuntimeLifecycleSource;

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
export const TRANSCRIPT_WINDOW_LIMIT = 40;
export const TRANSCRIPT_WINDOW_BYTE_LIMIT = 256_000;
const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const plainJson = (value: unknown): value is JsonValue => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(plainJson);
	if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	return Object.values(value).every(plainJson);
};

const usageOf = (usage: {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning?: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}) => ({
	input: usage.input,
	output: usage.output,
	cacheRead: usage.cacheRead,
	cacheWrite: usage.cacheWrite,
	...(usage.reasoning === undefined ? {} : {reasoning: usage.reasoning}),
	totalTokens: usage.totalTokens,
	cost: {...usage.cost},
});

const userContentOf = (
	content: string | ReadonlyArray<unknown>,
): UserTranscriptContent | ToolTranscriptContent => {
	if (typeof content === "string") return [{type: "text", text: content}];
	const projected: UserTranscriptContent = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const candidate = part as Record<string, unknown>;
		if (candidate.type === "text" && typeof candidate.text === "string") {
			projected.push({type: "text", text: candidate.text});
		} else if (
			candidate.type === "image" &&
			typeof candidate.data === "string" &&
			typeof candidate.mimeType === "string"
		) {
			projected.push({type: "image", data: candidate.data, mimeType: candidate.mimeType});
		}
	}
	return projected;
};

const assistantContentOf = (content: ReadonlyArray<unknown>): AssistantTranscriptContent => {
	const projected: AssistantTranscriptContent = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const candidate = part as Record<string, unknown>;
		if (candidate.type === "text" && typeof candidate.text === "string") {
			projected.push({type: "text", text: candidate.text});
		} else if (candidate.type === "thinking" && typeof candidate.thinking === "string") {
			projected.push({
				type: "thinking",
				thinking: candidate.thinking,
				...(candidate.redacted === true ? {redacted: true} : {}),
			});
		} else if (
			candidate.type === "toolCall" &&
			typeof candidate.id === "string" &&
			typeof candidate.name === "string" &&
			plainJson(candidate.arguments)
		) {
			projected.push({
				type: "toolCall",
				toolCallId: candidate.id,
				toolName: candidate.name,
				input: candidate.arguments,
			});
		}
	}
	return projected;
};

const toolInputOf = (
	messages: ReadonlyArray<CodingMessage>,
	index: number,
	toolCallId: string,
): {readonly input: JsonValue} => {
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const candidate = messages[cursor];
		if (candidate?.role !== "assistant") continue;
		for (const part of candidate.content) {
			if (part.type === "toolCall" && part.id === toolCallId && plainJson(part.arguments)) {
				return {input: part.arguments};
			}
		}
	}
	return {input: {}};
};

const transcriptOfMessages = (
	sessionId: string,
	messages: ReadonlyArray<CodingMessage>,
): Array<TranscriptItem> =>
	messages.flatMap((message, index): Array<TranscriptItem> => {
		const id = `${sessionId}:${index}`;
		if (message.role === "user") {
			return [
				{
					id,
					role: "user",
					content: userContentOf(message.content) as UserTranscriptContent,
					timestamp: message.timestamp,
				},
			];
		}
		if (message.role === "assistant") {
			const common = {
				id,
				role: "assistant" as const,
				content: assistantContentOf(message.content),
				model: {provider: message.provider, id: message.model},
				...(message.responseModel === undefined ? {} : {responseModel: message.responseModel}),
				usage: usageOf(message.usage),
				timestamp: message.timestamp,
			};
			if (message.stopReason === "error") {
				return [
					{
						...common,
						status: "error",
						stopReason: "error",
						...(message.errorMessage === undefined ? {} : {errorMessage: message.errorMessage}),
					},
				];
			}
			if (message.stopReason === "aborted") {
				return [
					{
						...common,
						status: "aborted",
						stopReason: "aborted",
						...(message.errorMessage === undefined ? {} : {errorMessage: message.errorMessage}),
					},
				];
			}
			if (
				message.stopReason === "stop" ||
				message.stopReason === "length" ||
				message.stopReason === "toolUse"
			) {
				return [{...common, status: "complete", stopReason: message.stopReason}];
			}
			return [{...common, status: "streaming"}];
		}
		if (message.role === "toolResult") {
			const {input} = toolInputOf(messages, index, message.toolCallId);
			const common = {
				id,
				role: "tool" as const,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				input: plainJson(input) ? input : {},
				content: userContentOf(message.content) as ToolTranscriptContent,
				...(plainJson(message.details) ? {details: message.details} : {}),
				...(message.usage === undefined ? {} : {usage: usageOf(message.usage)}),
				timestamp: message.timestamp,
			};
			return message.isError
				? [{...common, status: "error", isError: true}]
				: [{...common, status: "complete", isError: false}];
		}
		return [];
	});

const transcriptOf = (session: AgentSession): Array<TranscriptItem> =>
	transcriptOfMessages(session.sessionId, session.messages);

const toolCallIds = (item: TranscriptItem): ReadonlyArray<string> =>
	item.role === "assistant"
		? item.content.flatMap((part) => (part.type === "toolCall" ? [part.toolCallId] : []))
		: [];

const pairedWindowStart = (
	transcript: ReadonlyArray<TranscriptItem>,
	candidateStart: number,
): number => {
	let start = Math.max(0, candidateStart);
	while (transcript[start]?.role === "tool") {
		const tool = transcript[start];
		if (tool?.role !== "tool") break;
		const call = transcript.findLastIndex(
			(item, index) => index < start && toolCallIds(item).includes(tool.toolCallId),
		);
		if (call < 0) break;
		start = call;
	}
	return start;
};

const boundedWindowStart = (transcript: ReadonlyArray<TranscriptItem>, before: number): number => {
	let start = before;
	let bytes = 0;
	while (start > 0 && before - start < TRANSCRIPT_WINDOW_LIMIT) {
		const nextBytes = Buffer.byteLength(JSON.stringify(transcript[start - 1]), "utf8");
		if (start < before && bytes + nextBytes > TRANSCRIPT_WINDOW_BYTE_LIMIT) break;
		bytes += nextBytes;
		start -= 1;
	}
	return pairedWindowStart(transcript, start);
};

const recentTranscriptOf = (transcript: ReadonlyArray<TranscriptItem>): Array<TranscriptItem> =>
	transcript.slice(boundedWindowStart(transcript, transcript.length));

const phaseOf = (session: AgentSession): SessionPhase => {
	if (session.isCompacting) return "compaction";
	if (session.isRetrying) return "retry";
	if (session.isStreaming) return "turn";
	return "idle";
};

const snapshotOf = (runtime: SessionRuntime): SessionSnapshot => {
	const {session} = runtime;
	const model = session.model;
	if (model === undefined) throw new Error(`Session ${session.sessionId} has no selected model`);
	const transcript = transcriptOf(session);
	return {
		id: session.sessionId,
		...(session.sessionName === undefined ? {} : {name: session.sessionName}),
		cwd: session.sessionManager.getCwd(),
		createdAt: runtime.createdAt,
		updatedAt: transcript.at(-1)?.timestamp ?? runtime.createdAt,
		phase: phaseOf(session),
		model: {provider: model.provider, id: model.id},
		thinkingLevel: session.thinkingLevel,
		attached: true,
		locked: true,
		revision: runtime.revision,
		transcript: recentTranscriptOf(transcript),
		queuedSteer: session.getSteeringMessages().map((text, index) => ({
			id: `${session.sessionId}:queued:${index}`,
			role: "user",
			content: [{type: "text", text}],
			timestamp: Date.now(),
		})),
		queuedSteerCount: session.pendingMessageCount,
	};
};

const provisionalSnapshotOf = (
	sessionId: string,
	manager: SessionManager,
	createdAt: number,
	settingsManager: SettingsManager,
): SessionSnapshot => {
	const saved = manager.buildSessionContext();
	const provider = saved.model?.provider ?? settingsManager.getDefaultProvider() ?? "unknown";
	const modelId = saved.model?.modelId ?? settingsManager.getDefaultModel() ?? "unknown";
	const thinkingLevel = THINKING_LEVELS.includes(saved.thinkingLevel as ThinkingLevel)
		? (saved.thinkingLevel as ThinkingLevel)
		: "off";
	const transcript = transcriptOfMessages(sessionId, saved.messages);
	const sessionName = manager.getSessionName();
	return {
		id: sessionId,
		...(sessionName === undefined ? {} : {name: sessionName}),
		cwd: manager.getCwd(),
		createdAt,
		updatedAt: transcript.at(-1)?.timestamp ?? createdAt,
		phase: "idle",
		model: {provider, id: modelId},
		thinkingLevel,
		attached: true,
		locked: true,
		revision: 1,
		transcript: recentTranscriptOf(transcript),
		queuedSteer: [],
		queuedSteerCount: 0,
	};
};

const supportedThinkingLevels = (model: CodingModel): Array<ThinkingLevel> => {
	if (!model.reasoning) return ["off"];
	const map = model.thinkingLevelMap;
	return THINKING_LEVELS.filter((level) => level === "off" || map?.[level] !== null);
};

const modelMetadataOf = (model: CodingModel, authenticated: boolean): ModelMetadata => ({
	provider: model.provider,
	id: model.id,
	name: model.name,
	api: model.api,
	reasoning: model.reasoning,
	input: [...model.input],
	contextWindow: model.contextWindow,
	maxTokens: model.maxTokens,
	cost: {
		input: Math.max(0, model.cost.input),
		output: Math.max(0, model.cost.output),
		cacheRead: Math.max(0, model.cost.cacheRead),
		cacheWrite: Math.max(0, model.cost.cacheWrite),
	},
	supportedThinkingLevels: supportedThinkingLevels(model),
	authenticated,
});

const withDeadline = async <A>(
	operation: Promise<A>,
	timeoutMs: number,
	label: string,
): Promise<A> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
		timer.unref();
	});
	try {
		return await Promise.race([operation, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

export const makeCodingAgentPiTransport = (
	options: CodingAgentPiServiceOptions = {},
): CodingAgentPiTransport => {
	const agentDir = options.agentDir ?? getAgentDir();
	const cwd = options.cwd ?? process.cwd();
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const roots = options.sessionRoots ?? [`${agentDir}/sessions`];
	const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
	const createCodingAgentSession = options.createAgentSession ?? createAgentSession;
	const runtimePromise =
		options.modelRuntime === undefined
			? ModelRuntime.create({
					authPath: `${agentDir}/auth.json`,
					modelsPath: `${agentDir}/models.json`,
					refreshOnCreate: false,
				})
			: Promise.resolve(options.modelRuntime);
	const runtimeOwnership = new RuntimeOwnership();
	let serverRevision = 0;

	const sessionIndex = makeCodingAgentSessionIndex(roots);

	const transport = ((handlers) => {
		const connectionId = randomUUID();
		const decoder = new ClientMessageDecoder();
		const attached = new Map<string, SessionRuntime>();
		const constructions = new Map<string, PendingConstruction>();
		const backgroundConstructions = new Set<Promise<void>>();
		let closed = false;
		let greeted = false;
		let serialized = Promise.resolve();

		const deliver = (message: ServerMessage): void => {
			if (!closed) handlers.onData(encodeServerMessage(message));
		};

		const publish = (runtime: SessionRuntime): void => {
			if (closed) return;
			runtime.revision += 1;
			runtime.publishedTranscript = recentTranscriptOf(transcriptOf(runtime.session));
			deliver({type: "event", event: {type: "session_snapshot", snapshot: snapshotOf(runtime)}});
		};

		const publishSessionEvent = (runtime: SessionRuntime, event: AgentSessionEvent): void => {
			if (closed) return;
			const transcriptEvent =
				event.type === "message_start" ||
				event.type === "message_update" ||
				event.type === "message_end" ||
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end";
			if (!transcriptEvent) {
				publish(runtime);
				return;
			}
			const previous = new Map(runtime.publishedTranscript.map((item) => [item.id, item]));
			const next = recentTranscriptOf(transcriptOf(runtime.session));
			runtime.publishedTranscript = next;
			for (const item of next) {
				const prior = previous.get(item.id);
				if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(item)) continue;
				const progress: TranscriptProgress =
					prior === undefined
						? {type: "item_started", item}
						: item.role !== "user" && item.status !== "streaming" && item.status !== "running"
							? {type: "item_finished", item}
							: item.role === "user"
								? {type: "item_started", item}
								: {type: "item_updated", item};
				deliver({
					type: "event",
					event: {type: "session_progress", sessionId: runtime.session.sessionId, progress},
				});
			}
		};

		const publishServerSnapshot = async (): Promise<void> => {
			const modelRuntime = await runtimePromise;
			const available = new Set(
				modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\u0000${model.id}`),
			);
			const sessions = (await sessionIndex.list()).map(({path: _path, ...metadata}) => metadata);
			deliver({
				type: "event",
				event: {
					type: "server_snapshot",
					snapshot: {
						serverId: "tuval-coding-agent",
						protocolVersion: PROTOCOL_VERSION,
						revision: ++serverRevision,
						sessions,
						models: modelRuntime
							.getModels()
							.filter(
								(model) =>
									available.has(`${model.provider}\u0000${model.id}`) ||
									modelRuntime.getRegisteredNativeProvider(model.provider) !== undefined,
							)
							.map((model) => modelMetadataOf(model, true)),
					},
				},
			});
		};

		const restoreConfiguredModel = async (
			session: AgentSession,
			manager: SessionManager,
			modelRuntime: ModelRuntime,
		): Promise<void> => {
			if (session.model?.provider !== "unknown") return;
			const saved = manager.buildSessionContext();
			const provider = saved.model?.provider ?? settingsManager.getDefaultProvider();
			const modelId = saved.model?.modelId ?? settingsManager.getDefaultModel();
			if (provider === undefined || modelId === undefined) return;
			const model = modelRuntime.getModel(provider, modelId);
			if (model === undefined) return;
			await session.setModel(model);
			if (THINKING_LEVELS.includes(saved.thinkingLevel as ThinkingLevel)) {
				session.setThinkingLevel(saved.thinkingLevel as ThinkingLevel);
			}
		};

		const disposeSession = async (session: AgentSession): Promise<void> => {
			if (!session.isIdle) await session.abort().catch(() => undefined);
			session.dispose();
		};

		const cancelConstruction = (sessionId: string): boolean => {
			const construction = constructions.get(sessionId);
			if (construction === undefined) return false;
			construction.active = false;
			constructions.delete(sessionId);
			runtimeOwnership.release(sessionId, connectionId);
			return true;
		};

		const disposeRuntime = async (sessionId: string): Promise<void> => {
			const cancelled = cancelConstruction(sessionId);
			const runtime = attached.get(sessionId);
			if (runtime === undefined) {
				if (!cancelled)
					throw Object.assign(new Error(`Session ${sessionId} is not attached`), {
						code: "session_locked",
					});
				return;
			}
			attached.delete(sessionId);
			runtimeOwnership.release(sessionId, connectionId);
			runtime.unsubscribe();
			await disposeSession(runtime.session);
		};

		const fail = (
			id: string,
			code:
				| "busy"
				| "session_locked"
				| "not_found"
				| "invalid_request"
				| "not_implemented"
				| "internal_error",
			message: string,
		): void => {
			deliver({type: "response", id, ok: false, error: {code, message}});
		};

		const beginAttach = async (
			sessionId: string,
			path: string,
		): Promise<{readonly snapshot: SessionSnapshot; readonly start: () => void}> => {
			const existing = attached.get(sessionId);
			if (existing !== undefined) {
				return {snapshot: snapshotOf(existing), start: () => undefined};
			}
			const pending = constructions.get(sessionId);
			if (pending !== undefined) {
				return {snapshot: pending.snapshot, start: () => undefined};
			}
			const owner = runtimeOwnership.ownerOf(sessionId);
			if (owner !== undefined && owner !== connectionId) {
				throw Object.assign(new Error(`Session ${sessionId} is attached by another client`), {
					code: "session_locked",
				});
			}
			const manager = SessionManager.open(path);
			const file = await stat(path);
			const createdAt = file.birthtimeMs > 0 ? Math.floor(file.birthtimeMs) : Date.now();
			const snapshot = provisionalSnapshotOf(sessionId, manager, createdAt, settingsManager);
			const construction: PendingConstruction = {
				lifecycle: runtimeOwnership.begin(sessionId, connectionId),
				manager,
				snapshot,
				active: true,
			};
			constructions.set(sessionId, construction);

			const start = (): void => {
				const background = (async () => {
					let creation: ReturnType<typeof createCodingAgentSession> | undefined;
					let preparation: ReturnType<typeof createCodingAgentSession> | undefined;
					try {
						const modelRuntime = await runtimePromise;
						creation = createCodingAgentSession({
							cwd: manager.getCwd(),
							agentDir,
							modelRuntime,
							settingsManager,
							sessionManager: manager,
						});
						preparation = creation.then(async (result) => {
							await restoreConfiguredModel(result.session, manager, modelRuntime);
							return result;
						});
						const {session} = await withDeadline(
							preparation,
							operationTimeoutMs,
							`Attaching session ${sessionId}`,
						);
						if (
							!construction.active ||
							closed ||
							constructions.get(sessionId) !== construction ||
							!runtimeOwnership.isLoading(construction.lifecycle, connectionId)
						) {
							await disposeSession(session);
							return;
						}
						let runtime: SessionRuntime;
						const unsubscribe = session.subscribe((event) => publishSessionEvent(runtime, event));
						runtime = {
							session,
							createdAt,
							unsubscribe,
							publishedTranscript: recentTranscriptOf(transcriptOf(session)),
							revision: snapshot.revision,
						};
						constructions.delete(sessionId);
						attached.set(sessionId, runtime);
						runtimeOwnership.ready(construction.lifecycle, connectionId);
						publish(runtime);
					} catch (error) {
						if (preparation !== undefined && creation !== undefined) {
							void preparation.then(
								({session}) => disposeSession(session),
								() =>
									void creation?.then(
										({session}) => disposeSession(session),
										() => undefined,
									),
							);
						}
						if (constructions.get(sessionId) !== construction || !construction.active) return;
						construction.active = false;
						runtimeOwnership.refuse(construction.lifecycle, connectionId, messageOf(error));
					}
				})();
				backgroundConstructions.add(background);
				void background.finally(() => backgroundConstructions.delete(background));
			};
			return {snapshot, start};
		};

		const createSession = async (command: Extract<Command, {command: "create"}>) => {
			const sessionCwd = command.cwd ?? cwd;
			const manager = SessionManager.create(sessionCwd);
			const modelRuntime = await runtimePromise;
			const creation = createCodingAgentSession({
				cwd: sessionCwd,
				agentDir,
				modelRuntime,
				settingsManager,
				sessionManager: manager,
			});
			try {
				const {session} = await withDeadline(
					creation,
					operationTimeoutMs,
					"Creating a coding-agent session",
				);
				await restoreConfiguredModel(session, manager, modelRuntime);
				if (command.name !== undefined) session.setSessionName(command.name);
				if (command.model !== undefined) {
					const model = modelRuntime.getModel(command.model.provider, command.model.id);
					if (model === undefined) throw new Error("Requested model is unavailable");
					await session.setModel(model);
				}
				if (command.thinkingLevel !== undefined) session.setThinkingLevel(command.thinkingLevel);
				const sessionId = session.sessionId;
				runtimeOwnership.adoptReady(sessionId, connectionId);
				let runtime: SessionRuntime;
				const unsubscribe = session.subscribe((event) => publishSessionEvent(runtime, event));
				runtime = {
					session,
					createdAt: Date.now(),
					unsubscribe,
					publishedTranscript: recentTranscriptOf(transcriptOf(session)),
					revision: 1,
				};
				attached.set(sessionId, runtime);
				return runtime;
			} catch (error) {
				void creation.then(
					({session}) => disposeSession(session),
					() => undefined,
				);
				throw error;
			}
		};

		const requireRuntime = (sessionId: string): SessionRuntime => {
			const runtime = attached.get(sessionId);
			if (runtime === undefined) {
				throw Object.assign(new Error(`Session ${sessionId} is not attached by this client`), {
					code: "session_locked",
				});
			}
			return runtime;
		};

		const handle = async (id: string, request: Command): Promise<void> => {
			try {
				if (request.command === "list") {
					const sessions = (await sessionIndex.list()).map(
						({path: _path, ...metadata}) => metadata,
					);
					deliver({type: "response", id, ok: true, result: {command: "list", sessions}});
					return;
				}
				if (request.command === "create") {
					const runtime = await createSession(request);
					deliver({
						type: "response",
						id,
						ok: true,
						result: {command: "create", session: snapshotOf(runtime)},
					});
					return;
				}
				if (request.command === "attach") {
					const metadata = await sessionIndex.find(request.sessionId);
					if (metadata === undefined) {
						fail(id, "not_found", `Session ${request.sessionId} was not found`);
						return;
					}
					const attachment = await beginAttach(request.sessionId, metadata.path);
					deliver({
						type: "response",
						id,
						ok: true,
						result: {command: "attach", session: attachment.snapshot},
					});
					attachment.start();
					void publishServerSnapshot();
					return;
				}
				if (request.command === "detach") {
					await disposeRuntime(request.sessionId);
					deliver({
						type: "response",
						id,
						ok: true,
						result: {command: "detach", sessionId: request.sessionId},
					});
					return;
				}
				const runtime = requireRuntime(request.sessionId);
				if (request.command === "prompt") {
					let resolvePreflight: (accepted: boolean) => void = () => undefined;
					const preflight = new Promise<boolean>((resolve) => {
						resolvePreflight = resolve;
					});
					const running = runtime.session.prompt(request.text, {preflightResult: resolvePreflight});
					const accepted = await withDeadline(
						preflight,
						operationTimeoutMs,
						`Prompt acceptance for ${request.sessionId}`,
					);
					if (!accepted) {
						await running.catch(() => undefined);
						throw new Error("Coding agent refused the prompt before execution");
					}
					void running.catch(() => publish(runtime));
				} else if (request.command === "steer") {
					await withDeadline(
						runtime.session.steer(request.text),
						operationTimeoutMs,
						`Steering ${request.sessionId}`,
					);
				} else if (request.command === "abort") {
					await withDeadline(
						runtime.session.abort(),
						operationTimeoutMs,
						`Aborting ${request.sessionId}`,
					);
				} else if (request.command === "set_model") {
					const model = (await runtimePromise).getModel(request.model.provider, request.model.id);
					if (model === undefined) throw new Error("Requested model is unavailable");
					await withDeadline(
						runtime.session.setModel(model),
						operationTimeoutMs,
						`Selecting a model for ${request.sessionId}`,
					);
				} else {
					runtime.session.setThinkingLevel(request.thinkingLevel);
				}
				publish(runtime);
				deliver({
					type: "response",
					id,
					ok: true,
					result: {command: request.command, session: snapshotOf(runtime)},
				});
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? (error as {code?: unknown}).code
						: undefined;
				fail(id, code === "session_locked" ? "session_locked" : "internal_error", messageOf(error));
			}
		};

		return {
			async send(chunk) {
				if (closed) throw new Error("Tuval coding-agent transport is closed");
				let messages: ReturnType<ClientMessageDecoder["push"]>;
				try {
					messages = decoder.push(chunk);
				} catch (error) {
					closed = true;
					handlers.onError(error instanceof Error ? error : new Error(messageOf(error)));
					return;
				}
				for (const message of messages) {
					if (message.type === "hello") {
						if (message.version !== PROTOCOL_VERSION) {
							deliver({
								type: "hello_error",
								error: {
									code: "version",
									message: `Unsupported pi protocol version ${message.version}`,
								},
							});
							continue;
						}
						const modelRuntime = await runtimePromise;
						const available = new Set(
							modelRuntime
								.getAvailableSnapshot()
								.map((model) => `${model.provider}\u0000${model.id}`),
						);
						const sessions = (await sessionIndex.list()).map(
							({path: _path, ...metadata}) => metadata,
						);
						greeted = true;
						deliver({
							type: "hello",
							version: PROTOCOL_VERSION,
							connectionId,
							snapshot: {
								serverId: "tuval-coding-agent",
								protocolVersion: PROTOCOL_VERSION,
								revision: ++serverRevision,
								sessions,
								models: modelRuntime
									.getModels()
									.filter(
										(model) =>
											available.has(`${model.provider}\u0000${model.id}`) ||
											modelRuntime.getRegisteredNativeProvider(model.provider) !== undefined,
									)
									.map((model) => modelMetadataOf(model, true)),
							},
						});
						continue;
					}
					if (!greeted) {
						fail(message.id, "invalid_request", "Client hello is required");
						continue;
					}
					serialized = serialized.then(() => handle(message.id, message.request));
					await serialized;
				}
			},
			close() {
				if (closed) return;
				closed = true;
				for (const sessionId of [...constructions.keys()]) cancelConstruction(sessionId);
				try {
					decoder.end();
				} catch (error) {
					handlers.onError(error instanceof Error ? error : new Error(messageOf(error)));
					return;
				}
				void Promise.all([
					...[...attached.keys()].map(disposeRuntime),
					...backgroundConstructions,
				]).finally(() => handlers.onClose());
			},
		};
	}) as CodingAgentPiTransport;

	transport.archiveState = (sessionId: string, transcript: ReadonlyArray<TranscriptItem>) => {
		const first = transcript.at(0);
		if (first === undefined) return {_tag: "complete", hasMore: false};
		const prefix = `${sessionId}:`;
		if (!first.id.startsWith(prefix)) return {_tag: "complete", hasMore: false};
		const before = Number(first.id.slice(prefix.length));
		if (!Number.isSafeInteger(before) || before <= 0) return {_tag: "complete", hasMore: false};
		return {
			_tag: "more",
			hasMore: true,
			cursor: encodeArchiveCursor({version: 1, sessionId, anchorId: first.id}),
		};
	};
	transport.currentRuntime = runtimeOwnership.currentRuntime;
	transport.subscribeRuntime = runtimeOwnership.subscribeRuntime;
	transport.loadOlder = async (cursor: string) => {
		const decoded = decodeArchiveCursor(cursor);
		if (decoded === undefined) {
			return {
				_tag: "refused",
				code: "invalid-cursor",
				reason: "Transcript archive cursor is malformed",
			};
		}
		const metadata = (await sessionIndex.list()).find(({id}) => id === decoded.sessionId);
		if (metadata === undefined) {
			return {
				_tag: "refused",
				code: "stale-cursor",
				reason: "Transcript archive cursor no longer names an available session",
			};
		}
		try {
			const manager = SessionManager.open(metadata.path);
			const transcript = transcriptOfMessages(
				decoded.sessionId,
				manager.buildSessionContext().messages,
			);
			const before = transcript.findIndex(({id}) => id === decoded.anchorId);
			if (before <= 0) {
				return {
					_tag: "refused",
					code: "stale-cursor",
					reason: "Transcript archive changed before the requested window",
				};
			}
			const start = boundedWindowStart(transcript, before);
			return {
				_tag: "loaded",
				sessionId: decoded.sessionId,
				transcript: transcript.slice(start, before).map(archiveEntryOf),
				archive: archiveStateBefore(decoded.sessionId, transcript, start),
			};
		} catch (error) {
			return {
				_tag: "refused",
				code: "protocol",
				reason: `Transcript archive could not be read: ${messageOf(error)}`,
			};
		}
	};
	return transport;
};
