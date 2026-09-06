/**
 * Pi's wire transcript → the model-blind port item union, and the events one pushed snapshot is
 * worth.
 *
 * Pure and total: every function here is a fold over values, so the whole revision-to-events
 * mapping is unit-testable without a socket, a session or a model. Pi's protocol types are
 * arguments and never results — the far side of this module is `ports/transcript-item.ts` only,
 * which is what keeps the Pi wire inside `src/pi/` (#7465).
 *
 * Grounded in `@earendil-works/pi-protocol` `dist/schemas.d.ts` at 0.84.3:
 * `TranscriptItemSchema` (the `user` / `assistant` / `tool` union), `ToolTranscriptItemSchema`
 * (`toolCallId`, `toolName`, `input`, `content`, and the `status`/`isError` pairs
 * `running`/false, `complete`/false, `error`/true), `UsageSchema` (`totalTokens`, `cost.total`)
 * and `SessionSnapshotSchema` (`revision`, `phase`, `transcript`).
 *
 * An assistant turn's `thinking` content becomes a `thinking` item of its own and never joins the
 * reply's `text` — folding reasoning into the reply would render as something the assistant never
 * said. An item's `image` parts have no port field to land in and are dropped.
 */

import type {
	TranscriptItem as PiTranscriptItem,
	SessionPhase,
	SessionSnapshot,
} from "@earendil-works/pi-protocol";
import {
	boundToolResult,
	type ItemId,
	type JsonValue,
	type ThinkingItem,
	type ToolStatus,
	type TranscriptItem,
} from "../../ai-agent/ports/index.ts";
import type {AgentEvent, Phase} from "../../ai-agent/service/index.ts";

/** `ItemId` is an opaque string brand, minted here so no call site writes its own cast. */
export const itemId = (value: string): ItemId => value as ItemId;

type PiContent = PiTranscriptItem["content"][number];

/** Only `text` parts reach a turn's own text; see the module note on `thinking` and `image`. */
const textOf = (parts: ReadonlyArray<PiContent>): string =>
	parts.reduce((text, part) => (part.type === "text" ? text + part.text : text), "");

/**
 * The reasoning row's id, derived from the turn it belongs to so the two never collide in the
 * revision projection and `entries.ts` can re-key both off one entry.
 */
export const thinkingId = (base: string): ItemId => itemId(`${base}:thinking`);

/**
 * `isError` decides `error` on its own: the wire pairs it with `status: "error"`, and reading the
 * flag rather than the literal means a status this pin does not yet ship cannot be folded to `ok`.
 */
const toolStatusOf = (item: Extract<PiTranscriptItem, {role: "tool"}>): ToolStatus => {
	if (item.isError) return "error";
	return item.status === "running" ? "running" : "ok";
};

/**
 * One wire item as the window sees it. A tool row is keyed by `toolCallId` rather than the wire's
 * own positional id, so the result that lands later supersedes the running row it belongs to
 * (founder ruling 1, #7570) and a compaction that renumbers the transcript cannot split one tool
 * call into two rows.
 */
export const itemOf = (item: PiTranscriptItem): TranscriptItem => {
	switch (item.role) {
		case "user":
			return {
				kind: "user",
				id: itemId(item.id),
				timestamp: item.timestamp,
				text: textOf(item.content),
			};
		case "assistant": {
			const text = textOf(item.content);
			return item.status === "aborted"
				? {
						kind: "assistant",
						id: itemId(item.id),
						timestamp: item.timestamp,
						text,
						interrupted: true,
					}
				: {kind: "assistant", id: itemId(item.id), timestamp: item.timestamp, text};
		}
		case "tool":
			return {
				kind: "tool",
				id: itemId(item.toolCallId),
				timestamp: item.timestamp,
				name: item.toolName,
				input: item.input as JsonValue,
				result: boundToolResult(textOf(item.content)),
				status: toolStatusOf(item),
			};
	}
};

