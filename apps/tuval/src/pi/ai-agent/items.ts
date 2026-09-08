/**
 * Pi's wire transcript → the model-blind port item union, and the events one pushed snapshot is
 * worth.
 *
 * Pure and total: every function here is a fold over values, so the whole revision-to-events
 * mapping is unit-testable without a socket, a session or a model. Pi's protocol types are
 * arguments and never results — the far side of this module is `ports/transcript-item.ts` only,
 * which is what keeps the Pi wire inside `src/pi/` (#7465).
 *
 * Grounded in Tuval's own wire vocabulary (`../wire/`, relocated from `pi-protocol`'s schemas by
 * ADR 0366): `TranscriptItem` (the `user` / `assistant` / `tool` / `compaction` union), `ToolTranscriptItem`
 * (`toolCallId`, `toolName`, `input`, `content`, and the `status`/`isError` pairs
 * `running`/false, `complete`/false, `error`/true), `Usage` (`totalTokens`, `cost.total`) and
 * `SessionSnapshot` (`revision`, `phase`, `transcript`).
 *
 * An assistant turn's `thinking` content becomes a `thinking` item of its own and never joins the
 * reply's `text` — folding reasoning into the reply would render as something the assistant never
 * said. An item's `image` parts have no port field to land in and are dropped.
 */

import {Predicate} from "effect";
import {
	boundToolResult,
	type ItemId,
	type JsonValue,
	newestBackendItemId,
	type SubagentSlot,
	type ThinkingItem,
	type ToolStatus,
	type TranscriptItem,
} from "../../ai-agent/ports/index.ts";
import type {AgentEvent, Phase} from "../../ai-agent/service/index.ts";
import type {
	TranscriptItem as PiTranscriptItem,
	SessionDelta,
	SessionPhase,
	SessionSnapshot,
} from "../wire/index.ts";
import {providerFailureText} from "./provider-failure.ts";

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

