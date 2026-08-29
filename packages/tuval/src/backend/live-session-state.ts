import {
	type ByteTransportFactory,
	PiClient,
	PiDisconnectedError,
	PiServerError,
	PiSessionDetachedError,
	type PiSessionHandle,
	PiSessionOwnershipError,
	type Unsubscribe,
} from "@earendil-works/pi-client";
import type {
	JsonValue,
	ModelMetadata,
	ModelRef,
	ServerEvent,
	SessionSnapshot,
	TranscriptItem,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type {
	AbortLiveSessionRequest,
	AttachedLiveSession,
	AttachLiveSessionOutcome,
	ControlLiveSessionOutcome,
	CreateLiveSessionRequest,
	LiveSessionControls,
	LiveSessionEvent,
	LiveSessionView,
	LiveTranscriptEntry,
	OpenLiveSessionRequest,
	PromptLiveSessionOutcome,
	PromptLiveSessionRequest,
	ReleaseLiveSessionOutcome,
	SetModelLiveSessionRequest,
	SetThinkingLiveSessionRequest,
	SteerLiveSessionRequest,
} from "../shared/live-session.js";
import {resilienceDiagnostic} from "./resilience.js";

const EVENT_HISTORY_LIMIT = 500;
const CORRELATED_PROMPT_LIMIT = 100;
const CORRELATED_CONTROL_LIMIT = 100;
const ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000;

type Listener = (event: LiveSessionEvent) => void;

interface Attachment {
	readonly lease: PiSessionHandle;
	readonly generation: number;
	readonly unsubscribes: ReadonlyArray<Unsubscribe>;
	snapshot: SessionSnapshot;
	transcript: Array<LiveTranscriptEntry>;
	readonly toolCallBuffers: Map<string, string>;
	disconnectedReason?: string;
	leaseReleased: boolean;
}

interface CorrelatedPrompt {
	readonly text: string;
	readonly result: Promise<PromptLiveSessionOutcome>;
	settled: boolean;
}

type ControlRequest =
	| ({readonly command: "create"} & CreateLiveSessionRequest)
	| ({readonly command: "open"} & OpenLiveSessionRequest)
	| ({readonly command: "steer"} & SteerLiveSessionRequest)
	| ({readonly command: "abort"} & AbortLiveSessionRequest)
	| ({readonly command: "set-model"} & SetModelLiveSessionRequest)
	| ({readonly command: "set-thinking"} & SetThinkingLiveSessionRequest);

interface CorrelatedControl {
	readonly fingerprint: string;
	readonly result: Promise<ControlLiveSessionOutcome>;
	settled: boolean;
}

export interface AcknowledgementDeadline {
	readonly elapsed: Promise<void>;
	readonly cancel: () => void;
}

export interface LiveSessionStateOptions {
	readonly acknowledgementTimeoutMs?: number;
	readonly makeAcknowledgementDeadline?: (timeoutMs: number) => AcknowledgementDeadline;
	readonly onDisconnected?: () => void;
	readonly onSessionSubscriptionBound?: (sessionId: string) => void;
}

interface PendingAttachment {
	readonly sessionId: string;
	readonly eventsAfterSnapshot: Array<ServerEvent>;
}

export interface LiveSessionState {
	readonly current: () => LiveSessionView | null;
	readonly attach: (sessionId: string) => Promise<AttachLiveSessionOutcome>;
	readonly prompt: (request: PromptLiveSessionRequest) => Promise<PromptLiveSessionOutcome>;
	readonly create: (request: CreateLiveSessionRequest) => Promise<ControlLiveSessionOutcome>;
	readonly open: (request: OpenLiveSessionRequest) => Promise<ControlLiveSessionOutcome>;
	readonly steer: (request: SteerLiveSessionRequest) => Promise<ControlLiveSessionOutcome>;
	readonly abort: (request: AbortLiveSessionRequest) => Promise<ControlLiveSessionOutcome>;
	readonly setModel: (request: SetModelLiveSessionRequest) => Promise<ControlLiveSessionOutcome>;
	readonly setThinking: (
		request: SetThinkingLiveSessionRequest,
	) => Promise<ControlLiveSessionOutcome>;
	readonly release: () => Promise<ReleaseLiveSessionOutcome>;
	readonly eventsAfter: (sequence?: number) => ReadonlyArray<LiveSessionEvent>;
	readonly subscribe: (listener: Listener) => Unsubscribe;
	readonly dispose: () => Promise<void>;
}

const completionOf = (
	snapshot: SessionSnapshot,
	transcript: ReadonlyArray<LiveTranscriptEntry>,
	disconnected: boolean,
): LiveSessionView["completion"] => {
	if (disconnected) return "disconnected";
	if (snapshot.phase !== "idle") return "running";
	const lastActivity = transcript.findLast((item) => item.role !== "user");
	if (lastActivity?.status === "streaming" || lastActivity?.status === "running") return "running";
	if (lastActivity?.status === "error") return "error";
	if (lastActivity?.status === "aborted") return "aborted";
	if (lastActivity?.status === "complete") return "complete";
	return "idle";
};

const entryOf = (item: TranscriptItem): LiveTranscriptEntry => ({
	id: item.id,
	role: item.role,
	content: [...item.content],
	timestamp: item.timestamp,
	status: item.role === "user" ? "complete" : item.status,
});

const replaceOrAppend = (
	transcript: Array<LiveTranscriptEntry>,
	entry: LiveTranscriptEntry,
): void => {
	const index = transcript.findIndex((candidate) => candidate.id === entry.id);
	if (index === -1) transcript.push(entry);
	else transcript[index] = entry;
};

const isJsonValue = (value: unknown): value is JsonValue => {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	return Object.values(value).every(isJsonValue);
};

const parsePartialToolInput = (value: string): JsonValue => {
	try {
		const parsed: unknown = JSON.parse(value);
		if (isJsonValue(parsed)) return parsed;
	} catch {
		return value;
	}
	return value;
};

const appendAssistantDelta = (
	transcript: Array<LiveTranscriptEntry>,
	toolCallBuffers: Map<string, string>,
	progress: Extract<TranscriptProgress, {type: "assistant_delta"}>,
): string | undefined => {
	const index = transcript.findIndex((item) => item.id === progress.messageId);
	const entry = transcript[index];
	if (entry === undefined) {
		return `assistant delta targets missing transcript item ${progress.messageId}`;
	}
	if (entry.role !== "assistant") {
		return `assistant delta target ${progress.messageId} has role ${entry.role}, not assistant`;
	}
	const content = [...entry.content];
	const part = content[progress.contentIndex];
	if (part === undefined) {
		return `assistant delta targets missing content index ${progress.contentIndex} on ${progress.messageId}`;
	}
	if (part.type !== progress.kind) {
		return `assistant delta kind ${progress.kind} does not match ${part.type} content on ${progress.messageId}`;
	}
	if (part.type === "text") {
		content[progress.contentIndex] = {...part, text: part.text + progress.delta};
	} else if (part.type === "thinking") {
		content[progress.contentIndex] = {...part, thinking: part.thinking + progress.delta};
	} else {
		const key = `${progress.messageId}:${progress.contentIndex}`;
		const existing = toolCallBuffers.get(key) ?? (typeof part.input === "string" ? part.input : "");
		const buffer = existing + progress.delta;
		toolCallBuffers.set(key, buffer);
		content[progress.contentIndex] = {...part, input: parsePartialToolInput(buffer)};
	}
	transcript[index] = {...entry, content};
	return undefined;
};

const reduceProgress = (
	transcript: Array<LiveTranscriptEntry>,
	toolCallBuffers: Map<string, string>,
	progress: TranscriptProgress,
): string | undefined => {
	if (progress.type === "assistant_delta") {
		return appendAssistantDelta(transcript, toolCallBuffers, progress);
	}
	if (progress.type === "item_finished") {
		for (const key of toolCallBuffers.keys()) {
			if (key.startsWith(`${progress.item.id}:`)) toolCallBuffers.delete(key);
		}
	}
	replaceOrAppend(transcript, entryOf(progress.item));
	return undefined;
};

const refusalCode = (
	error: unknown,
): "lease-refused" | "disconnected" | "not-found" | "protocol" => {
	if (error instanceof PiDisconnectedError) return "disconnected";
	if (error instanceof PiSessionOwnershipError || error instanceof PiSessionDetachedError) {
		return "lease-refused";
	}
	if (error instanceof PiServerError) {
		if (error.code === "session_locked" || error.code === "busy") return "lease-refused";
		if (error.code === "not_found") return "not-found";
	}
	return "protocol";
};

const promptRefusalCode = (error: unknown): "lease-refused" | "disconnected" | "protocol" => {
	const code = refusalCode(error);
	if (code === "lease-refused" || code === "disconnected") return code;
	return "protocol";
};

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const makeAcknowledgementDeadline = (timeoutMs: number): AcknowledgementDeadline => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const elapsed = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
		timer.unref();
	});
	return {
		elapsed,
		cancel: () => {
			if (timer !== undefined) clearTimeout(timer);
		},
	};
};

