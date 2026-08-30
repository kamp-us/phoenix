import {Option, Schema} from "effect";
import type {DiscoveredSession, DiscoveryOutcome, DiscoveryProblem} from "../shared/discovery.js";
import {
	type LineageProjection,
	LineageProjection as LineageProjectionSchema,
} from "../shared/lineage.js";
import {
	type AttachedLiveSession,
	type AttachLiveSessionOutcome,
	type ControlLiveSessionOutcome,
	ControlLiveSessionOutcome as ControlLiveSessionOutcomeSchema,
	type LiveSessionControlCommand,
	type LiveSessionEvent,
	type LiveSessionView,
	type LiveTranscriptEntry,
	type ModelRef,
	type PromptLiveSessionOutcome,
	type ReleaseLiveSessionOutcome,
	ReleaseLiveSessionOutcome as ReleaseLiveSessionOutcomeSchema,
	type ThinkingLevel,
	type TranscriptContent,
} from "../shared/live-session.js";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null;

const isProblem = (value: unknown): value is DiscoveryProblem =>
	isRecord(value) && typeof value.source === "string" && typeof value.message === "string";

const isSession = (value: unknown): value is DiscoveredSession =>
	isRecord(value) &&
	typeof value.identity === "string" &&
	typeof value.piSessionId === "string" &&
	typeof value.createdAt === "number" &&
	typeof value.updatedAt === "number" &&
	typeof value.cwd === "string" &&
	typeof value.sourceFile === "string" &&
	(value.parentSessionId === undefined || typeof value.parentSessionId === "string");

const decodeDiscoveryOutcome = (value: unknown): DiscoveryOutcome | undefined => {
	if (!isRecord(value) || typeof value._tag !== "string") return undefined;
	if (value._tag === "ready") {
		return Array.isArray(value.sessions) && value.sessions.every(isSession)
			? (value as DiscoveryOutcome)
			: undefined;
	}
	if (value._tag === "empty") {
		return Array.isArray(value.sessions) && value.sessions.length === 0
			? (value as DiscoveryOutcome)
			: undefined;
	}
	if (value._tag === "partial-source") {
		return Array.isArray(value.sessions) &&
			value.sessions.every(isSession) &&
			Array.isArray(value.problems) &&
			value.problems.every(isProblem)
			? (value as DiscoveryOutcome)
			: undefined;
	}
	if (value._tag === "transport") {
		return typeof value.message === "string" && typeof value.retryable === "boolean"
			? (value as DiscoveryOutcome)
			: undefined;
	}
	if (value._tag === "fatal") {
		return typeof value.message === "string" &&
			Array.isArray(value.problems) &&
			value.problems.every(isProblem)
			? (value as DiscoveryOutcome)
			: undefined;
	}
	return undefined;
};

const transcriptStatuses = new Set(["complete", "streaming", "running", "error", "aborted"]);
const completionStates = new Set([
	"idle",
	"running",
	"complete",
	"error",
	"aborted",
	"disconnected",
]);
const sessionPhases = new Set(["idle", "turn", "compaction", "branch_summary", "retry"]);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const isTranscriptContent = (value: unknown): value is TranscriptContent => {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return typeof value.text === "string";
	if (value.type === "image") {
		return typeof value.data === "string" && typeof value.mimeType === "string";
	}
	if (value.type === "thinking") {
		return (
			typeof value.thinking === "string" &&
			(value.redacted === undefined || typeof value.redacted === "boolean")
		);
	}
	if (value.type === "toolCall") {
		return (
			typeof value.toolCallId === "string" &&
			typeof value.toolName === "string" &&
			Object.hasOwn(value, "input")
		);
	}
	return false;
};

const isTranscriptEntry = (value: unknown): value is LiveTranscriptEntry =>
	isRecord(value) &&
	typeof value.id === "string" &&
	(value.role === "user" || value.role === "assistant" || value.role === "tool") &&
	Array.isArray(value.content) &&
	value.content.every(isTranscriptContent) &&
	typeof value.timestamp === "number" &&
	typeof value.status === "string" &&
	transcriptStatuses.has(value.status);

const isLiveSessionBase = (value: Readonly<Record<string, unknown>>): boolean =>
	typeof value.sessionId === "string" &&
	typeof value.revision === "number" &&
	typeof value.phase === "string" &&
	sessionPhases.has(value.phase) &&
	isRecord(value.model) &&
	typeof value.model.provider === "string" &&
	typeof value.model.id === "string" &&
	typeof value.thinkingLevel === "string" &&
	thinkingLevels.has(value.thinkingLevel) &&
	typeof value.completion === "string" &&
	completionStates.has(value.completion) &&
	Array.isArray(value.transcript) &&
	value.transcript.every(isTranscriptEntry) &&
	typeof value.lastEventSequence === "number";

