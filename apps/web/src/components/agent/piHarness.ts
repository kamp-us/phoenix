import type {AgentChatInputBridge} from "@kampus/design";

export type PiDeliveryMode = "prompt" | "steer" | "follow_up";
export type PiStreamingBehavior = "steer" | "followUp";
export type PiProjectTrust = "approve" | "no-approve";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiCommand {
	readonly name: string;
	readonly description?: string;
	readonly source?: string;
}

export interface PiModel {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
}

export interface PiImage {
	readonly data: string;
	readonly mimeType: string;
	readonly name: string;
}

export interface PiEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface PiExtensionAnswer {
	readonly id: string;
	readonly value?: string;
	readonly confirmed?: boolean;
	readonly cancelled?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function projectTrust(value: unknown): PiProjectTrust | undefined {
	return value === "approve" || value === "no-approve" ? value : undefined;
}

function thinkingLevel(value: unknown): PiThinkingLevel | undefined {
	return value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
		? value
		: undefined;
}

function piModel(value: unknown): PiModel | undefined {
	if (!isRecord(value)) return undefined;
	const provider = text(value.provider);
	const id = text(value.id);
	if (!provider || !id) return undefined;
	return {provider, id, name: text(value.name) ?? text(value.displayName) ?? id};
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
	const response = await fetch(path, init);
	const body: unknown = await response.json().catch(() => ({}));
	if (!response.ok) {
		const message = isRecord(body) ? text(body.error) : undefined;
		throw new Error(message ?? "Pi harness is unavailable.");
	}
	return isRecord(body) ? body : {};
}

export async function loadPiState(): Promise<Record<string, unknown>> {
	const body = await request("/__pi/state");
	const state = isRecord(body.state) ? body.state : {};
	const nextProjectTrust = projectTrust(body.projectTrust);
	return {...state, ...(nextProjectTrust ? {projectTrust: nextProjectTrust} : {})};
}

export async function loadPiModels(): Promise<readonly PiModel[]> {
	const body = await request("/__pi/models");
	const data = isRecord(body.models) ? body.models : undefined;
	const models = data && Array.isArray(data.models) ? data.models : [];
	return models.flatMap((candidate) => {
		const model = piModel(candidate);
		return model ? [model] : [];
	});
}

export async function loadPiThinkingLevels(): Promise<readonly PiThinkingLevel[]> {
	const body = await request("/__pi/thinking-levels");
	const data = isRecord(body.levels) ? body.levels : undefined;
	const levels = data && Array.isArray(data.levels) ? data.levels : [];
	return levels.flatMap((candidate) => {
		const level = thinkingLevel(candidate);
		return level ? [level] : [];
	});
}

export async function loadPiCommands(): Promise<readonly PiCommand[]> {
	const body = await request("/__pi/commands");
	const data = isRecord(body.commands) ? body.commands : undefined;
	const commands = data && Array.isArray(data.commands) ? data.commands : [];
	return commands.flatMap((candidate) => {
		if (!isRecord(candidate)) return [];
		const name = text(candidate.name);
		if (!name) return [];
		const description = text(candidate.description);
		const source = text(candidate.source);
		return [
			{
				name,
				...(description ? {description} : {}),
				...(source ? {source} : {}),
			},
		];
	});
}

export async function loadPiFiles(query: string): Promise<readonly string[]> {
	const body = await request(`/__pi/files?q=${encodeURIComponent(query)}`);
	return Array.isArray(body.files)
		? body.files.filter((entry): entry is string => typeof entry === "string")
		: [];
}

export async function setPiModel(model: PiModel): Promise<void> {
	await request("/__pi/model", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({provider: model.provider, modelId: model.id}),
	});
}

export async function setPiThinkingLevel(level: PiThinkingLevel): Promise<void> {
	await request("/__pi/thinking-level", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({level}),
	});
}

export async function setPiProjectTrust(projectTrust: PiProjectTrust): Promise<void> {
	await request("/__pi/project-trust", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({projectTrust}),
	});
}

export async function sendPiPrompt({
	type,
	message,
	images,
	streamingBehavior,
}: {
	readonly type: PiDeliveryMode;
	readonly message: string;
	readonly images?: readonly PiImage[];
	readonly streamingBehavior?: PiStreamingBehavior;
}): Promise<void> {
	await request("/__pi/prompt", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({
			type,
			message,
			...(images && images.length > 0 ? {images} : {}),
			...(streamingBehavior ? {streamingBehavior} : {}),
		}),
	});
}

export async function abortPi(): Promise<void> {
	await request("/__pi/abort", {method: "POST"});
}

export async function answerPiExtension(answer: PiExtensionAnswer): Promise<void> {
	await request("/__pi/extension-response", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(answer),
	});
}

export function subscribeToPiEvents(
	onEvent: (event: PiEvent) => void,
	onError: () => void,
): () => void {
	if (typeof EventSource === "undefined") return () => undefined;
	const source = new EventSource("/__pi/events");
	source.onmessage = (message) => {
		try {
			const event: unknown = JSON.parse(message.data);
			if (isRecord(event) && typeof event.type === "string") onEvent(event as PiEvent);
		} catch {
			// A malformed dev-only event cannot make the chat input unusable.
		}
	};
	source.onerror = () => {
		onError();
		source.close();
	};
	return () => source.close();
}

/** The local browser transport stays app-owned; the shared composer receives it explicitly. */
export const agentChatInputBridge: AgentChatInputBridge = {
	loadPiState,
	loadPiCommands,
	loadPiModels,
	loadPiThinkingLevels,
	loadPiFiles,
	setPiModel,
	setPiThinkingLevel,
	setPiProjectTrust,
	sendPiPrompt,
	abortPi,
	answerPiExtension,
	subscribeToPiEvents,
};
