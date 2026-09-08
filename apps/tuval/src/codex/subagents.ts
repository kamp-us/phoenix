import {Schema} from "effect";
import type {AgentEvent} from "../ai-agent/events.ts";
import {ItemId, type SubagentSlot, type TranscriptItem} from "../ai-agent/ports/index.ts";
import type {ChildTranscript} from "./child-store.ts";
import {historyItem, LiveTranscript} from "./history.ts";

// codex-cli 0.153.4 generate-ts: ThreadItem, CollabAgentState and SubAgentActivityKind.
export const Collab = Schema.Struct({
	type: Schema.Literal("collabAgentToolCall"),
	id: Schema.String,
	tool: Schema.Literals([
		"spawnAgent",
		"sendInput",
		"resumeAgent",
		"wait",
		"closeAgent",
		"sendMessage",
		"followupTask",
		"interruptAgent",
		"listAgents",
	]),
	status: Schema.Literals(["inProgress", "completed", "failed", "interrupted"]),
	senderThreadId: Schema.String,
	receiverThreadIds: Schema.Array(Schema.String),
	prompt: Schema.NullOr(Schema.String),
	agentsStates: Schema.Record(
		Schema.String,
		Schema.Struct({
			status: Schema.Literals([
				"pendingInit",
				"running",
				"interrupted",
				"completed",
				"errored",
				"shutdown",
				"notFound",
			]),
			message: Schema.NullOr(Schema.String),
		}),
	),
});
export const Activity = Schema.Struct({
	type: Schema.Literal("subAgentActivity"),
	id: Schema.String,
	kind: Schema.Literals(["started", "interacted", "interrupted", "completed"]),
	agentThreadId: Schema.String,
});
const lineOf = (item: TranscriptItem): string =>
	item.kind === "tool" ? item.result.text || item.name : item.text;
const event = (slot: SubagentSlot): AgentEvent => ({kind: "subagent", slot});

interface Child {
	readonly call: string;
	readonly transcript: LiveTranscript;
	readonly versions: Map<string, "snapshot" | TranscriptItem>;
	turnId: string | null;
}

/** Backend child ids stay here; the shared stream carries only spawning-call identities. */
export class NativeSubagents {
	readonly slots = new Map<string, SubagentSlot>();
	readonly children = new Map<string, Child>();

	collab(raw: unknown, parent: string, at: number): ReadonlyArray<AgentEvent> {
		const value = Schema.decodeUnknownSync(Collab)(raw);
		if (value.senderThreadId !== parent) throw new Error("Codex child call has a foreign sender");
		const touched = new Set<string>();
		const notices: Array<AgentEvent> = [];
		if (value.tool === "spawnAgent") {
			if (value.receiverThreadIds.length > 1)
				throw new Error("Unsupported Codex spawn: multiple children for one spawning call");
			const previous = this.slots.get(value.id);
			this.slots.set(
				value.id,
				previous ?? {
					id: ItemId.make(value.id),
					type: "agent",
					lastLine: "",
					startedAt: at,
					tokens: 0,
					items: [],
					status: "running",
				},
			);
			touched.add(value.id);
			for (const id of value.receiverThreadIds) {
				if ([...this.children].some(([known, child]) => child.call === value.id && known !== id))
					throw new Error("Codex spawning call changed its child identity");
				const child = this.children.get(id);
				if (child !== undefined && child.call !== value.id)
					throw new Error("Codex child belongs to another spawning call");
				if (child === undefined)
					this.children.set(id, {
						call: value.id,
						transcript: new LiveTranscript(),
						versions: new Map(),
						turnId: null,
					});
			}
			if (
				value.status === "failed" ||
				value.status === "interrupted" ||
				(value.status === "completed" && value.receiverThreadIds.length === 0)
			)
				this.finishCall(value.id, `Spawn ${value.status}`);
		}
		for (const id of value.receiverThreadIds) {
			const child = this.children.get(id);
			if (child === undefined) {
				notices.push({
					kind: "item",
					item: {
						kind: "system",
						id: ItemId.make(`${value.id}/unsupported`),
						timestamp: at,
						text: "Unsupported child update: no spawning call is available",
					},
				});
				continue;
			}
			const slot = this.slots.get(child.call);
			if (slot === undefined) continue;
			const state = value.agentsStates[id];
			if (state !== undefined) {
				this.slots.set(child.call, {
					...slot,
					status:
						state.status === "running" || state.status === "pendingInit" ? "running" : "finished",
					lastLine:
						state.message ??
						(state.status === "running" || state.status === "pendingInit"
							? slot.lastLine
							: state.status),
				});
			} else if (
				value.status === "completed" &&
				(value.tool === "closeAgent" || value.tool === "interruptAgent")
			) {
				this.finishCall(child.call, value.tool === "closeAgent" ? "shutdown" : "interrupted");
			}
			touched.add(child.call);
		}
		return [
			...notices,
			...[...touched].flatMap((id) => {
				const slot = this.slots.get(id);
				return slot === undefined ? [] : [event(slot)];
			}),
		];
	}