export const decodeLiveSession = (value: unknown): LiveSessionView | undefined => {
	if (!isRecord(value) || !isLiveSessionBase(value)) return undefined;
	if (
		value._tag === "attached" &&
		value.connection === "connected" &&
		value.ownership === "exclusive"
	) {
		return value as AttachedLiveSession;
	}
	if (
		value._tag === "disconnected" &&
		value.connection === "disconnected" &&
		value.ownership === "none" &&
		typeof value.reason === "string"
	) {
		return value as LiveSessionView;
	}
	return undefined;
};

const attachCodes = new Set([
	"lease-refused",
	"disconnected",
	"not-found",
	"persistence",
	"timeout",
	"protocol",
]);
export const decodeAttachOutcome = (value: unknown): AttachLiveSessionOutcome | undefined => {
	if (!isRecord(value)) return undefined;
	if (value._tag === "attached") {
		const session = decodeLiveSession(value.session);
		return session?._tag === "attached" ? {_tag: "attached", session} : undefined;
	}
	if (
		value._tag === "refused" &&
		typeof value.sessionId === "string" &&
		typeof value.code === "string" &&
		attachCodes.has(value.code) &&
		typeof value.reason === "string"
	) {
		return value as AttachLiveSessionOutcome;
	}
	return undefined;
};

const promptCodes = new Set(["no-attachment", "lease-refused", "disconnected", "protocol"]);
export const decodePromptOutcome = (value: unknown): PromptLiveSessionOutcome | undefined => {
	if (!isRecord(value) || typeof value.correlationId !== "string") return undefined;
	if (value._tag === "acknowledged") {
		const session = decodeLiveSession(value.session);
		return session?._tag === "attached"
			? {_tag: "acknowledged", correlationId: value.correlationId, session}
			: undefined;
	}
	if (
		value._tag === "refused" &&
		typeof value.code === "string" &&
		promptCodes.has(value.code) &&
		typeof value.reason === "string"
	) {
		return value as PromptLiveSessionOutcome;
	}
	return undefined;
};

export const bindAttachOutcome = (
	sessionId: string,
	outcome: AttachLiveSessionOutcome,
): AttachLiveSessionOutcome => {
	const responseSessionId =
		outcome._tag === "attached" ? outcome.session.sessionId : outcome.sessionId;
	return responseSessionId === sessionId
		? outcome
		: {
				_tag: "refused",
				sessionId,
				code: "protocol",
				reason: "Bağlanma yanıtı istenen oturumla eşleşmedi.",
			};
};

export const bindPromptOutcome = (
	sessionId: string,
	correlationId: string,
	outcome: PromptLiveSessionOutcome,
): PromptLiveSessionOutcome => {
	const matchesCorrelation = outcome.correlationId === correlationId;
	const matchesSession = outcome._tag === "refused" || outcome.session.sessionId === sessionId;
	return matchesCorrelation && matchesSession
		? outcome
		: {
				_tag: "refused",
				correlationId,
				code: "protocol",
				reason: "Gönderim yanıtı istek kimliğiyle eşleşmedi.",
			};
};

export const decodeControlOutcome = (value: unknown): ControlLiveSessionOutcome | undefined =>
	Option.getOrUndefined(Schema.decodeUnknownOption(ControlLiveSessionOutcomeSchema)(value));

export const bindControlOutcome = (
	command: LiveSessionControlCommand,
	correlationId: string,
	outcome: ControlLiveSessionOutcome,
	expectedSessionId?: string,
): ControlLiveSessionOutcome => {
	const matchesSession =
		expectedSessionId === undefined ||
		outcome.session === null ||
		outcome.session.sessionId === expectedSessionId;
	return outcome.command === command && outcome.correlationId === correlationId && matchesSession
		? outcome
		: {
				_tag: "refused",
				command,
				correlationId,
				code: "protocol",
				reason: "Denetim yanıtı istek kimliği ve oturumla eşleşmedi.",
				session: null,
			};
};

export const decodeLiveEvent = (value: unknown): LiveSessionEvent | undefined => {
	if (!isRecord(value) || typeof value._tag !== "string" || typeof value.sequence !== "number") {
		return undefined;
	}
	if (value._tag === "session") {
		const session = decodeLiveSession(value.session);
		return session === undefined ? undefined : {_tag: "session", sequence: value.sequence, session};
	}
	if (value._tag === "prompt") {
		const outcome = decodePromptOutcome(value.outcome);
		return outcome === undefined ? undefined : {_tag: "prompt", sequence: value.sequence, outcome};
	}
	if (value._tag === "control") {
		const outcome = decodeControlOutcome(value.outcome);
		return outcome === undefined ? undefined : {_tag: "control", sequence: value.sequence, outcome};
	}
	if (value._tag === "released" && typeof value.sessionId === "string") {
		return {_tag: "released", sequence: value.sequence, sessionId: value.sessionId};
	}
	if (
		value._tag === "diagnostic" &&
		(value.sessionId === null || typeof value.sessionId === "string") &&
		typeof value.message === "string"
	) {
		return value as LiveSessionEvent;
	}
	return undefined;
};

interface FateOperation {
	readonly id: string;
	readonly kind: "query" | "mutation";
	readonly name: string;
	readonly input?: unknown;
}

