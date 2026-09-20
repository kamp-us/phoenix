import {Schema} from "effect";
import {boundToolResult, ItemId, type TranscriptItem} from "../ai-agent/ports/index.ts";
import {WireItem} from "./protocol.ts";

const Text = Schema.Struct({text: Schema.String});
const User = Schema.Struct({content: Schema.Array(Schema.JsonObject)});
const Reasoning = Schema.Struct({
	summary: Schema.Array(Schema.String),
	content: Schema.Array(Schema.String),
});
const Command = Schema.Struct({
	command: Schema.String,
	cwd: Schema.String,
	status: Schema.String,
	aggregatedOutput: Schema.NullOr(Schema.String),
});
const Tool = Schema.Struct({tool: Schema.String, arguments: Schema.Json, status: Schema.String});
const Change = Schema.Struct({changes: Schema.Json, status: Schema.String});
const read = <A>(schema: Schema.Codec<A>, value: unknown): A =>
	Schema.decodeUnknownSync(schema)(value);
const toolStatus = (status: string) =>
	status === "inProgress" ? "running" : status === "completed" ? "ok" : "error";

export const historyItem = (raw: unknown, timestamp: number, partial = false): TranscriptItem => {
	const head = read(WireItem, raw);
	const base = {id: ItemId.make(head.id), timestamp};
	switch (head.type) {
		case "userMessage": {
			const {content} = read(User, raw);
			return {
				...base,
				kind: "user",
				text: content
					.map((part) =>
						part.type === "text" && typeof part.text === "string"
							? part.text
							: `[${part.type ?? "attachment"}]`,
					)
					.join("\n"),
			};
		}
		case "agentMessage":
		case "plan":
			return {
				...base,
				kind: "assistant",
				text: read(Text, raw).text,
				...(partial ? {partial: true} : {}),
			};
		case "reasoning": {
			const value = read(Reasoning, raw);
			return {
				...base,
				kind: "thinking",
				text: (value.summary.length > 0 ? value.summary : value.content).join("\n\n"),
			};
		}
		case "commandExecution": {
			const value = read(Command, raw);
			return {
				...base,
				kind: "tool",
				name: "shell",
				input: {command: value.command, cwd: value.cwd},
				status: toolStatus(value.status),
				result: boundToolResult(value.aggregatedOutput ?? ""),
			};
		}
		case "fileChange": {
			const value = read(Change, raw);
			return {
				...base,
				kind: "tool",
				name: "apply_patch",
				input: value.changes,
				status: toolStatus(value.status),
				result: boundToolResult(JSON.stringify(value.changes)),
			};
		}
		case "mcpToolCall":
		case "dynamicToolCall": {
			const value = read(Tool, raw);
			const body = read(Schema.JsonObject, raw);
			return {
				...base,
				kind: "tool",
				name: typeof body.server === "string" ? `${body.server}.${value.tool}` : value.tool,
				input: value.arguments,
				status: body.success === false ? "error" : toolStatus(value.status),
				result: boundToolResult(
					JSON.stringify(body.error ?? body.result ?? body.contentItems ?? ""),
				),
			};
		}
		case "contextCompaction":
			return {...base, kind: "compaction", text: "Context compacted"};
		case "collabAgentToolCall": {
			const value = read(
				Schema.Struct({
					tool: Schema.String,
					status: Schema.String,
					prompt: Schema.NullOr(Schema.String),
					agentsStates: Schema.Json,
				}),
				raw,
			);
			return {
				...base,
				kind: "tool",
				name: value.tool,
				input: {prompt: value.prompt},
				status: toolStatus(value.status),
				result: boundToolResult(JSON.stringify(value.agentsStates)),
			};
		}
		default:
			return {
				...base,
				kind: "system",
				text: `Codex: ${head.type}`,
				detail: boundToolResult(JSON.stringify(raw)).text,
			};
	}
};

export class LiveTranscript {
	readonly items = new Map<string, TranscriptItem>();

	item(raw: unknown, timestamp: number, partial: boolean): TranscriptItem {
		const item = historyItem(raw, timestamp, partial);
		const previous = this.items.get(item.id);
		const stable = previous === undefined ? item : {...item, timestamp: previous.timestamp};
		this.items.set(stable.id, stable);
		return stable;
	}

	delta(id: string, text: string): TranscriptItem | null {
		const previous = this.items.get(id);
		if (previous === undefined) return null;
		const item =
			previous.kind === "assistant"
				? {...previous, text: previous.text + text, partial: true}
				: previous.kind === "thinking"
					? {...previous, text: previous.text + text}
					: null;
		if (item !== null) this.items.set(id, item);
		return item;
	}

	finish(interrupted: boolean): ReadonlyArray<TranscriptItem> {
		const final: Array<TranscriptItem> = [];
		for (const item of this.items.values()) {
			if (item.kind === "assistant" && item.partial === true) {
				const {partial: _, ...rest} = item;
				final.push({...rest, ...(interrupted ? {interrupted: true} : {})});
			}
			if (item.kind === "tool" && item.status === "running") final.push({...item, status: "error"});
		}
		this.items.clear();
		return final;
	}
}