export const failureId = (base: string): ItemId => itemId(`${base}:failure`);

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
		case "compaction":
			return {
				kind: item.role,
				id: itemId(item.id),
				timestamp: item.timestamp,
				text: textOf(item.content),
			};
		case "assistant": {
			const row = {
				kind: "assistant" as const,
				id: itemId(item.id),
				timestamp: item.timestamp,
				text: textOf(item.content),
			};
			if (item.status === "aborted") return {...row, interrupted: true};
			// `streaming` is the reply mid-flight (`../server/transcript.ts`). The marker is what
			// keeps it out of the store and tells the window the text is still growing; the settled
			// revision arrives under this same id and carries none, which is what drops it.
			return item.status === "streaming" ? {...row, partial: true} : row;
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

/**
 * An assistant turn with nothing to read and no cut to report: its content is tool calls alone, or
 * it is a reply the model has not begun writing. Such a turn earns no reply row — an `agent` label
 * over nothing reads as a message that was dropped or is still loading, and the calls it made are
 * already rows of their own (#8216). Claude's mapper holds the same rule on its own wire
 * (`../../claude/history/map.ts`, `settles && (text.length > 0 || interrupted)`).
 * Failed turns carry their explanation in a distinct session notice; empty interrupted replies
 * retain their resend control.
 */
const emptyReply = (item: PiTranscriptItem): boolean =>
	item.role === "assistant" && item.status !== "aborted" && textOf(item.content) === "";

/** One wire item as every row it is worth: the reasoning first, then the turn that produced it. */
export const itemsOf = (item: PiTranscriptItem): ReadonlyArray<TranscriptItem> => {
	const thinking = thinkingOf(item);
	const reply = emptyReply(item) ? [] : [itemOf(item)];
	const rows = thinking === null ? reply : [thinking, ...reply];
	if (item.role === "assistant" && item.status === "error")
		return [
			...rows,
			{
				kind: "system",
				id: failureId(item.id),
				timestamp: item.timestamp,
				text: providerFailureText(item.errorMessage),
			},
		];
	return rows;
};

/**
 * Whether one tool call *starts* a worker, which is the only kind the running list draws.
 *
 * `pi-subagents` registers two tools and only one of them ever spawns. `subagent` is multiplexed:
 * its `action` field is documented as the switch — "when present, tool operates in management mode"
 * (`pi-subagents` `src/extension/schemas.ts:283-287`) — and the executor branches on exactly that,
 * `if (action) { … }` answering out of the management arm with the spawn path as everything after
 * it (`src/runs/foreground/subagent-executor.ts:5960,5976`). So any of the 55 actions
 * (`src/shared/types.ts:2757` — `list`, `status`, `stop`, `steer`, the `schedule.*` and `mission.*`
 * families) starts nothing, and an `agent` beside one names that action's *target* rather than a
 * worker. `bg_wait` waits on work that is already running (`src/runs/background/wait-tool.ts:36`)
 * and starts none of it.
 *
 * An input this cannot read draws no row either: a worker the operator cannot find is worse than a
 * worker the list is missing.
 */
const spawns = (toolName: string, input: unknown): boolean =>
	toolName === "subagent" &&
	Predicate.isObject(input) &&
	(input as {readonly action?: unknown}).action === undefined;

/**
 * What kind of worker the call started, in the extension's own words: the `agent` argument, which
 * names one of the configured agents (`pi-subagents` `src/extension/schemas.ts:283`). A spawn that
 * names none — a `workflowScript`, which picks its own children — is labelled by the tool, because
 * the row has to say something and that is the only true thing left.
 */
const subagentType = (input: unknown): string => {
	const agent = Predicate.isObject(input) ? (input as {readonly agent?: unknown}).agent : undefined;
	return typeof agent === "string" && agent !== "" ? agent : "subagent";
};

/** The newest thing the worker wrote, off a result already bounded by `boundToolResult`. */
const lastLineOf = (text: string): string => {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	return lines.length === 0 ? "" : (lines[lines.length - 1] as string);
};

/** `SubagentSlot.tokens` is a non-negative integer or the slot is unreadable off a checkpoint. */
const countOf = (tokens: number | undefined): number =>
	tokens === undefined || !Number.isFinite(tokens) ? 0 : Math.max(0, Math.trunc(tokens));

/**
 * The subagent slots one wire item is worth — the model-blind row the running list already draws
 * (`../../ai-agent/ports/subagent.ts`), so a Pi worker lands in the same surface a Claude one does.
 *
 * Two items carry one worker: the assistant turn whose `toolCall` part started it, and the tool
 * result that ends it. The call is the `running` slot, the result the `finished` one, and both are
 * keyed on the call id — so the second supersedes the first in the state's own record
 * (`../../ai-agent/core/fold.ts`) instead of drawing a second row.
 *
 * `items` is empty and `tokens` is what the result reports, not what the worker spent: the spawn
 * is a detached child process with its own `ModelRuntime` (#8555), so none of the child's turns
 * reach this transcript and there is nothing else here to read them off.
 */
export const subagentSlotsOf = (item: PiTranscriptItem): ReadonlyArray<SubagentSlot> => {
	if (item.role === "assistant") {
		return item.content.flatMap((part) =>
			part.type === "toolCall" && spawns(part.toolName, part.input)
				? [
						{
							id: itemId(part.toolCallId),
							type: subagentType(part.input),
							lastLine: "",
							startedAt: item.timestamp,
							tokens: 0,
							items: [],
							status: "running" as const,
						},
					]
				: [],
		);
	}
	if (item.role !== "tool" || !spawns(item.toolName, item.input)) return [];
	return [
		{
			id: itemId(item.toolCallId),
			type: subagentType(item.input),
			lastLine: lastLineOf(boundToolResult(textOf(item.content)).text),
			startedAt: item.timestamp,
			tokens: countOf(item.usage?.totalTokens),
			items: [],
			status: "finished",
		},
	];
};

/**
 * Pi's five session phases against the core's six. `idle` is the only one that is not the agent
 * working, so everything else reads as `prompting`: a compaction and a retry are both a turn the
 * operator is waiting on, and the window's phase line says so.
 */
export const phaseOf = (phase: SessionPhase): Phase => (phase === "idle" ? "ready" : "prompting");

/**
 * What one assistant turn cost, as plain numbers. No Pi `Usage` value crosses.
 *
 * `turn` is the wire item's own id, which is also what the projections below key a turn's cost by:
 * the fold and the seed then name one turn the same way, so a cost the seed misses is folded once
 * rather than twice (#8369).
 */
const usageEventOf = (item: PiTranscriptItem): Extract<AgentEvent, {kind: "usage"}> | null => {
	if (item.role !== "assistant" || item.usage === undefined) return null;
	return {
		kind: "usage",
		turn: item.id,
		model: `${item.model.provider}/${item.model.id}`,
		inputTokens: item.usage.input,
		outputTokens: item.usage.output,
		cost: item.usage.cost.total,
	};
};

/**
 * What the revision this fold last folded said, so the next one emits only what changed.
 *
 * The fingerprints are the projected item's own JSON, which is exactly the value the window
 * renders: two revisions whose projections match are, to the window, the same transcript. That is
 * what keeps a whole-value snapshot — the first push, and any transcript a delta cannot patch —
 * from repainting rows the operator is already reading.
 *
 * `revision` is the ordering, and it is what makes a late arrival droppable. A turn's push can win
 * the race against its own answer, and if the operator's next send lands in that gap the answer
 * arrives carrying an `idle` this projection has already passed — folded again it emits a second
 * `ready` under a live turn (#8544). Every fold below refuses an update at or below this number,
 * so arrival order stops being the thing that decides. `emptyProjection` sits below every real
 * revision because a record's first is 0.
 */
export interface SnapshotProjection {
	readonly items: ReadonlyMap<string, string>;
	readonly usage: ReadonlyMap<string, string>;
	/**
	 * Subagent slots, in their own map because a slot and its tool row share one id. Keyed by
	 * `<call id>:<status>` rather than by the id alone: one worker is two slots, the call's
	 * `running` and the result's `finished`, and a key that held only the latest would let a
	 * re-folded assistant turn push its `running` back over the `finished` that superseded it.
	 */
	readonly subagents: ReadonlyMap<string, string>;
	readonly phase: Phase | null;
	readonly revision: number;
}

export const emptyProjection: SnapshotProjection = {
	items: new Map(),
	usage: new Map(),
	subagents: new Map(),
	phase: null,
	revision: -1,
};

const fingerprint = (value: unknown): string => JSON.stringify(value);

const slotKey = (slot: SubagentSlot): string => `${slot.id}:${slot.status}`;

/** What one fold answers: the events it emitted, and the projection they left behind. */
export interface Folded {
	readonly events: ReadonlyArray<AgentEvent>;
	readonly next: SnapshotProjection;
}

/** An update the projection has already passed, left exactly as it was. */
const stale = (previous: SnapshotProjection): Folded => ({events: [], next: previous});

/**
 * Fold one whole-value snapshot into the events it changed, oldest item first.
 *
 * The order within a revision is content, then cost, then phase: an item is what the operator is
 * reading, its usage annotates it, and the phase line is the last thing to settle — so a window
 * that renders in arrival order never shows `ready` above a reply that has not landed yet.
 *
 * The item map is rebuilt from the snapshot rather than merged into the previous one, because a
 * whole value is also the answer to a transcript that was rewritten: a row this snapshot no longer
 * carries has to leave the projection with it.
 */
export const eventsOf = (previous: SnapshotProjection, snapshot: SessionSnapshot): Folded => {
	if (snapshot.revision <= previous.revision) return stale(previous);
	const events: Array<AgentEvent> = [];
	const items = new Map<string, string>();
	const usage = new Map<string, string>();
	const subagents = new Map<string, string>();

	for (const source of snapshot.transcript) {
		for (const item of itemsOf(source)) {
			const mark = fingerprint(item);
			items.set(item.id, mark);
			if (previous.items.get(item.id) !== mark) events.push({kind: "item", item});
		}
		for (const slot of subagentSlotsOf(source)) {
			const key = slotKey(slot);
			const mark = fingerprint(slot);
			subagents.set(key, mark);
			if (previous.subagents.get(key) !== mark) events.push({kind: "subagent", slot});
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

	return {events, next: {items, usage, subagents, phase, revision: snapshot.revision}};
};

/**
 * Fold one delta, in the same order and by the same fingerprints `eventsOf` uses.
 *
 * A delta names only what moved, so the projection is carried forward and the walk is over the
 * delta's own items — which is the whole point of the shape: a streamed turn signals per token,
 * and folding a token costs one item rather than the transcript (#8554). An absent scalar means
 * unchanged, so an absent `phase` leaves the phase line where it stands.
 */
export const deltaEventsOf = (previous: SnapshotProjection, delta: SessionDelta): Folded => {
	if (delta.revision <= previous.revision) return stale(previous);
	const events: Array<AgentEvent> = [];
	const items = new Map(previous.items);
	const usage = new Map(previous.usage);
	const subagents = new Map(previous.subagents);
	const changed = delta.items ?? [];

	for (const source of changed) {
		for (const item of itemsOf(source)) {
			const mark = fingerprint(item);
			items.set(item.id, mark);
			if (previous.items.get(item.id) !== mark) events.push({kind: "item", item});
		}
		for (const slot of subagentSlotsOf(source)) {
			const key = slotKey(slot);
			const mark = fingerprint(slot);
			subagents.set(key, mark);
			if (previous.subagents.get(key) !== mark) events.push({kind: "subagent", slot});
		}
	}

	for (const source of changed) {
		const event = usageEventOf(source);
		if (event === null) continue;
		const mark = fingerprint(event);
		usage.set(source.id, mark);
		if (previous.usage.get(source.id) !== mark) events.push(event);
	}

	const phase = delta.phase === undefined ? previous.phase : phaseOf(delta.phase);
	if (phase !== null && previous.phase !== phase) events.push({kind: "phase", phase});

	return {events, next: {items, usage, subagents, phase, revision: delta.revision}};
};

/**
 * What a snapshot the operator has already read leaves behind, so a resume folds it to nothing.
 *
 * The attach lease carries the session's whole transcript, and a `follow` that opened on
 * `emptyProjection` after a reattach emits all of it as live items — landing on top of the
 * operator's own newly typed turn and pushing it out of the window's 40-item cut (#8369). This is
 * that same snapshot read as "already rendered".
 *
 * `held` is the caller's own tail, oldest first, and it answers both halves. Its newest
 * backend-minted row is where "already read" stops: everything at or older than that is seeded,
 * and anything after it is left unseeded so it emits — a turn the session finished while the
 * socket was down is work the operator has never seen, and seeding the whole snapshot would bury
 * it for the life of the session with no gap marker and no way to page to it (#8374). An empty
 * tail is `null`, which is this function's whole "nothing to seed from" answer. A boundary this
 * snapshot does not carry — a compaction renumbered the transcript out from under the caller — is
 * `null` too, and the caller replays: a visibly wrong transcript is recoverable and a silently
 * missing reply is not. The replay is `paintOf` at the attach rather than the next push, because
 * a push carries only what changed (`../wire/delta.ts`) and there is no history in one.
 *
 * A seeded row is fingerprinted off the **caller's** copy, never off the snapshot's. Being at or
 * older than the boundary means "already read" only if an item's content cannot move, and on this
 * wire it can: `../wire/transcript.ts` gives the assistant item a
 * `status: "streaming"` variant with `usage` optional, so a reply the socket died in the middle of
 * settles server-side while this process is away. Seeded off the snapshot, that row would be
 * compared against itself, match, and never emit again — the operator keeps the half-written reply
 * for the life of the session and its cost never joins the totals. Seeded off what the caller
 * holds, it differs and emits. A seeded row the caller holds no copy of is one the window's own
 * bound already dropped, so the snapshot's copy stands and it stays suppressed: re-emitting it is
 * the replay #8369 closed.
 *
 * A turn's cost is seeded only when the whole turn is behind the boundary — a count within that
 * turn's own rows, since `items` spans every turn walked so far and would always be larger — and
 * only when every seeded row of it still matches what the caller holds. A boundary falling between
 * a turn's reasoning row and its reply leaves the reply to emit, and a turn that moved leaves its
 * reply to emit; either way the `usage` is that reply's annotation and travels with it.
 *
 * That seed decides what the window is *shown*, not what it is *charged*. A turn's cost is folded
 * under the turn's own id (`core/fold.ts`, `addUsage`), so a cost this seed leaves out and the
 * caller has already counted costs them nothing the second time — which is what lets the rule above
 * be about the reply the operator reads rather than about arithmetic (#8369).
 *
 * The phase is deliberately left unseeded: a session still working when it was reattached has to
 * restate `prompting` on its first push, or the window sits on the `ready` that `start` emitted.
 */
export const projectionOf = (
	snapshot: SessionSnapshot,
	held: ReadonlyArray<TranscriptItem>,
): SnapshotProjection | null => {
	const through = newestBackendItemId(held);
	if (through === null) return null;
	const carried = new Map(held.map((item) => [item.id as string, fingerprint(item)]));
	const items = new Map<string, string>();
	const usage = new Map<string, string>();
	const subagents = new Map<string, string>();
	let reached = false;
	for (const source of snapshot.transcript) {
		if (reached) break;
		for (const slot of subagentSlotsOf(source)) subagents.set(slotKey(slot), fingerprint(slot));
		const rows = itemsOf(source);
		const cut = rows.findIndex((item) => item.id === through);
		reached = cut !== -1;
		const seeded = reached ? rows.slice(0, cut + 1) : rows;
		let moved = false;
		for (const item of seeded) {
			const mark = fingerprint(item);
			const mine = carried.get(item.id);
			items.set(item.id, mine ?? mark);
			if (mine !== undefined && mine !== mark) moved = true;
		}
		const event = !moved && seeded.length === rows.length ? usageEventOf(source) : null;
		if (event !== null) usage.set(source.id, fingerprint(event));
	}
	return reached ? {items, usage, subagents, phase: null, revision: snapshot.revision} : null;
};

/**
 * The history a window holding nothing has to be shown, and the projection that leaves behind.
 *
 * The picker opens a past session on a fresh window, so its history has to paint — but Pi only
 * pushes on a session event, and nothing changes the session until the operator types. That defers
 * the whole transcript to the same push that carries their turn, and `../../ai-agent/core/fold.ts`
 * appends every unknown item after the turn the core recorded on send, so their message ends up
 * above the session it belongs under (#8369). Painting at the attach instead puts the history on
 * screen while the tail is still empty, where appending is the right order and there is nothing to
 * land on top of.
 *
 * The phase is left to the first push for the same reason `projectionOf` leaves it: `start` emits
 * its own `ready` after this, which would overwrite a `prompting` stated here.
 */
export const paintOf = (
	snapshot: SessionSnapshot,
): {readonly events: ReadonlyArray<AgentEvent>; readonly projection: SnapshotProjection} => {
	const folded = eventsOf(emptyProjection, snapshot);
	return {
		events: folded.events.filter((event) => event.kind !== "phase"),
		projection: {...folded.next, phase: null},
	};
};