	hydrate(id: string, transcript: ChildTranscript): AgentEvent | null {
		const child = this.children.get(id);
		const slot = child === undefined ? undefined : this.slots.get(child.call);
		if (slot === undefined || child === undefined) return null;
		child.turnId = transcript.turnId;
		const items: Array<TranscriptItem> = transcript.items.map((snapshot) => {
			const version = child.versions.get(snapshot.id);
			const item = version === undefined || version === "snapshot" ? snapshot : version;
			if (version === undefined) child.versions.set(item.id, "snapshot");
			child.transcript.items.delete(item.id);
			const tagged = {...item, id: ItemId.make(`${slot.id}/${item.id}`), parentId: slot.id};
			const previous = slot.items.find((row) => row.id === tagged.id);
			return previous === undefined ? tagged : {...tagged, timestamp: previous.timestamp};
		});
		for (const previous of slot.items) {
			const id = previous.id.slice(slot.id.length + 1);
			const version = child.versions.get(id);
			if (
				!items.some((item) => item.id === previous.id) &&
				(child.transcript.items.has(id) || (version !== undefined && version !== "snapshot"))
			)
				items.push(previous);
		}
		const last = items.at(-1);
		const next = {
			...slot,
			items,
			type: transcript.type,
			status: transcript.status,
			lastLine: last === undefined ? slot.lastLine : lineOf(last),
		};
		this.slots.set(slot.id, next);
		return event(next);
	}

	item(id: string, raw: unknown, at: number, partial: boolean): AgentEvent | null {
		const child = this.children.get(id);
		if (child === undefined) return null;
		const item = historyItem(raw, at, partial);
		if (partial || (item.kind === "tool" && item.status === "running")) {
			if (child.versions.has(item.id) || this.slots.get(child.call)?.status === "finished")
				return null;
			child.transcript.item(raw, at, partial);
		} else {
			child.versions.set(item.id, item);
			child.transcript.items.delete(item.id);
		}
		const update = this.upsert(id, item);
		if (item.kind === "tool" && item.name === "spawnAgent")
			return this.upsert(id, {
				kind: "system",
				id: ItemId.make(`${item.id}/unsupported`),
				timestamp: at,
				text: "Recursive child navigation is unsupported; this spawn remains in its parent's transcript",
			});
		return update;
	}

	needsSnapshot(id: string, itemId: string): boolean {
		const child = this.children.get(id);
		return child?.versions.get(itemId) === "snapshot";
	}

	delta(id: string, itemId: string, text: string): AgentEvent | null {
		const child = this.children.get(id);
		if (child === undefined || this.slots.get(child.call)?.status === "finished") return null;
		const item = child.transcript.delta(itemId, text);
		return item == null ? null : this.upsert(id, item);
	}

	upsert(id: string, item: TranscriptItem): AgentEvent | null {
		const child = this.children.get(id);
		const slot = child === undefined ? undefined : this.slots.get(child.call);
		if (slot === undefined) return null;
		const tagged = {...item, id: ItemId.make(`${slot.id}/${item.id}`), parentId: slot.id};
		const previous = slot.items.find((row) => row.id === tagged.id);
		const stable = previous === undefined ? tagged : {...tagged, timestamp: previous.timestamp};
		const items =
			previous === undefined
				? [...slot.items, stable]
				: slot.items.map((row) => (row.id === stable.id ? stable : row));
		const next = {...slot, items, lastLine: lineOf(stable) || slot.lastLine};
		this.slots.set(slot.id, next);
		return event(next);
	}

	status(id: string, status: SubagentSlot["status"], line?: string): AgentEvent | null {
		const child = this.children.get(id);
		const slot = child === undefined ? undefined : this.slots.get(child.call);
		if (slot === undefined) return null;
		const next = {...slot, status, ...(line === undefined ? {} : {lastLine: line})};
		this.slots.set(slot.id, next);
		return event(next);
	}

	usage(id: string, tokens: number): AgentEvent | null {
		const child = this.children.get(id);
		const slot = child === undefined ? undefined : this.slots.get(child.call);
		if (slot === undefined || !Number.isSafeInteger(tokens) || tokens < 0) return null;
		const next = {...slot, tokens: Math.max(slot.tokens, tokens)};
		this.slots.set(slot.id, next);
		return event(next);
	}

	finishCall(call: string, line: string, interrupted = true): AgentEvent | null {
		for (const child of this.children.values()) {
			if (child.call === call) child.transcript.items.clear();
		}
		const slot = this.slots.get(call);
		if (slot === undefined) return null;
		const items = slot.items.map((item): TranscriptItem => {
			if ((item.kind === "assistant" || item.kind === "thinking") && item.partial) {
				const {partial: _, ...final} = item;
				return final.kind === "assistant" && interrupted ? {...final, interrupted: true} : final;
			}
			return item.kind === "tool" && item.status === "running" ? {...item, status: "error"} : item;
		});
		const next: SubagentSlot = {
			...slot,
			items,
			status: "finished",
			lastLine: line || slot.lastLine,
		};
		this.slots.set(call, next);
		return event(next);
	}

	finish(line: string): ReadonlyArray<AgentEvent> {
		return [...this.slots.values()].flatMap((slot) => {
			if (slot.status === "finished") return [];
			const ended = this.finishCall(slot.id, line);
			return ended === null ? [] : [ended];
		});
	}
}
