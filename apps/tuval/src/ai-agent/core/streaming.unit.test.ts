/**
 * What the core does with a reply that is still arriving (#8160): it grows one row, and it never
 * lets a `streaming` marker outlive the turn that justifies it.
 *
 * Both halves are the core's alone. The layers decide what a delta *is* — that is proved against
 * their own captures (`claude/history/partials.unit.test.ts`, `pi/ai-agent/items.unit.test.ts`) —
 * and the core decides what a session made of them looks like at rest, which is the question every
 * case here asks.
 */

import {applyCellChecked} from "@demlik/tea";
import {describe, expect, it} from "vitest";
import {assistantItem, streamingItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";
import type {AgentEvent} from "../events.ts";
import type {TranscriptItem} from "../ports/index.ts";
import {foldEvent} from "./fold.ts";
import {aiAgentSessionMachine} from "./machine.ts";
import type {AiAgentSessionCmd, AiAgentSessionMsg} from "./messages.ts";
import {type AiAgentSessionState, initialState, restore} from "./state.ts";

const AT = 1_756_000_000_000;
const SENT_AT = 1_700_000_000_000;

const machine = aiAgentSessionMachine({cwd: "/repo"});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

const session = (over: Partial<AiAgentSessionState> = {}): AiAgentSessionState => ({
	...initialState("/repo"),
	phase: "prompting",
	sessionId: "session-1",
	...over,
});

const fold = (
	state: AiAgentSessionState,
	...events: ReadonlyArray<AgentEvent>
): AiAgentSessionState => events.reduce((one, event) => foldEvent(one, event, {}), state);

const item = (one: TranscriptItem): AgentEvent => ({kind: "item", item: one});

/** The deltas of one reply, as a layer emits them: the same id, more text each time. */
const deltas = (id: string, ...texts: ReadonlyArray<string>): ReadonlyArray<AgentEvent> =>
	texts.map((text) => item(streamingItem(id, text, AT)));

const tail = (state: AiAgentSessionState): ReadonlyArray<TranscriptItem> => state.transcript.items;

describe("a stream of deltas", () => {
	it("folds into one growing row rather than a row apiece", () => {
		const state = fold(session(), ...deltas("a1", "The", "The quick", "The quick brown fox"));
		expect(tail(state)).toEqual([streamingItem("a1", "The quick brown fox", AT)]);
	});

	it("is superseded whole by the finished reply under the same id", () => {
		const streamed = fold(session(), ...deltas("a1", "The", "The quick"));
		const settled = fold(streamed, item(assistantItem("a1", "The quick brown fox.", AT)));
		expect(tail(settled)).toEqual([assistantItem("a1", "The quick brown fox.", AT)]);
		expect(tail(settled).some((one) => one.kind === "assistant" && one.streaming === true)).toBe(
			false,
		);
	});

	it("grows the newest row without disturbing the turns above it", () => {
		const seeded = fold(session(), item(userItem("u1")), item(assistantItem("a0")));
		const state = fold(seeded, ...deltas("a1", "one", "one two"));
		expect(tail(state).map((one) => one.id)).toEqual(["u1", "a0", "a1"]);
	});
});

/**
 * The marker is a claim about a turn that is running, so every way out of `prompting` settles it.
 * A row left `streaming` past the turn's end is a window promising text that will never come.
 */
describe("a turn that ends mid-stream", () => {
	const streaming = (): AiAgentSessionState => fold(session(), ...deltas("a1", "half a rep"));

	it("settles the half-written row as cut when the turn reports ready", () => {
		const state = fold(streaming(), {kind: "phase", phase: "ready"});
		expect(tail(state)).toEqual([assistantItem("a1", "half a rep", AT, true)]);
		expect(state.phase).toBe("ready");
	});

	it("settles it when the transport goes away instead", () => {
		const state = fold(streaming(), {kind: "phase", phase: "gone"});
		expect(tail(state)).toEqual([assistantItem("a1", "half a rep", AT, true)]);
	});

	it("settles it when the turn fails", () => {
		const state = fold(streaming(), {
			kind: "failure",
			failure: {tag: "TurnFailed", reason: null, detail: "the model refused"},
		});
		expect(tail(state)).toEqual([assistantItem("a1", "half a rep", AT, true)]);
		expect(state.phase).toBe("ready");
	});

	// The other side of the same rule: while the turn is still running the marker must stand, or the
	// window loses the one thing that says the reply is still coming.
	it("leaves the marker alone while the session is still on the turn", () => {
		const state = fold(streaming(), {kind: "phase", phase: "prompting"});
		expect(tail(state)).toEqual([streamingItem("a1", "half a rep", AT)]);
	});

	it("leaves a settled tail untouched, so the fold costs a turn that streamed nothing nothing", () => {
		const before = fold(session(), item(assistantItem("a1")));
		const after = fold(before, {kind: "phase", phase: "ready"});
		expect(after.transcript).toBe(before.transcript);
	});
});

/**
 * Asking for an interrupt is not the turn stopping (ADR 0356 / #8007), so the request alone leaves
 * the marker where it is; the backend's own answer is what settles it.
 */
describe("an interrupt mid-stream", () => {
	const streaming = (): AiAgentSessionState => fold(session(), ...deltas("a1", "as far as it g"));

	it("keeps the row growing while the abort is still outstanding", () => {
		const [asked] = apply(streaming(), {type: "interrupt", at: SENT_AT});
		expect(asked.phase).toBe("prompting");
		expect(asked.interruption).toEqual({requestedAt: SENT_AT});
		expect(tail(asked)).toEqual([streamingItem("a1", "as far as it g", AT)]);
	});

	it("settles the row as cut once the backend answers the abort", () => {
		const [asked] = apply(streaming(), {type: "interrupt", at: SENT_AT});
		const [stopped] = apply(asked, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "phase", phase: "ready"},
		});
		expect(stopped.interruption).toBeNull();
		expect(tail(stopped)).toEqual([assistantItem("a1", "as far as it g", AT, true)]);
	});

	// A backend that reports the cut itself wins, because it knows what it actually wrote: its own
	// item carries the streamed row's id, so it replaces the row before the phase line settles it.
	it("prefers the backend's own cut reply over the core's settlement", () => {
		const [asked] = apply(streaming(), {type: "interrupt", at: SENT_AT});
		const [reported] = apply(asked, {
			type: "event",
			sessionId: "session-1",
			event: item(assistantItem("a1", "as far as it got before the abort", AT, true)),
		});
		const [stopped] = apply(reported, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "phase", phase: "ready"},
		});
		expect(tail(stopped)).toEqual([
			assistantItem("a1", "as far as it got before the abort", AT, true),
		]);
	});
});

