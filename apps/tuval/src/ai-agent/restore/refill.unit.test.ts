/**
 * The restore path's transcript refill: what a resumed session's tail is planned over, and what a
 * reader sees once it is (#8855).
 *
 * The founder's own checkpoint is the fixture shape — 21 nested worker rows, 17 session notices,
 * no user row, `omitted.items` in the thousands — because a tail written under an older window
 * rule is unrenderable and `restore` alone replays it verbatim, so it comes back unrenderable
 * after every boot. The assertions run the tail through `chatRows`, the same join the desk renders
 * through: a window is empty or it is not, and only the renderer can say which.
 */

import {applyCellChecked} from "@demlik/tea";
import {describe, expect, it} from "vitest";
import {
	assistantItem,
	nestedUnder,
	subagentSlot,
	systemItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import {type ChatRow, chatRows} from "../../shell/chat/rows.ts";
import {aiAgentSessionMachine} from "../core/machine.ts";
import type {AiAgentSessionCmd, AiAgentSessionMsg} from "../core/messages.ts";
import {type AiAgentSessionState, initialState, restore} from "../core/state.ts";
import type {TranscriptItem} from "../ports/index.ts";

const CWD = "/work";
const SESSION = "session-3c82b30d";
const SPAWN = "call-spawn";

/** What the pre-#8831 window rule left in the founder's checkpoint: passengers and notices only. */
const NESTED_ROWS = 21;
const NOTICE_ROWS = 17;
/** Older exchanges the store still holds behind the tail, so the refilled window omits some. */
const OLDER_TURNS = 30;
/** The count the broken checkpoint carried — a window that no longer exists. */
const STALE_OMITTED = 5043;

const machine = aiAgentSessionMachine({cwd: CWD});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

const workerRows: ReadonlyArray<TranscriptItem> = Array.from({length: NESTED_ROWS}, (_, index) =>
	nestedUnder(assistantItem(`w-${index}`, `worker line ${index}`), SPAWN),
);

const noticeRows: ReadonlyArray<TranscriptItem> = Array.from({length: NOTICE_ROWS}, (_, index) =>
	systemItem(`n-${index}`, `task progress ${index}`),
);

const olderRows: ReadonlyArray<TranscriptItem> = Array.from(
	{length: OLDER_TURNS},
	(_, index): ReadonlyArray<TranscriptItem> => [
		userItem(`u-${index}`, `older prompt ${index}`),
		assistantItem(`a-${index}`, `older answer ${index}`),
	],
).flat();

/** The whole session as the backend's store holds it — the rows a resume's own read already maps. */
const storedHistory: ReadonlyArray<TranscriptItem> = [
	...olderRows,
	userItem("u-spawn", "run three workers"),
	toolItem(SPAWN, "spawned"),
	...workerRows,
	...noticeRows,
	assistantItem("a-spawn", "all three came back"),
];

/** The checkpoint the founder's desk came back with: the tail nothing can render. */
const brokenCheckpoint: AiAgentSessionState = {
	...initialState(CWD),
	phase: "ready",
	sessionId: SESSION,
	subagents: {[SPAWN]: subagentSlot(SPAWN, {items: [...workerRows]})},
	transcript: {
		items: [...workerRows, ...noticeRows],
		omitted: {items: STALE_OMITTED, bytes: 4_000_000, reason: "item-limit"},
	},
};

/** The resume as the pipeline runs it: restore the checkpoint, then land the layer's open. */
const resumed = (
	checkpoint: AiAgentSessionState,
	history: ReadonlyArray<TranscriptItem>,
): AiAgentSessionState => {
	const [reconnecting] = apply(restore(checkpoint), {type: "reconnect"});
	const [ready] = apply(reconnecting, {type: "started", sessionId: SESSION, history});
	return ready;
};

/** A `turn` row hides its own rows behind a summary, so a reader's rows are the flattened list. */
const flatten = (rows: ReadonlyArray<ChatRow>): ReadonlyArray<ChatRow> =>
	rows.flatMap((row) => (row.kind === "turn" ? [row, ...flatten(row.hidden)] : [row]));

const rowsFor = (state: AiAgentSessionState): ReadonlyArray<ChatRow> =>
	flatten(
		chatRows({
			older: [],
			tail: state.transcript.items,
			omitted: state.transcript.omitted.items,
			loading: false,
			atOldest: false,
			subagents: new Set(Object.keys(state.subagents)),
		}),
	);

/** Content the operator can actually read: a row of its own, not one folded under a worker's call. */
const contentRows = (rows: ReadonlyArray<ChatRow>): ReadonlyArray<ChatRow> =>
	rows.filter((row) => row.kind === "item" && !row.nested);

describe("a checkpoint whose tail is all passengers and notices", () => {
	it("renders nothing before the refill — the defect, stated", () => {
		expect(contentRows(rowsFor(restore(brokenCheckpoint)))).toEqual([]);
	});

	it("renders the operator's own turns once the resume re-plans the tail", () => {
		const rows = contentRows(rowsFor(resumed(brokenCheckpoint, storedHistory)));
		const ids = rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []));
		expect(ids.length).toBeGreaterThan(0);
		// The spawning turn, read as the operator wrote it: their prompt, the call, the reply.
		expect(ids.slice(-3)).toEqual(["u-spawn", SPAWN, "a-spawn"]);
	});

	it("replaces the stale omission with what the newly planned window left out", () => {
		const state = resumed(brokenCheckpoint, storedHistory);
		expect(state.transcript.omitted.items).toBe(
			storedHistory.length - state.transcript.items.length,
		);
		expect(state.transcript.omitted.items).toBeLessThan(STALE_OMITTED);
	});

	it("keeps the subagent slots and the strip that pages back past the window", () => {
		const state = resumed(brokenCheckpoint, storedHistory);
		expect(Object.keys(state.subagents)).toEqual([SPAWN]);
		expect(rowsFor(state)).toContainEqual({
			kind: "older",
			items: state.transcript.omitted.items,
		});
	});
});

