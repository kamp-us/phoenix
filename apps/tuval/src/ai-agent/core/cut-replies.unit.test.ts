/**
 * A cut reply that left the window and came back: the path where the mark used to be lost.
 *
 * The mark rides the assistant row, the row rides a bounded tail, and agy's own log records an
 * operator stop as a finished reply — so outside the tail the store's bare copy was the only copy and
 * it read as the model's final answer (#8985). The record under test is `cutReplies`, and every case
 * here drives it through the machine rather than through the fold directly, because the round trip is
 * a checkpoint's: fold the stop, shed the row, resume over the store's history.
 */

import {applyCellChecked} from "@demlik/tea";
import {describe, expect, it} from "vitest";
import {assistantItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";
import {ItemId, type TranscriptItem, type TranscriptPayload} from "../ports/index.ts";
import {foldEvent} from "./fold.ts";
import {aiAgentSessionMachine} from "./machine.ts";
import type {AiAgentSessionCmd, AiAgentSessionMsg} from "./messages.ts";
import {type AiAgentSessionState, cutReplyLimit, initialState, remarkCutReplies} from "./state.ts";

const AT = 1_756_000_000_000;

/** One item tall: enough that a second turn's arrival sheds the first, which is the eviction here. */
const tight = {itemLimit: 1};

/**
 * The window the resume re-plans under. Roomier than the one the tail was folded in, which is the
 * configuration a refill heals anything at all in: `foldItem` runs per arriving item, so it sheds
 * rows and never brings one back, and `refillTranscript` is the one entrance that re-plans over the
 * store's whole history (#8855). A refill under the same bounds re-sheds what those bounds shed —
 * the shell's own page-back is the surface for that one (`shell/chat/ChatWindow.tsx`).
 */
const machine = aiAgentSessionMachine({cwd: "/repo", itemLimit: 8});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

const open = (over: Partial<AiAgentSessionState> = {}): AiAgentSessionState => ({
	...initialState("/repo"),
	phase: "ready",
	sessionId: "session-1",
	...over,
});

const payload = (items: ReadonlyArray<TranscriptItem>): TranscriptPayload => ({
	items,
	omitted: initialState("/x").transcript.omitted,
});

/** Is the row with this id marked cut? `undefined` when the tail does not carry it at all. */
const markOf = (items: ReadonlyArray<TranscriptItem>, id: string): boolean | undefined => {
	const row = items.find((item) => item.id === id);
	return row === undefined ? undefined : row.kind === "assistant" && row.interrupted === true;
};

/**
 * The conversation as a real agy log keys it: `<cid>:line:<n>` for the stored row, with the live id
 * the tail knew it by stated in `alias` (`../../agy/ai-agent/transcript.ts`). The numbers are the
 * captured v1.2.0 conversation's own — the cut reply is line 9, alias `:9` — and the derivation from
 * that capture through the shipped reader is pinned in
 * `../../agy/ai-agent/paging-from-live.unit.test.ts`. Restated as literals here because the core may
 * not reach a backend (`./boundary.unit.test.ts`).
 */
const CID = "8377fd63-b158-49b9-b2c1-2d89ed9135ce";

/** One stored row: the store's own id, and the live id this process observed it under. */
const asStored = <Item extends TranscriptItem>(item: Item, line: number): Item => ({
	...item,
	id: ItemId.make(`${CID}:line:${line}`),
	alias: ItemId.make(item.id),
});

/** The cut reply and the prompt it answered, as the store holds them: bare, `status: "DONE"`. */
const storedTurn: ReadonlyArray<TranscriptItem> = [
	asStored(userItem(`${CID}:7`, "write the essay", AT), 7),
	asStored(assistantItem(`${CID}:9`, "I was half way through", AT + 2_000), 9),
	userItem("u1", "never mind, summarize it", AT + 10_000),
	assistantItem("a1", "here is the summary", AT + 12_000),
];

/** What the store calls the cut reply, and what this session recorded it as. */
const STORED_CUT = `${CID}:line:9`;
const LIVE_CUT = `${CID}:9`;

describe("the cut-reply record", () => {
	it("names a reply the layer marked cut, so the fact outlives the row", () => {
		const state = foldEvent(
			open(),
			{kind: "item", item: assistantItem("a0", "half", AT, true)},
			tight,
		);
		expect(state.cutReplies).toEqual(["a0"]);
	});

	it("leaves a finished reply unnamed", () => {
		const state = foldEvent(open(), {kind: "item", item: assistantItem("a0", "done", AT)}, tight);
		expect(state.cutReplies).toEqual([]);
	});

	it("names one row once, however many frames of it arrive", () => {
		const cut = assistantItem("a0", "half", AT, true);
		const once = foldEvent(open(), {kind: "item", item: cut}, tight);
		expect(foldEvent(once, {kind: "item", item: cut}, tight).cutReplies).toEqual(["a0"]);
	});

	// The bound is the reason a checkpointed record is admissible at all, so it is pinned rather than
	// trusted to the `slice`: unbounded, a long session pays storage per Escape forever.
	it("keeps the newest ids and no more than the bound, dropping the oldest", () => {
		const over = cutReplyLimit + 5;
		let state = open();
		for (let index = 0; index < over; index += 1) {
			state = foldEvent(
				state,
				{kind: "item", item: assistantItem(`a${index}`, "half", AT + index, true)},
				tight,
			);
		}
		expect(state.cutReplies).toHaveLength(cutReplyLimit);
		expect(state.cutReplies.at(0)).toBe(`a${over - cutReplyLimit}`);
		expect(state.cutReplies.at(-1)).toBe(`a${over - 1}`);
	});

	// The ids name rows in a conversation this session has left, and no page of the new one reads them.
	it("empties on a session reset, with the transcript it describes", () => {
		const held = foldEvent(
			open(),
			{kind: "item", item: assistantItem("a0", "half", AT, true)},
			tight,
		);
		const reset = foldEvent(held, {kind: "session-reset", sessionId: "session-2"}, tight);
		expect(reset.cutReplies).toEqual([]);
	});
});

describe("a cut reply paged out of the window and back in from the store", () => {
	/**
	 * The checkpoint as it stands after the stop and one more turn: the cut row is named in the
	 * record and shed from a one-item tail, which is exactly the state the defect was silent in.
	 */
	const evicted = (): AiAgentSessionState => {
		let state = open({transcript: payload([userItem(`${CID}:7`, "write the essay", AT)])});
		state = foldEvent(
			state,
			{
				kind: "item",
				item: assistantItem(`${CID}:9`, "I was half way through", AT + 2_000, true),
			},
			tight,
		);
		state = foldEvent(
			state,
			{kind: "item", item: userItem("u1", "never mind", AT + 10_000)},
			tight,
		);
		state = foldEvent(
			state,
			{kind: "item", item: assistantItem("a1", "here is the summary", AT + 12_000)},
			tight,
		);
		return state;
	};

	// The newest turn's group is admitted whole whatever the bounds, so `u1` stays beside `a1`; what
	// the one-item window sheds is the cut turn, both of its rows.
	it("is shed from the tail while the record keeps it", () => {
		const state = evicted();
		expect(state.transcript.items.map((item) => item.id)).toEqual(["u1", "a1"]);
		expect(state.cutReplies).toEqual([LIVE_CUT]);
	});

	// The defect: before the record, the refill spliced the store's bare copy in and the row rendered
	// as a reply the model finished.
	it("comes back marked when a resume refills the tail over the store's history", () => {
		const [state] = apply(evicted(), {
			type: "started",
			sessionId: "session-1",
			history: storedTurn,
		});
		// The store's id, because that is the copy the refill spliced in — and the record names the
		// live one, so this row is marked over the `alias` join and nothing else (#9046).
		expect(state.cutReplies).toEqual([LIVE_CUT]);
		expect(markOf(state.transcript.items, STORED_CUT)).toBe(true);
	});

	it("leaves the store's other replies exactly as the store wrote them", () => {
		const [state] = apply(evicted(), {
			type: "started",
			sessionId: "session-1",
			history: storedTurn,
		});
		expect(markOf(state.transcript.items, "a1")).toBe(false);
	});

	// `refillTranscript`'s held-tail rebase reaches held rows alone, so a record with nothing in it
	// must leave the refill's answer untouched — the no-op is what makes the fourth operand safe.
	it("marks nothing when the session cut nothing", () => {
		const clean = open({transcript: payload([assistantItem("a1", "here is the summary", AT)])});
		const [state] = apply(clean, {type: "started", sessionId: "session-1", history: storedTurn});
		expect(state.transcript.items.some((item) => "interrupted" in item)).toBe(false);
	});

	/**
	 * Criterion 4: the resend. Its two operands are checkpointed scalars, not rows — the anchor is the
	 * operator's own prompt (`cutPromptId`, #8699) and the text is `lastPrompt` — so they survive a
	 * window that drops every row of that turn, and the anchor still names a row the refill brings
	 * back. Never a control pointing at a prompt the session cannot send.
	 */
	it("keeps a resend the restored anchor can still send", () => {
		const anchor = ItemId.make(`${CID}:7`);
		const cut = {...evicted(), interrupted: anchor, lastPrompt: "write the essay"};
		const [state] = apply(cut, {type: "started", sessionId: "session-1", history: storedTurn});
		expect(state.interrupted).toBe(anchor);
		expect(state.lastPrompt).toBe("write the essay");
		expect(state.transcript.items.some((item) => item.alias === anchor)).toBe(true);
	});
});

describe("remarkCutReplies", () => {
	it("returns the rows untouched when the record is empty", () => {
		const items = [assistantItem("a0", "done", AT)];
		expect(remarkCutReplies(items, [])).toBe(items);
	});

	// Only the assistant kind wears the mark, so a prompt sharing an id with a cut reply — which a
	// backend keying both id spaces off one counter can produce — must not grow one.
	it("marks the assistant kind and nothing else", () => {
		const marked = remarkCutReplies([userItem("a0", "go", AT)], ["a0" as ItemId]);
		expect(marked[0] && "interrupted" in marked[0]).toBe(false);
	});

	/**
	 * The join #9046 measured missing. The record holds the id the fact was observed under — the live
	 * one — and a store keying its history in a second space states that id in `alias`. Reading `id`
	 * alone marked no agy row at all, so a cut turn paged back in read as one the model finished.
	 */
	it("names a stored row by the live id it carries in alias", () => {
		const stored = asStored(assistantItem(LIVE_CUT, "I was half way through", AT), 9);
		const marked = remarkCutReplies([stored], [ItemId.make(LIVE_CUT)]);
		expect(marked[0]?.id).toBe(STORED_CUT);
		expect(marked[0]?.kind === "assistant" && marked[0].interrupted).toBe(true);
	});

	// The alias is a second identity, not a licence: a row whose alias names nothing in the record
	// stays bare, so a page cannot acquire a mark from a turn it is not.
	it("leaves a stored row whose alias the record does not name", () => {
		const stored = asStored(assistantItem(`${CID}:6`, "the finished answer", AT), 6);
		const marked = remarkCutReplies([stored], [ItemId.make(LIVE_CUT)]);
		expect(marked[0]?.kind === "assistant" && marked[0].interrupted).toBeUndefined();
	});
});