/**
 * One turn's reasoning, joined across its `thinking` parts. A turn with none — every user and tool
 * item, and an assistant turn the provider gave no reasoning for — is no row at all rather than an
 * empty one, which is also what keeps a redacted part (`ThinkingContentSchema.redacted`, empty
 * `thinking`) from drawing a blank row.
 */
const thinkingOf = (item: PiTranscriptItem): ThinkingItem | null => {
	if (item.role !== "assistant") return null;
	const text = item.content.reduce(
		(carried, part) => (part.type === "thinking" ? carried + part.thinking : carried),
		"",
	);
	if (text === "") return null;
	return {kind: "thinking", id: thinkingId(item.id), timestamp: item.timestamp, text};
};

/** One wire item as every row it is worth: the reasoning first, then the turn that produced it. */
export const itemsOf = (item: PiTranscriptItem): ReadonlyArray<TranscriptItem> => {
	const thinking = thinkingOf(item);
	return thinking === null ? [itemOf(item)] : [thinking, itemOf(item)];
};

/**
 * Pi's five session phases against the core's six. `idle` is the only one that is not the agent
 * working, so everything else reads as `prompting`: a compaction and a retry are both a turn the
 * operator is waiting on, and the window's phase line says so.
 */
export const phaseOf = (phase: SessionPhase): Phase => (phase === "idle" ? "ready" : "prompting");

/** What one assistant turn cost, as plain numbers. No Pi `Usage` value crosses. */
const usageEventOf = (item: PiTranscriptItem): Extract<AgentEvent, {kind: "usage"}> | null => {
	if (item.role !== "assistant" || item.usage === undefined) return null;
	return {
		kind: "usage",
		model: `${item.model.provider}/${item.model.id}`,
		inputTokens: item.usage.input,
		outputTokens: item.usage.output,
		cost: item.usage.cost.total,
	};
};

/**
 * What the last snapshot said, so the next one emits only what changed.
 *
 * A snapshot is authoritative and whole — Pi re-sends the entire transcript every revision — so
 * without this the window would repaint every item on every keystroke of a stream. The
 * fingerprints are the projected item's own JSON, which is exactly the value the window renders:
 * two snapshots whose projections match are, to the window, the same transcript.
 */
export interface SnapshotProjection {
	readonly items: ReadonlyMap<string, string>;
	readonly usage: ReadonlyMap<string, string>;
	readonly phase: Phase | null;
}

export const emptyProjection: SnapshotProjection = {
	items: new Map(),
	usage: new Map(),
	phase: null,
};

const fingerprint = (value: unknown): string => JSON.stringify(value);

/**
 * Fold one pushed snapshot into the events it changed, oldest item first.
 *
 * The order within a revision is content, then cost, then phase: an item is what the operator is
 * reading, its usage annotates it, and the phase line is the last thing to settle — so a window
 * that renders in arrival order never shows `ready` above a reply that has not landed yet.
 */
export const eventsOf = (
	previous: SnapshotProjection,
	snapshot: SessionSnapshot,
): {readonly events: ReadonlyArray<AgentEvent>; readonly next: SnapshotProjection} => {
	const events: Array<AgentEvent> = [];
	const items = new Map<string, string>();
	const usage = new Map<string, string>();

	for (const source of snapshot.transcript) {
		for (const item of itemsOf(source)) {
			const mark = fingerprint(item);
			items.set(item.id, mark);
			if (previous.items.get(item.id) !== mark) events.push({kind: "item", item});
		}
	}

	for (const source of snapshot.transcript) {
		const event = usageEventOf(source);
		if (event === null) continue;
		const mark = fingerprint(event);
		usage.set(source.id, mark);
		if (previous.usage.get(source.id) !== mark) events.push(event);
	}

	const phase = phaseOf(snapshot.phase);
	if (previous.phase !== phase) events.push({kind: "phase", phase});

	return {events, next: {items, usage, phase}};
};
