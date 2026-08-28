import {
	type ByteTransportFactory,
	PiClient,
	PiDisconnectedError,
	PiServerError,
	type PiSessionHandle,
	PiSessionOwnershipError,
	type Unsubscribe,
} from "@earendil-works/pi-client";
import type {
	ServerEvent,
	SessionSnapshot,
	TranscriptItem,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type {
	AttachedLiveSession,
	AttachLiveSessionOutcome,
	LiveSessionEvent,
	LiveSessionView,
	LiveTranscriptEntry,
	PromptLiveSessionOutcome,
	PromptLiveSessionRequest,
	ReleaseLiveSessionOutcome,
} from "../shared/live-session.js";

const EVENT_HISTORY_LIMIT = 500;

type Listener = (event: LiveSessionEvent) => void;

interface Attachment {
	readonly lease: PiSessionHandle;
	readonly generation: number;
	readonly unsubscribes: ReadonlyArray<Unsubscribe>;
	snapshot: SessionSnapshot;
	transcript: Array<LiveTranscriptEntry>;
	disconnectedReason?: string;
	leaseReleased: boolean;
}

interface CorrelatedPrompt {
	readonly text: string;
	readonly result: Promise<PromptLiveSessionOutcome>;
}

interface PendingAttachment {
	readonly sessionId: string;
	readonly events: Array<ServerEvent>;
}

export interface LiveSessionState {
	readonly current: () => LiveSessionView | null;
	readonly attach: (sessionId: string) => Promise<AttachLiveSessionOutcome>;
	readonly prompt: (request: PromptLiveSessionRequest) => Promise<PromptLiveSessionOutcome>;
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

const appendAssistantDelta = (
	transcript: Array<LiveTranscriptEntry>,
	progress: Extract<TranscriptProgress, {type: "assistant_delta"}>,
): void => {
	const index = transcript.findIndex((item) => item.id === progress.messageId);
	const entry = transcript[index];
	if (entry === undefined || entry.role !== "assistant") return;
	const content = [...entry.content];
	const part = content[progress.contentIndex];
	if (part === undefined || part.type !== progress.kind) return;
	if (part.type === "text") {
		content[progress.contentIndex] = {...part, text: part.text + progress.delta};
	}
	if (part.type === "thinking") {
		content[progress.contentIndex] = {...part, thinking: part.thinking + progress.delta};
	}
	transcript[index] = {...entry, content};
};

const reduceProgress = (
	transcript: Array<LiveTranscriptEntry>,
	progress: TranscriptProgress,
): void => {
	if (progress.type === "assistant_delta") {
		appendAssistantDelta(transcript, progress);
		return;
	}
	replaceOrAppend(transcript, entryOf(progress.item));
};

const refusalCode = (
	error: unknown,
): "lease-refused" | "disconnected" | "not-found" | "protocol" => {
	if (error instanceof PiDisconnectedError) return "disconnected";
	if (error instanceof PiSessionOwnershipError) return "lease-refused";
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
	readonly #unsubscribeConnection: Unsubscribe;
	readonly #unsubscribeEvents: Unsubscribe;
	#attachment: Attachment | undefined;
	#pendingAttachment: PendingAttachment | undefined;
	#sequence = 0;
	#generation = 0;
	#lifecycle: Promise<void> = Promise.resolve();
	#disposed = false;

	private constructor(client: PiClient) {
		this.#client = client;
		this.#unsubscribeConnection = client.onConnectionStateChange((change) => {
			if (change.state !== "disconnected") return;
			const attachment = this.#attachment;
			if (attachment === undefined || attachment.disconnectedReason !== undefined) return;
			attachment.disconnectedReason = change.error?.message ?? "PiClient disconnected";
			this.#publishDiagnostic(attachment.disconnectedReason, attachment.snapshot.id);
			this.#publishSession(attachment);
			void this.#serialize(() => this.#releaseLease(attachment));
		});
		this.#unsubscribeEvents = client.onEvent((event) => {
			const attachment = this.#attachment;
			if (attachment !== undefined && eventSessionId(event) === attachment.snapshot.id) {
				this.#acceptEvent(attachment.generation, event);
				return;
			}
			const pending = this.#pendingAttachment;
			if (pending !== undefined && eventSessionId(event) === pending.sessionId) {
				pending.events.push(event);
			}
		});
	}

	static async connect(transportFactory: ByteTransportFactory): Promise<PiLiveSessionState> {
		return new PiLiveSessionState(await PiClient.connect({transportFactory}));
	}

	current = (): LiveSessionView | null => {
		const attachment = this.#attachment;
		return attachment === undefined ? null : this.#viewOf(attachment, this.#sequence);
	};

	attach = (sessionId: string): Promise<AttachLiveSessionOutcome> => this.#attach(sessionId);

	prompt = (request: PromptLiveSessionRequest): Promise<PromptLiveSessionOutcome> => {
		const existing = this.#prompts.get(request.correlationId);
		if (existing !== undefined) {
			if (existing.text === request.text) return existing.result;
			return Promise.resolve({
				_tag: "refused",
				correlationId: request.correlationId,
				code: "protocol",
				reason: "Correlation id was already used for a different prompt",
			});
		}
		const result = this.#runPrompt(request);
		this.#prompts.set(request.correlationId, {text: request.text, result});
		return result;
	};

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
			const pending: PendingAttachment = {sessionId, events: []};
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
				unsubscribes: [],
				leaseReleased: false,
			};
			const unsubscribes = [lease.subscribe((next) => this.#acceptSnapshot(generation, next))];
			this.#attachment = {...attachment, unsubscribes};
			if (this.#pendingAttachment === pending) this.#pendingAttachment = undefined;
			for (const event of pending.events) this.#acceptEvent(generation, event);
			this.#publishSession(this.#attachment);
			return {_tag: "attached", session: this.#attachedViewOf(this.#attachment, this.#sequence)};
		});
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
				await attachment.lease.prompt(request.text);
				if (this.#attachment?.generation !== attachment.generation) {
					throw new PiSessionOwnershipError(
						attachment.snapshot.id,
						"The selected session changed before the prompt was acknowledged",
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
		this.#publish({_tag: "prompt", sequence: this.#nextSequence(), outcome});
		return outcome;
	}

	#acceptSnapshot(generation: number, snapshot: SessionSnapshot): void {
		const attachment = this.#attachment;
		if (attachment === undefined || attachment.generation !== generation) return;
		attachment.snapshot = snapshot;
		attachment.transcript = snapshot.transcript.map(entryOf);
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
				reduceProgress(attachment.transcript, event.progress);
				this.#publishSession(attachment);
			}
			if (event.type === "session_removed") {
				attachment.disconnectedReason = "The attached pi session was removed";
				this.#publishDiagnostic(attachment.disconnectedReason, attachment.snapshot.id);
				this.#publishSession(attachment);
				void this.#serialize(() => this.#releaseLease(attachment));
			}
		} catch (error) {
			this.#publishDiagnostic(
				`Malformed live event was ignored: ${messageOf(error)}`,
				attachment.snapshot.id,
			);
		}
	}

	async #releaseLease(attachment: Attachment): Promise<void> {
		if (attachment.leaseReleased) return;
		attachment.leaseReleased = true;
		for (const unsubscribe of attachment.unsubscribes) unsubscribe();
		await attachment.lease.dispose().catch((error) => {
			if (attachment.disconnectedReason === undefined) {
				this.#publishDiagnostic(
					`PiClient lease cleanup failed: ${messageOf(error)}`,
					attachment.snapshot.id,
				);
			}
		});
	}

	async #releaseAttachment(): Promise<void> {
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
		this.#publish({_tag: "diagnostic", sequence: this.#nextSequence(), sessionId, message});
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