describe("a checkpoint whose tail already renders", () => {
	const tail: ReadonlyArray<TranscriptItem> = [
		userItem("u-live", "what changed"),
		assistantItem("a-live", "two files", undefined, true),
	];
	const passing: AiAgentSessionState = {
		...initialState(CWD),
		phase: "ready",
		sessionId: SESSION,
		transcript: {items: tail, omitted: {items: 4, bytes: 900, reason: "item-limit"}},
	};

	it("keeps every row it carried, in the order it carried them", () => {
		const state = resumed(passing, [...olderRows.slice(0, 8), ...tail]);
		const ids = state.transcript.items.map((item) => item.id);
		expect(ids.slice(-tail.length)).toEqual(tail.map((item) => item.id));
		expect(ids).toContain("u-0");
	});

	it("keeps this process's own copy of a row the store also holds", () => {
		// The restore marked the cut reply `interrupted`; the store's copy carries no such marker,
		// and the operator has already read ours (#8369).
		const stale = assistantItem("a-live", "two files");
		const state = resumed(passing, [...olderRows.slice(0, 8), userItem("u-live", "x"), stale]);
		expect(state.transcript.items.find((item) => item.id === "a-live")).toEqual(tail[1]);
	});

	it("holds an unechoed prompt and a cut reply in place, neither of which the store has", () => {
		// The shape the Claude CLI leaves: it echoes no `user` frame, so the operator's turn exists
		// only as the core's local row — and the reply the restart cut was never written down.
		const local: TranscriptItem = {...userItem("local:k1", "run it"), local: true};
		const cut = assistantItem("a-cut", "I was in the middle of", undefined, true);
		const held = {
			...passing,
			transcript: {items: [local, cut], omitted: {items: 2, bytes: 50, reason: "item-limit"}},
		} satisfies AiAgentSessionState;
		const state = resumed(held, [...olderRows.slice(0, 4), userItem("s-k1", "run it")]);
		expect(state.transcript.items.map((item) => item.id).slice(-2)).toEqual(["local:k1", "a-cut"]);
		// The store's copy of that same turn is the one dropped, not carried beside it.
		expect(state.transcript.items.map((item) => item.id)).not.toContain("s-k1");
	});
});

describe("a layer that read no history", () => {
	it("leaves the restored tail exactly as it was", () => {
		const restored = restore(brokenCheckpoint);
		const [reconnecting] = apply(restored, {type: "reconnect"});
		const [ready] = apply(reconnecting, {type: "started", sessionId: SESSION});
		expect(ready.transcript).toEqual(restored.transcript);
	});
});
