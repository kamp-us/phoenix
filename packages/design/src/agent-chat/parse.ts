import type {
	PiCommand,
	PiDeliveryMode,
	PiEvent,
	PiModel,
	PiProjectTrust,
	PiThinkingLevel,
} from "../agent-chat-bridge";
import type {Completion, ExtensionRequest} from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

export function booleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

export function deliveryMode(value: string | undefined): PiDeliveryMode | undefined {
	return value === "prompt" || value === "steer" || value === "follow_up" ? value : undefined;
}

export function projectTrustValue(value: unknown): PiProjectTrust | undefined {
	return value === "approve" || value === "no-approve" ? value : undefined;
}

export function thinkingLevelValue(value: unknown): PiThinkingLevel | undefined {
	return value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max" ||
		value === "ultra"
		? value
		: undefined;
}

export function modelValue(model: Pick<PiModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Two providers can offer the same display name, and then the name alone names two rows. The
 * provider is the fact that tells them apart, so it rides every row once a second one is offered.
 */
export function providersCollide(models: readonly PiModel[]): boolean {
	return new Set(models.map((model) => model.provider)).size > 1;
}

/** A pushed command catalog, admitted row by row. A malformed push leaves the held list alone. */
export function commandList(value: unknown): readonly PiCommand[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const rows: PiCommand[] = [];
	for (const row of value) {
		if (!isRecord(row)) return undefined;
		const name = stringValue(row, "name");
		if (!name) return undefined;
		const description = stringValue(row, "description");
		const source = stringValue(row, "source");
		rows.push({name, ...(description ? {description} : {}), ...(source ? {source} : {})});
	}
	return rows;
}

/** A pushed model catalog, admitted row by row. A malformed push leaves the held list alone. */
export function modelList(value: unknown): readonly PiModel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const rows: PiModel[] = [];
	for (const row of value) {
		if (!isRecord(row)) return undefined;
		const provider = stringValue(row, "provider");
		const id = stringValue(row, "id");
		const name = stringValue(row, "name");
		if (!provider || !id || !name) return undefined;
		rows.push({provider, id, name});
	}
	return rows;
}

/**
 * A pushed level set, admitted row by row like the model catalog. `off` is dropped for the reason
 * the mount-time load drops it: it is not a row this picker selects.
 */
export function thinkingLevelList(value: unknown): readonly PiThinkingLevel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const levels: PiThinkingLevel[] = [];
	for (const row of value) {
		const level = thinkingLevelValue(row);
		if (!level) return undefined;
		if (level !== "off") levels.push(level);
	}
	return levels;
}

export function selectedModelValue(state: Record<string, unknown> | undefined): string | undefined {
	const model = state && isRecord(state.model) ? state.model : undefined;
	if (!model) return undefined;
	const provider = stringValue(model, "provider");
	const id = stringValue(model, "id");
	return provider && id ? modelValue({provider, id}) : undefined;
}

export function completionFor(draft: string): Completion | undefined {
	const match = /(?:^|\s)([/@])([^\s]*)$/.exec(draft);
	if (!match) return undefined;
	const sigil = match[1];
	const query = match[2] ?? "";
	if (!sigil) return undefined;
	const start = draft.length - match[0].length + match[0].lastIndexOf(sigil);
	return {kind: sigil === "/" ? "command" : "file", query, start, end: draft.length};
}

export function modelName(state: Record<string, unknown> | undefined): string | undefined {
	const model = state && isRecord(state.model) ? state.model : undefined;
	if (!model) return undefined;
	return (
		stringValue(model, "displayName") ?? stringValue(model, "name") ?? stringValue(model, "id")
	);
}

/** The running model as the status line names it: bare name, or name + provider once two collide. */
export function runningModelLabel(
	state: Record<string, unknown> | undefined,
	models: readonly PiModel[],
): string | undefined {
	const name = modelName(state);
	if (!name || !providersCollide(models)) return name;
	const model = state && isRecord(state.model) ? state.model : undefined;
	const provider = model && stringValue(model, "provider");
	return provider ? `${name} (${provider})` : name;
}

export function assistantMessageText(value: unknown): string | undefined {
	if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content))
		return undefined;
	const text = value.content.flatMap((block) => {
		if (!isRecord(block)) return [];
		const value = stringValue(block, "text");
		return value ? [value] : [];
	});
	return text.length > 0 ? text.join("") : undefined;
}

export function extensionRequest(
	event: PiEvent,
	fallbackTitle: string,
): ExtensionRequest | undefined {
	if (event.type !== "extension_ui_request") return undefined;
	const id = stringValue(event, "id");
	const rawMethod = stringValue(event, "method");
	const title = stringValue(event, "title") ?? fallbackTitle;
	if (!id || !rawMethod) return undefined;
	if (
		rawMethod !== "select" &&
		rawMethod !== "confirm" &&
		rawMethod !== "input" &&
		rawMethod !== "editor"
	) {
		return undefined;
	}
	const options = Array.isArray(event.options)
		? event.options.filter((option): option is string => typeof option === "string")
		: undefined;
	return {
		id,
		method: rawMethod,
		title,
		...(stringValue(event, "message") ? {message: stringValue(event, "message")} : {}),
		...(options && options.length > 0 ? {options} : {}),
		...(stringValue(event, "placeholder") ? {placeholder: stringValue(event, "placeholder")} : {}),
		...(stringValue(event, "prefill") ? {prefill: stringValue(event, "prefill")} : {}),
	};
}
