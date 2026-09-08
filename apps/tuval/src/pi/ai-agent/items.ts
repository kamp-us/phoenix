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

import {
	boundToolResult,
	type ItemId,
	type JsonValue,
	newestBackendItemId,
	type ThinkingItem,
	type ToolStatus,
	type TranscriptItem,
} from "../../ai-agent/ports/index.ts";
import type {AgentEvent, Phase} from "../../ai-agent/service/index.ts";
import type {
	TranscriptItem as PiTranscriptItem,
	SessionPhase,
	SessionSnapshot,
} from "../wire/index.ts";

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
 *
 * `aborted` and `error` are excluded on purpose: for those the status *is* the content, and an
 * interrupted reply with no text still has to say the turn was cut.
 */
const emptyOrdinaryReply = (item: PiTranscriptItem): boolean =>
	item.role === "assistant" &&
	(item.status === "complete" || item.status === "streaming") &&
	textOf(item.content) === "";

/** One wire item as every row it is worth: the reasoning first, then the turn that produced it. */
export const itemsOf = (item: PiTranscriptItem): ReadonlyArray<TranscriptItem> => {
	const thinking = thinkingOf(item);
	const reply = emptyOrdinaryReply(item) ? [] : [itemOf(item)];
	return thinking === null ? reply : [thinking, ...reply];
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
 * What the last snapshot said, so the next one emits only what changed.
 *
 * A snapshot is authoritative and whole — Pi re-sends the entire transcript every revision — so
 * without this the window would repaint every item on every revision. The push rate is what makes
 * that expensive: the server ticks once per session event, so a turn writing text costs a
 * revision per delta once the host is projecting the reply as it is written
 * (`../server/AgentSessionHost.ts`'s `streamPartialText`, off by default), and one item changes
 * while the rest do not. The fingerprints are the projected item's own JSON, which is exactly the
 * value the window renders: two snapshots whose projections match are, to the window, the same
 * transcript.
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

/**
 * What a snapshot the operator has already read leaves behind, so a resume folds it to nothing.
 *
 * Pi re-sends the whole transcript every revision, so a `follow` that opened on `emptyProjection`
 * after a reattach re-emits the entire history as live items — landing on top of the operator's
 * own newly typed turn and pushing it out of the window's 40-item cut (#8369). The attach lease
 * already carries the session's snapshot, and this is that snapshot read as "already rendered".
 *
 * `held` is the caller's own tail, oldest first, and it answers both halves. Its newest
 * backend-minted row is where "already read" stops: everything at or older than that is seeded,
 * and anything after it is left unseeded so it emits — a turn the session finished while the
 * socket was down is work the operator has never seen, and seeding the whole snapshot would bury
 * it for the life of the session with no gap marker and no way to page to it (#8374). An empty
 * tail seeds nothing. A boundary this snapshot does not carry — a compaction renumbered the
 * transcript out from under the caller — also seeds nothing, which replays: a visibly wrong
 * transcript is recoverable and a silently missing reply is not.
 *
 * A seeded row is fingerprinted off the **caller's** copy, never off the snapshot's. Being at or
 * older than the boundary means "already read" only if an item's content cannot move, and on this
 * wire it can: `@earendil-works/pi-protocol` 0.84.3 `dist/schemas.d.ts` gives the assistant item a
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
): SnapshotProjection => {
	const through = newestBackendItemId(held);
	if (through === null) return emptyProjection;
	const carried = new Map(held.map((item) => [item.id as string, fingerprint(item)]));
	const items = new Map<string, string>();
	const usage = new Map<string, string>();
	let reached = false;
	for (const source of snapshot.transcript) {
		if (reached) break;
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
	return reached ? {items, usage, phase: null} : emptyProjection;
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