/**
 * #8160 no-go: no partial item reaches a checkpoint as if it were final. The store is written per
 * fold, so a checkpoint taken between two deltas holds a `streaming` row — and this is where that
 * row stops being a half-written reply presented as a whole one.
 */
describe("a restore over a half-streamed tail", () => {
	const saved = (over: Partial<AiAgentSessionState> = {}): AiAgentSessionState =>
		session({
			transcript: {
				items: [userItem("u1"), streamingItem("a1", "half a rep", AT)],
				omitted: initialState("/repo").transcript.omitted,
			},
			...over,
		});

	it("brings the row back cut, never as the whole reply", () => {
		const state = restore(saved());
		expect(tail(state)).toEqual([userItem("u1"), assistantItem("a1", "half a rep", AT, true)]);
	});

	it("offers the resend against the row that was streaming", () => {
		expect(restore(saved()).interrupted).toBe("a1");
	});

	// A checkpoint written mid-stream can name any phase — `phase` and the tail are folded by
	// separate events — so the streamed row is a sharper cut test than the saved phase is.
	it("cuts the streamed row even when the saved phase says the turn was over", () => {
		const state = restore(saved({phase: "ready"}));
		expect(state.interrupted).toBe("a1");
		expect(tail(state).at(-1)).toEqual(assistantItem("a1", "half a rep", AT, true));
	});

	it("round-trips through JSON the way every other checkpoint field does", () => {
		const loaded = JSON.parse(JSON.stringify(saved())) as AiAgentSessionState;
		expect(restore(loaded)).toEqual(restore(saved()));
	});
});

/**
 * ADR 0357's queue and this stream meet at exactly one point: the turn's end, which both the
 * settlement and the admission hang off. Neither may cost the other.
 */
describe("the prompt queue under a streamed turn", () => {
	const prompt = (text: string, key: string): AiAgentSessionMsg => ({
		type: "prompt",
		text,
		key,
		timestamp: SENT_AT,
	});

	it("drains the head once a streamed turn completes, with the reply settled beside it", () => {
		const [running] = apply(
			session({phase: "ready", transcript: initialState("/repo").transcript}),
			prompt("make the README", "k1"),
		);
		const streaming = fold(running, ...deltas("a1", "writing the RE"));
		const [queued] = apply(streaming, prompt("then the CHANGELOG", "k2"));
		expect(queued.queued).toHaveLength(1);
		expect(tail(queued).at(-1)).toEqual(streamingItem("a1", "writing the RE", AT));

		const [sent, cmds] = apply(queued, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "phase", phase: "ready"},
		});
		expect(sent.queued).toEqual([]);
		expect(sent.phase).toBe("prompting");
		expect(cmds).toEqual([{type: "aiAgent.prompt", text: "then the CHANGELOG", key: "k2"}]);
		// The settlement and the admission are one transition, and both landed: the cut reply is on
		// the tail and the queued turn is recorded under it.
		expect(tail(sent).map((one) => one.id)).toEqual(["local:k1", "a1", "local:k2"]);
		expect(tail(sent)[1]).toEqual(assistantItem("a1", "writing the RE", AT, true));
	});

	it("releases a queue whose turn was streaming when the session went away", () => {
		const [running] = apply(
			session({phase: "ready", transcript: initialState("/repo").transcript}),
			prompt("make the README", "k1"),
		);
		const [queued] = apply(fold(running, ...deltas("a1", "writ")), prompt("and then", "k2"));
		const [gone] = apply(queued, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "phase", phase: "gone"},
		});
		expect(gone.queued).toEqual([]);
		expect(gone.sends.find((one) => one.key === "k2")?.state).toBe("refused");
		expect(tail(gone)[1]).toEqual(assistantItem("a1", "writ", AT, true));
	});
});