const sameModel = (left: ModelRef, right: ModelRef): boolean =>
	left.provider === right.provider && left.id === right.id;

const controlErrorCode = (
	error: unknown,
): "ownership-refused" | "unsupported-capability" | "disconnected" | "protocol" => {
	if (error instanceof PiDisconnectedError) return "disconnected";
	if (error instanceof PiSessionOwnershipError || error instanceof PiSessionDetachedError) {
		return "ownership-refused";
	}
	if (error instanceof PiServerError) {
		if (error.code === "session_locked" || error.code === "busy") return "ownership-refused";
		if (error.code === "not_implemented") return "unsupported-capability";
	}
	return "protocol";
};

const eventSessionId = (event: ServerEvent): string | undefined => {
	if (event.type === "session_snapshot") return event.snapshot.id;
	if (event.type === "session_progress" || event.type === "session_removed") return event.sessionId;
	return undefined;
};

export class PiLiveSessionState implements LiveSessionState {
	readonly #client: PiClient;
	readonly #listeners = new Set<Listener>();
	readonly #events: Array<LiveSessionEvent> = [];
	readonly #prompts = new Map<string, CorrelatedPrompt>();
	readonly #controls = new Map<string, CorrelatedControl>();
	readonly #unsubscribeConnection: Unsubscribe;
	readonly #unsubscribeEvents: Unsubscribe;
	readonly #unsubscribeServer: Unsubscribe;
	readonly #acknowledgementTimeoutMs: number;
	readonly #makeAcknowledgementDeadline: (timeoutMs: number) => AcknowledgementDeadline;
	readonly #options: LiveSessionStateOptions;
	#attachment: Attachment | undefined;
	#pendingAttachment: PendingAttachment | undefined;
	#sequence = 0;
	#generation = 0;
	#promptGeneration: number | undefined;
	#pendingPrompts = 0;
	#pendingReplacement = false;
	#pendingIdleControl = false;
	#lifecycle: Promise<void> = Promise.resolve();
	#disposed = false;