const runFate = async (operation: FateOperation): Promise<unknown> => {
	const response = await fetch("/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({
			version: 1,
			operations: [{...operation, select: []}],
		}),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || body.version !== 1 || !Array.isArray(body.results)) {
		throw new Error("Fate yanıtı okunamadı");
	}
	const result = body.results.find(
		(candidate) => isRecord(candidate) && candidate.id === operation.id,
	);
	if (!isRecord(result) || result.ok !== true) throw new Error("Fate işlemi reddedildi");
	return result.data;
};

export const discoverSessions = async (): Promise<DiscoveryOutcome> => {
	const outcome = decodeDiscoveryOutcome(
		await runFate({id: "discovery", kind: "query", name: "discovery"}),
	);
	if (outcome === undefined) throw new Error("Oturum keşfi okunamayan bir yanıt döndürdü");
	return outcome;
};

export const decodeLineageProjection = (value: unknown): LineageProjection | undefined =>
	Option.getOrUndefined(Schema.decodeUnknownOption(LineageProjectionSchema)(value));

export const readLineage = async (): Promise<LineageProjection> => {
	const projection = decodeLineageProjection(
		await runFate({id: "lineage", kind: "query", name: "lineage"}),
	);
	if (projection === undefined) throw new Error("Oturum bağları okunamayan bir yanıt döndürdü");
	return projection;
};

export const attachLiveSession = async (sessionId: string): Promise<AttachLiveSessionOutcome> => {
	const outcome = decodeAttachOutcome(
		await runFate({
			id: "attach",
			kind: "mutation",
			name: "liveSession.attach",
			input: {sessionId},
		}),
	);
	if (outcome === undefined) throw new Error("Bağlanma yanıtı okunamadı");
	return bindAttachOutcome(sessionId, outcome);
};

export const promptLiveSession = async (
	sessionId: string,
	correlationId: string,
	text: string,
): Promise<PromptLiveSessionOutcome> => {
	const outcome = decodePromptOutcome(
		await runFate({
			id: "prompt",
			kind: "mutation",
			name: "liveSession.prompt",
			input: {correlationId, text},
		}),
	);
	if (outcome === undefined) throw new Error("Gönderim yanıtı okunamadı");
	return bindPromptOutcome(sessionId, correlationId, outcome);
};

const controlLiveSession = async (
	command: LiveSessionControlCommand,
	name: string,
	input: Readonly<Record<string, unknown>>,
	expectedSessionId?: string,
): Promise<ControlLiveSessionOutcome> => {
	const correlationId = String(input.correlationId ?? "");
	const outcome = decodeControlOutcome(await runFate({id: command, kind: "mutation", name, input}));
	if (outcome === undefined) throw new Error("Denetim yanıtı okunamadı");
	return bindControlOutcome(command, correlationId, outcome, expectedSessionId);
};

export const createLiveSession = (correlationId: string, cwd: string) =>
	controlLiveSession("create", "liveSession.create", {correlationId, cwd});

export const openLiveSession = (correlationId: string, sessionId: string) =>
	controlLiveSession("open", "liveSession.open", {correlationId, sessionId}, sessionId);

export const steerLiveSession = (sessionId: string, correlationId: string, text: string) =>
	controlLiveSession("steer", "liveSession.steer", {correlationId, text}, sessionId);

export const abortLiveSession = (sessionId: string, correlationId: string) =>
	controlLiveSession("abort", "liveSession.abort", {correlationId}, sessionId);

export const setModelLiveSession = (sessionId: string, correlationId: string, model: ModelRef) =>
	controlLiveSession("set-model", "liveSession.setModel", {correlationId, model}, sessionId);

export const setThinkingLiveSession = (
	sessionId: string,
	correlationId: string,
	thinkingLevel: ThinkingLevel,
) =>
	controlLiveSession(
		"set-thinking",
		"liveSession.setThinking",
		{correlationId, thinkingLevel},
		sessionId,
	);

export const decodeReleaseOutcome = (value: unknown): ReleaseLiveSessionOutcome | undefined =>
	Option.getOrUndefined(Schema.decodeUnknownOption(ReleaseLiveSessionOutcomeSchema)(value));

export const bindReleaseOutcome = (
	expectedSessionId: string,
	outcome: ReleaseLiveSessionOutcome,
): ReleaseLiveSessionOutcome =>
	outcome.sessionId === expectedSessionId ||
	(outcome._tag === "released" && outcome.sessionId === null)
		? outcome
		: {
				_tag: "failed",
				sessionId: expectedSessionId,
				code: "protocol",
				reason: "Bırakma yanıtı seçili oturumla eşleşmedi.",
			};

export const releaseLiveSession = async (sessionId: string): Promise<ReleaseLiveSessionOutcome> => {
	const outcome = decodeReleaseOutcome(
		await runFate({id: "release", kind: "mutation", name: "liveSession.release", input: {}}),
	);
	if (outcome === undefined) throw new Error("Bırakma yanıtı okunamadı");
	return bindReleaseOutcome(sessionId, outcome);
};