	private constructor(client: PiClient, options: LiveSessionStateOptions) {
		this.#client = client;
		this.#options = options;
		this.#acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? ACKNOWLEDGEMENT_TIMEOUT_MS;
		this.#makeAcknowledgementDeadline =
			options.makeAcknowledgementDeadline ?? makeAcknowledgementDeadline;
		this.#unsubscribeConnection = client.onConnectionStateChange((change) => {
			if (change.state !== "disconnected") return;
			options.onDisconnected?.();
			const attachment = this.#attachment;
			if (attachment === undefined || attachment.disconnectedReason !== undefined) return;
			attachment.disconnectedReason = change.error?.message ?? "PiClient disconnected";
			this.#publishDiagnostic(
				change.error === undefined
					? "Pi live transport disconnected"
					: "Pi live protocol input was invalid and the transport disconnected",
				attachment.snapshot.id,
			);
			this.#publishSession(attachment);
			void this.#serialize(() => this.#releaseLease(attachment));
		});
		this.#unsubscribeServer = client.subscribe(() => {
			const attachment = this.#attachment;
			if (attachment !== undefined) this.#publishSession(attachment);
		});
		this.#unsubscribeEvents = client.onEvent((event) => {
			const attachment = this.#attachment;
			if (attachment !== undefined && eventSessionId(event) === attachment.snapshot.id) {
				this.#acceptEvent(attachment.generation, event);
				return;
			}
			const pending = this.#pendingAttachment;
			if (pending !== undefined && eventSessionId(event) === pending.sessionId) {
				if (event.type === "session_snapshot") pending.eventsAfterSnapshot.length = 0;
				else pending.eventsAfterSnapshot.push(event);
			}
		});
	}

	static async connect(
		transportFactory: ByteTransportFactory,
		options: LiveSessionStateOptions = {},
	): Promise<PiLiveSessionState> {
		return new PiLiveSessionState(await PiClient.connect({transportFactory}), options);
	}

	current = (): LiveSessionView | null => {
		const attachment = this.#attachment;
		return attachment === undefined ? null : this.#viewOf(attachment, this.#sequence);
	};

	attach = (sessionId: string): Promise<AttachLiveSessionOutcome> => this.#attach(sessionId);

	prompt = (request: PromptLiveSessionRequest): Promise<PromptLiveSessionOutcome> => {
		const generation = this.#attachment?.generation;
		if (generation === undefined) return this.#runPrompt(request);
		this.#scopePromptsTo(generation);
		const existing = this.#prompts.get(request.correlationId);
		if (existing !== undefined) {
			if (existing.text === request.text) return existing.result;
			return this.#refusePrompt(
				request.correlationId,
				"Correlation id was already used for a different prompt",
			);
		}
		if (!this.#makePromptRoom()) {
			return this.#refusePrompt(
				request.correlationId,
				"Too many prompts are awaiting acknowledgement",
			);
		}
		const result = this.#runPrompt(request);
		const correlated: CorrelatedPrompt = {text: request.text, result, settled: false};
		this.#prompts.set(request.correlationId, correlated);
		void result.then(
			() => {
				correlated.settled = true;
			},
			() => {
				correlated.settled = true;
			},
		);
		return result;
	};

	create = (request: CreateLiveSessionRequest): Promise<ControlLiveSessionOutcome> =>
		this.#correlateControl({command: "create", ...request});

	open = (request: OpenLiveSessionRequest): Promise<ControlLiveSessionOutcome> =>
		this.#correlateControl({command: "open", ...request});

	steer = (request: SteerLiveSessionRequest): Promise<ControlLiveSessionOutcome> =>
		this.#correlateControl({command: "steer", ...request});

	abort = (request: AbortLiveSessionRequest): Promise<ControlLiveSessionOutcome> =>
		this.#correlateControl({command: "abort", ...request});

	setModel = (request: SetModelLiveSessionRequest): Promise<ControlLiveSessionOutcome> =>
		this.#correlateControl({command: "set-model", ...request});

	setThinking = (request: SetThinkingLiveSessionRequest): Promise<ControlLiveSessionOutcome> =>
		this.#correlateControl({command: "set-thinking", ...request});

	release = (): Promise<ReleaseLiveSessionOutcome> =>
		this.#serialize(async () => {
			const sessionId = this.#attachment?.snapshot.id ?? null;
			await this.#releaseAttachment();
			return {_tag: "released", sessionId};
		});

	eventsAfter = (sequence = 0): ReadonlyArray<LiveSessionEvent> =>
		this.#events.filter((event) => event.sequence > sequence);

	subscribe = (listener: Listener): Unsubscribe => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	dispose = async (): Promise<void> => {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.#releaseAttachment();
		this.#unsubscribeConnection();
		this.#unsubscribeServer();
		this.#unsubscribeEvents();
		this.#listeners.clear();
		await this.#client.dispose();
	};

	async #attach(sessionId: string): Promise<AttachLiveSessionOutcome> {
		return this.#serialize(async () => {
			if (this.#disposed) {
				return {
					_tag: "refused",
					sessionId,
					code: "disconnected",
					reason: "Tuval live-session service is disposed",
				};
			}
			if (
				this.#attachment?.snapshot.id === sessionId &&
				this.#attachment.disconnectedReason === undefined
			) {
				return {_tag: "attached", session: this.#attachedViewOf(this.#attachment, this.#sequence)};
			}
			await this.#releaseAttachment();
			const pending: PendingAttachment = {sessionId, eventsAfterSnapshot: []};
			this.#pendingAttachment = pending;
			let lease: PiSessionHandle;
			try {
				lease = await this.#client.acquireSession(sessionId, {mode: "exclusive"});
			} catch (error) {
				if (this.#pendingAttachment === pending) this.#pendingAttachment = undefined;
				return {
					_tag: "refused",
					sessionId,
					code: refusalCode(error),
					reason: messageOf(error),
				};
			}
			const snapshot = lease.snapshot;
			if (snapshot === undefined) {
				if (this.#pendingAttachment === pending) this.#pendingAttachment = undefined;
				await lease.dispose().catch(() => undefined);
				return {
					_tag: "refused",
					sessionId,
					code: "protocol",
					reason: "PiClient attached without a session snapshot",
				};
			}
			const generation = ++this.#generation;
			const attachment: Attachment = {
				lease,
				generation,
				snapshot,
				transcript: snapshot.transcript.map(entryOf),
				toolCallBuffers: new Map(),
				unsubscribes: [],
				leaseReleased: false,
			};
			const unsubscribes = [lease.subscribe((next) => this.#acceptSnapshot(generation, next))];
			this.#attachment = {...attachment, unsubscribes};
			this.#options.onSessionSubscriptionBound?.(snapshot.id);
			if (this.#pendingAttachment === pending) this.#pendingAttachment = undefined;
			for (const event of pending.eventsAfterSnapshot) this.#acceptEvent(generation, event);
			this.#publishSession(this.#attachment);
			return {_tag: "attached", session: this.#attachedViewOf(this.#attachment, this.#sequence)};
		});
	}

	#correlateControl(request: ControlRequest): Promise<ControlLiveSessionOutcome> {
		const fingerprint = JSON.stringify(request);
		const existing = this.#controls.get(request.correlationId);
		if (existing !== undefined) {
			if (existing.fingerprint === fingerprint) return existing.result;
			return Promise.resolve(
				this.#publishControl(
					this.#controlRefusal(
						request,
						"protocol",
						"Correlation id was already used for a different control request",
					),
				),
			);
		}
		if (!this.#makeControlRoom()) {
			return Promise.resolve(
				this.#publishControl(
					this.#controlRefusal(
						request,
						"protocol",
						"Too many control requests are awaiting acknowledgement",
					),
				),
			);
		}
		const result = this.#runControl(request).then((outcome) => this.#publishControl(outcome));
		const correlated: CorrelatedControl = {fingerprint, result, settled: false};
		this.#controls.set(request.correlationId, correlated);
		void result.then(
			() => {
				correlated.settled = true;
			},
			() => {
				correlated.settled = true;
			},
		);
		return result;
	}

	#runControl(request: ControlRequest): Promise<ControlLiveSessionOutcome> {
		switch (request.command) {
			case "create":
				return this.#runReplacement(request, () =>
					this.#client.createSession({
						...(request.cwd === undefined ? {} : {cwd: request.cwd}),
						...(request.name === undefined ? {} : {name: request.name}),
					}),
				);
			case "open":
				return this.#runReplacement(request, () =>
					this.#client.acquireSession(request.sessionId, {mode: "exclusive"}),
				);
			case "steer":
				return this.#runSessionControl(request, (lease) => lease.steer(request.text));
			case "abort":
				return this.#runSessionControl(request, (lease) => lease.abort());
			case "set-model":
				return this.#runSessionControl(request, (lease) => lease.setModel(request.model));
			case "set-thinking":
				return this.#runSessionControl(request, (lease) =>
					lease.setThinking(request.thinkingLevel),
				);
		}
	}

	async #runReplacement(
		request: Extract<ControlRequest, {command: "create" | "open"}>,
		acquire: () => Promise<PiSessionHandle>,
	): Promise<ControlLiveSessionOutcome> {
		const previous = this.#attachment;
		if (this.#pendingReplacement || this.#pendingIdleControl || this.#pendingPrompts > 0) {
			return this.#controlRefusal(request, "unavailable", "Another session operation is pending");
		}
		if (previous !== undefined) {
			const controls = this.#controlsOf(previous);
			if (!(request.command === "create" ? controls.create : controls.open)) {
				return this.#controlRefusal(
					request,
					previous.disconnectedReason === undefined ? "unavailable" : "disconnected",
					`Cannot ${request.command} while the observed session phase is ${previous.snapshot.phase}`,
				);
			}
		}
		this.#pendingReplacement = true;
		if (previous !== undefined) this.#publishSession(previous);
		const operation = this.#serialize(async () => {
			if (this.#disposed || !this.#client.connected) {
				throw new PiDisconnectedError("PiClient is disconnected");
			}
			const pending: PendingAttachment | undefined =
				request.command === "open"
					? {sessionId: request.sessionId, eventsAfterSnapshot: []}
					: undefined;
			if (pending !== undefined) this.#pendingAttachment = pending;
			let lease: PiSessionHandle;
			try {
				lease = await acquire();
			} finally {
				if (pending !== undefined && this.#pendingAttachment === pending) {
					this.#pendingAttachment = undefined;
				}
			}
			const snapshot = lease.snapshot;
			if (snapshot === undefined) {
				await lease.dispose().catch(() => undefined);
				throw new PiServerError({
					code: "invalid_request",
					message: "PiClient acknowledged a session without a snapshot",
				});
			}
			if (this.#attachment !== previous) {
				await lease.dispose().catch(() => undefined);
				throw new PiSessionOwnershipError(
					snapshot.id,
					"The selected session changed before the request was acknowledged",
				);
			}
			if (previous !== undefined) await this.#releaseAttachment();
			const attachment = this.#bindLease(lease, snapshot);
			if (pending !== undefined) {
				for (const event of pending.eventsAfterSnapshot) {
					this.#acceptEvent(attachment.generation, event);
				}
			}
			this.#publishSession(attachment);
			return attachment;
		})
			.then((attachment) => {
				this.#pendingReplacement = false;
				this.#publishSession(attachment);
				return this.#acknowledged(request, attachment);
			})
			.finally(() => {
				if (!this.#pendingReplacement) return;
				this.#pendingReplacement = false;
				const attachment = this.#attachment;
				if (attachment !== undefined) this.#publishSession(attachment);
			});
		return this.#awaitAcknowledgement(request, operation);
	}

	async #runSessionControl(
		request: Exclude<ControlRequest, {command: "create" | "open"}>,
		execute: (lease: PiSessionHandle) => Promise<SessionSnapshot>,
	): Promise<ControlLiveSessionOutcome> {
		const attachment = this.#attachment;
		if (attachment === undefined) {
			return this.#controlRefusal(
				request,
				"ownership-refused",
				"No exclusive session lease is held",
			);
		}
		if (attachment.disconnectedReason !== undefined || !this.#client.connected) {
			return this.#controlRefusal(
				request,
				"disconnected",
				attachment.disconnectedReason ?? "PiClient is disconnected",
			);
		}
		if (attachment.leaseReleased || !attachment.lease.active) {
			return this.#controlRefusal(
				request,
				"ownership-refused",
				"The exclusive session lease is no longer active",
			);
		}
		if (this.#pendingReplacement) {
			return this.#controlRefusal(request, "unavailable", "A session replacement is pending");
		}
		const controls = this.#controlsOf(attachment);
		const available =
			request.command === "steer"
				? controls.steer
				: request.command === "abort"
					? controls.abort
					: request.command === "set-model"
						? controls.setModel
						: controls.setThinking;
		if (!available) {
			const unsupported =
				(request.command === "set-model" && controls.models.length === 0) ||
				(request.command === "set-thinking" && controls.thinkingLevels.length === 0);
			return this.#controlRefusal(
				request,
				unsupported ? "unsupported-capability" : "unavailable",
				`The observed session cannot ${request.command} during ${attachment.snapshot.phase}`,
			);
		}
		if (
			request.command === "set-model" &&
			!controls.models.some((candidate) => sameModel(candidate.model, request.model))
		) {
			return this.#controlRefusal(
				request,
				"unsupported-value",
				`Model ${request.model.provider}/${request.model.id} is not an authenticated pi capability`,
			);
		}
		if (
			request.command === "set-thinking" &&
			!controls.thinkingLevels.includes(request.thinkingLevel)
		) {
			return this.#controlRefusal(
				request,
				"unsupported-value",
				`Thinking level ${request.thinkingLevel} is not supported by the observed model`,
			);
		}
		const idleControl = request.command === "set-model" || request.command === "set-thinking";
		if (idleControl) {
			if (this.#pendingIdleControl || this.#pendingPrompts > 0) {
				return this.#controlRefusal(request, "unavailable", "Another session operation is pending");
			}
			this.#pendingIdleControl = true;
			this.#publishSession(attachment);
		}
		const operation = execute(attachment.lease)
			.then(() => this.#reconcileAttachment(attachment))
			.then((reconciled) => {
				if (idleControl) this.#pendingIdleControl = false;
				if (this.#attachment === reconciled) this.#publishSession(reconciled);
				return this.#acknowledged(request, reconciled);
			})
			.finally(() => {
				if (!idleControl || !this.#pendingIdleControl) return;
				this.#pendingIdleControl = false;
				if (this.#attachment === attachment) this.#publishSession(attachment);
			});
		return this.#awaitAcknowledgement(request, operation);
	}

	async #awaitAcknowledgement(
		request: ControlRequest,
		operation: Promise<ControlLiveSessionOutcome>,
	): Promise<ControlLiveSessionOutcome> {
		const deadline = this.#makeAcknowledgementDeadline(this.#acknowledgementTimeoutMs);
		const observed = operation.then(
			(outcome) => ({_tag: "outcome" as const, outcome}),
			(error: unknown) => ({_tag: "error" as const, error}),
		);
		const winner = await Promise.race([
			observed,
			deadline.elapsed.then(() => ({_tag: "timeout" as const})),
		]);
		if (winner._tag === "timeout") {
			return this.#controlRefusal(
				request,
				"timeout",
				`Pi did not acknowledge ${request.command} within ${this.#acknowledgementTimeoutMs}ms`,
			);
		}
		deadline.cancel();
		if (winner._tag === "outcome") return winner.outcome;
		return this.#controlRefusal(
			request,
			controlErrorCode(winner.error),
			messageOf(winner.error),
			winner.error instanceof PiServerError ? winner.error.code : undefined,
		);
	}

	#acknowledged(
		request: ControlRequest,
		attachment: Attachment,
	): Extract<ControlLiveSessionOutcome, {_tag: "acknowledged"}> {
		const session = this.#attachedViewOf(attachment, this.#sequence);
		if (request.command === "set-model") {
			return {
				_tag: "acknowledged",
				command: request.command,
				correlationId: request.correlationId,
				session,
				value: session.model,
			};
		}
		if (request.command === "set-thinking") {
			return {
				_tag: "acknowledged",
				command: request.command,
				correlationId: request.correlationId,
				session,
				value: session.thinkingLevel,
			};
		}
		return {
			_tag: "acknowledged",
			command: request.command,
			correlationId: request.correlationId,
			session,
		};
	}

	#controlRefusal(
		request: ControlRequest,
		code: Extract<ControlLiveSessionOutcome, {_tag: "refused"}>["code"],
		reason: string,
		protocolCode?: string,
	): Extract<ControlLiveSessionOutcome, {_tag: "refused"}> {
		return {
			_tag: "refused",
			command: request.command,
			correlationId: request.correlationId,
			code,
			reason,
			...(protocolCode === undefined ? {} : {protocolCode}),
			session: this.current(),
		};
	}

	#publishControl(outcome: ControlLiveSessionOutcome): ControlLiveSessionOutcome {
		this.#publish({_tag: "control", sequence: this.#nextSequence(), outcome});
		return outcome;
	}

	#makeControlRoom(): boolean {
		if (this.#controls.size < CORRELATED_CONTROL_LIMIT) return true;
		for (const [correlationId, control] of this.#controls) {
			if (!control.settled) continue;
			this.#controls.delete(correlationId);
			return true;
		}
		return false;
	}

	#bindLease(lease: PiSessionHandle, snapshot: SessionSnapshot): Attachment {
		const generation = ++this.#generation;
		const attachment: Attachment = {
			lease,
			generation,
			snapshot,
			transcript: snapshot.transcript.map(entryOf),
			toolCallBuffers: new Map(),
			unsubscribes: [],
			leaseReleased: false,
		};
		const unsubscribes = [lease.subscribe((next) => this.#acceptSnapshot(generation, next))];
		const bound = {...attachment, unsubscribes};
		this.#attachment = bound;
		this.#options.onSessionSubscriptionBound?.(snapshot.id);
		return bound;
	}

	#reconcileAttachment(attachment: Attachment): Attachment {
		if (this.#attachment !== attachment) {
			throw new PiSessionOwnershipError(
				attachment.snapshot.id,
				"The selected session changed before the request was acknowledged",
			);
		}
		if (attachment.disconnectedReason !== undefined || !this.#client.connected) {
			throw new PiDisconnectedError(
				attachment.disconnectedReason ?? "PiClient disconnected before acknowledgement",
			);
		}
		if (attachment.leaseReleased || !attachment.lease.active) {
			throw new PiSessionOwnershipError(
				attachment.snapshot.id,
				"The exclusive session lease ended before acknowledgement",
			);
		}
		const snapshot = attachment.lease.snapshot;
		if (snapshot === undefined) {
			throw new PiSessionDetachedError(attachment.snapshot.id);
		}
		if (snapshot !== attachment.snapshot) this.#acceptSnapshot(attachment.generation, snapshot);
		return attachment;
	}

	async #runPrompt(request: PromptLiveSessionRequest): Promise<PromptLiveSessionOutcome> {
		const attachment = this.#attachment;
		let outcome: PromptLiveSessionOutcome;
		if (attachment === undefined) {
			outcome = {
				_tag: "refused",
				correlationId: request.correlationId,
				code: "no-attachment",
				reason: "No live session is attached",
			};
		} else if (attachment.disconnectedReason !== undefined) {
			outcome = {
				_tag: "refused",
				correlationId: request.correlationId,
				code: "disconnected",
				reason: attachment.disconnectedReason,
			};
		} else {
			try {
				this.#pendingPrompts += 1;
				this.#publishSession(attachment);
				try {
					await attachment.lease.prompt(request.text);
				} finally {
					this.#pendingPrompts -= 1;
					if (this.#attachment === attachment) this.#publishSession(attachment);
				}
				this.#reconcileAttachment(attachment);
				if (this.#attachment !== attachment) {
					throw new PiSessionOwnershipError(
						attachment.snapshot.id,
						"The selected session changed before the prompt was acknowledged",
					);
				}
				if (
					attachment.disconnectedReason !== undefined ||
					attachment.leaseReleased ||
					!attachment.lease.active
				) {
					throw new PiDisconnectedError(
						attachment.disconnectedReason ??
							"The attached pi session disconnected before the prompt was acknowledged",
					);
				}
				outcome = {
					_tag: "acknowledged",
					correlationId: request.correlationId,
					session: this.#attachedViewOf(attachment, this.#sequence),
				};
			} catch (error) {
				outcome = {
					_tag: "refused",
					correlationId: request.correlationId,
					code: promptRefusalCode(error),
					reason: messageOf(error),
				};
			}
		}
		this.#publishPrompt(outcome);
		return outcome;
	}

	#refusePrompt(correlationId: string, reason: string): Promise<PromptLiveSessionOutcome> {
		const outcome: PromptLiveSessionOutcome = {
			_tag: "refused",
			correlationId,
			code: "protocol",
			reason,
		};
		this.#publishPrompt(outcome);
		return Promise.resolve(outcome);
	}

	#publishPrompt(outcome: PromptLiveSessionOutcome): void {
		this.#publish({_tag: "prompt", sequence: this.#nextSequence(), outcome});
	}

	#scopePromptsTo(generation: number): void {
		if (this.#promptGeneration === generation) return;
		this.#prompts.clear();
		this.#promptGeneration = generation;
	}

	#makePromptRoom(): boolean {
		if (this.#prompts.size < CORRELATED_PROMPT_LIMIT) return true;
		for (const [correlationId, prompt] of this.#prompts) {
			if (!prompt.settled) continue;
			this.#prompts.delete(correlationId);
			return true;
		}
		return false;
	}

	#clearPrompts(): void {
		this.#prompts.clear();
		this.#promptGeneration = undefined;
	}

	#acceptSnapshot(generation: number, snapshot: SessionSnapshot): void {
		const attachment = this.#attachment;
		if (attachment === undefined || attachment.generation !== generation) return;
		attachment.snapshot = snapshot;
		attachment.transcript = snapshot.transcript.map(entryOf);
		attachment.toolCallBuffers.clear();
		this.#publishSession(attachment);
	}

	#acceptEvent(generation: number, event: ServerEvent): void {
		const attachment = this.#attachment;
		if (
			attachment === undefined ||
			attachment.generation !== generation ||
			attachment.disconnectedReason !== undefined
		) {
			return;
		}
		try {
			if (event.type === "session_progress") {
				const incoherence = reduceProgress(
					attachment.transcript,
					attachment.toolCallBuffers,
					event.progress,
				);
				if (incoherence !== undefined) {
					this.#publishDiagnostic(
						`Malformed live event was ignored: ${incoherence}`,
						attachment.snapshot.id,
					);
					return;
				}
				this.#publishSession(attachment);
			}
			if (event.type === "session_removed") {
				attachment.disconnectedReason = "The attached pi session was removed";
				this.#publishDiagnostic(attachment.disconnectedReason, attachment.snapshot.id);
				this.#publishSession(attachment);
				void this.#serialize(() => this.#releaseLease(attachment));
			}
		} catch {
			this.#publishDiagnostic(
				"Malformed live event was ignored after protocol validation failed",
				attachment.snapshot.id,
			);
		}
	}

	async #releaseLease(attachment: Attachment): Promise<void> {
		if (attachment.leaseReleased) return;
		attachment.leaseReleased = true;
		for (const unsubscribe of attachment.unsubscribes) unsubscribe();
		await attachment.lease.dispose().catch(() => {
			if (attachment.disconnectedReason === undefined) {
				this.#publishDiagnostic("PiClient lease cleanup failed", attachment.snapshot.id);
			}
		});
	}

	async #releaseAttachment(): Promise<void> {
		this.#clearPrompts();
		const attachment = this.#attachment;
		if (attachment === undefined) return;
		this.#attachment = undefined;
		await this.#releaseLease(attachment);
		this.#publish({
			_tag: "released",
			sequence: this.#nextSequence(),
			sessionId: attachment.snapshot.id,
		});
	}

	#controlsOf(attachment: Attachment): LiveSessionControls {
		const models = (this.#client.snapshot?.models ?? [])
			.filter((candidate: ModelMetadata) => candidate.authenticated)
			.map((candidate: ModelMetadata) => ({
				model: {provider: candidate.provider, id: candidate.id},
				name: candidate.name,
				supportedThinkingLevels: [...candidate.supportedThinkingLevels],
			}));
		const selected = models.find((candidate) =>
			sameModel(candidate.model, attachment.snapshot.model),
		);
		const thinkingLevels = selected?.supportedThinkingLevels ?? [];
		const owned =
			attachment.disconnectedReason === undefined &&
			this.#client.connected &&
			!attachment.leaseReleased &&
			attachment.lease.active;
		const idleAvailable =
			owned &&
			attachment.snapshot.phase === "idle" &&
			!this.#pendingReplacement &&
			!this.#pendingIdleControl &&
			this.#pendingPrompts === 0;
		return {
			create: idleAvailable,
			open: idleAvailable,
			steer: owned && !this.#pendingReplacement && attachment.snapshot.phase === "turn",
			abort: owned && !this.#pendingReplacement && attachment.snapshot.phase !== "idle",
			setModel: idleAvailable && models.length > 0,
			setThinking: idleAvailable && thinkingLevels.length > 0,
			models,
			thinkingLevels: [...thinkingLevels],
		};
	}

	#attachedViewOf(attachment: Attachment, sequence: number): AttachedLiveSession {
		return {
			_tag: "attached",
			...this.#baseViewOf(attachment, sequence),
			connection: "connected",
			ownership: "exclusive",
		};
	}

	#baseViewOf(attachment: Attachment, sequence: number) {
		return {
			sessionId: attachment.snapshot.id,
			revision: attachment.snapshot.revision,
			phase: attachment.snapshot.phase,
			model: attachment.snapshot.model,
			thinkingLevel: attachment.snapshot.thinkingLevel,
			completion: completionOf(
				attachment.snapshot,
				attachment.transcript,
				attachment.disconnectedReason !== undefined,
			),
			transcript: [...attachment.transcript],
			lastEventSequence: sequence,
			controls: this.#controlsOf(attachment),
		};
	}

	#viewOf(attachment: Attachment, sequence: number): LiveSessionView {
		if (attachment.disconnectedReason === undefined) {
			return this.#attachedViewOf(attachment, sequence);
		}
		return {
			_tag: "disconnected",
			...this.#baseViewOf(attachment, sequence),
			connection: "disconnected",
			ownership: "none",
			reason: attachment.disconnectedReason,
		};
	}

	#publishSession(attachment: Attachment): void {
		const sequence = this.#nextSequence();
		this.#publish({_tag: "session", sequence, session: this.#viewOf(attachment, sequence)});
	}

	#publishDiagnostic(message: string, sessionId: string | null): void {
		const diagnostic = resilienceDiagnostic({
			category: "protocol",
			code: "live-session-protocol-degraded",
			message,
			action: "Refresh live session truth or select another retained session",
			...(sessionId === null ? {} : {sessionId}),
		});
		this.#publish({
			_tag: "diagnostic",
			sequence: this.#nextSequence(),
			sessionId,
			message: diagnostic.message,
			diagnostic,
		});
	}

	#nextSequence(): number {
		return ++this.#sequence;
	}

	#publish(event: LiveSessionEvent): void {
		this.#events.push(event);
		if (this.#events.length > EVENT_HISTORY_LIMIT) this.#events.shift();
		for (const listener of this.#listeners) listener(event);
	}

	#serialize<A>(operation: () => Promise<A>): Promise<A> {
		const result = this.#lifecycle.then(operation, operation);
		this.#lifecycle = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
