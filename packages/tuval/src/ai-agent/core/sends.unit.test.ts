/**
 * The send ledger's own rules, away from the machine: which failures prove a send never crossed,
 * which only leave it in doubt, and how one key's row is kept.
 *
 * The split is the whole point. Calling an uncertain send refused invites a duplicate turn; calling
 * a refused one uncertain costs one extra button. Every row below reads a `reason` the layer's own
 * error classes enumerate (`../service/errors.ts`), never a guess about what a backend meant.
 */

import {describe, expect, it} from "vitest";
import type {AgentFailure} from "../events.ts";
import {
	MODE_UNSUPPORTED,
	PAGE_ERROR,
	PROMPT_ERROR,
	START_ERROR,
	TRANSPORT_ERROR,
} from "./failures.ts";
import {
	markTurnRunning,
	noteSend,
	pendingSend,
	runningSend,
	type SendOutcome,
	sendAfterFailure,
	sendLimit,
	sendOutcome,
	settleAccepted,
	settledBy,
	settleEndedSession,
	settleFailedTurn,
} from "./sends.ts";

const failure = (tag: string, reason: string | null): AgentFailure => ({
	tag,
	reason,
	detail: `${tag} ${reason ?? "-"}`,
});

describe("which arm a failure lands a send in", () => {
	it("calls a send refused only where the reason proves the text never crossed", () => {
		expect(sendAfterFailure(failure(PROMPT_ERROR, "no-session"))).toBe("refused");
		expect(sendAfterFailure(failure(PROMPT_ERROR, "refused"))).toBe("refused");
		expect(sendAfterFailure(failure(START_ERROR, "session-not-found"))).toBe("refused");
		expect(sendAfterFailure(failure(START_ERROR, "session-locked"))).toBe("refused");
	});

	it("leaves a send uncertain wherever the text could have crossed", () => {
		expect(sendAfterFailure(failure(PROMPT_ERROR, "disconnected"))).toBe("uncertain");
		expect(sendAfterFailure(failure(PROMPT_ERROR, "deadline"))).toBe("uncertain");
		expect(sendAfterFailure(failure(START_ERROR, "transport"))).toBe("uncertain");
		expect(sendAfterFailure(failure(TRANSPORT_ERROR, "disconnected"))).toBe("uncertain");
		expect(sendAfterFailure(failure(TRANSPORT_ERROR, "protocol"))).toBe("uncertain");
	});

	it("leaves a send alone when the failure is about some other call", () => {
		expect(sendAfterFailure(failure(MODE_UNSUPPORTED, null))).toBeNull();
		expect(sendAfterFailure(failure(PAGE_ERROR, "unknown-cursor"))).toBeNull();
	});
});

describe("the ledger", () => {
	const pending = (key: string): SendOutcome => ({key, state: "pending", turn: "unstarted"});

	it("keeps one row per key, newest wins", () => {
		const once = noteSend([], pending("k1"));
		const twice = noteSend(once, {key: "k1", state: "accepted"});
		expect(twice).toEqual([{key: "k1", state: "accepted"}]);
		expect(sendOutcome(twice, "k1")).toEqual({key: "k1", state: "accepted"});
		expect(sendOutcome(twice, "k2")).toBeNull();
	});

	it("drops the oldest rows past its bound, so a checkpoint cannot grow on sends", () => {
		const many = Array.from({length: sendLimit + 4}, (_, index) => `k${index}`).reduce(
			(held, key) => noteSend(held, {key, state: "accepted"}),
			[] as ReadonlyArray<SendOutcome>,
		);
		expect(many.length).toBe(sendLimit);
		expect(many[0]?.key).toBe("k4");
	});

	it("settles the one send in flight, and nothing else", () => {
		const held = noteSend(noteSend([], {key: "old", state: "accepted"}), pending("live"));
		expect(pendingSend(held)?.key).toBe("live");

		const refused = settleFailedTurn(held, failure(PROMPT_ERROR, "refused"));
		expect(sendOutcome(refused, "live")).toMatchObject({state: "refused"});
		expect(sendOutcome(refused, "old")).toEqual({key: "old", state: "accepted"});

		// The failure names another call, so the send in flight is still in flight.
		expect(settleFailedTurn(held, failure(MODE_UNSUPPORTED, null))).toEqual(held);
		// Nothing in flight, nothing to settle.
		expect(
			settleFailedTurn([{key: "old", state: "accepted"}], failure(PROMPT_ERROR, "refused")),
		).toEqual([{key: "old", state: "accepted"}]);
	});

	it("settles a send the session lost its footing under as uncertain, with no failure to name", () => {
		expect(settleEndedSession([pending("live")], null)).toEqual([
			{key: "live", state: "uncertain", failure: null},
		]);
	});

	it("accepts the send in flight when the turn is provably running", () => {
		const running = markTurnRunning([pending("live")]);
		expect(running).toEqual([{key: "live", state: "pending", turn: "running"}]);
		expect(settleAccepted(running)).toEqual([{key: "live", state: "accepted"}]);
		expect(settleAccepted([])).toEqual([]);
	});

	/** #8107: no layer said the backend began a turn, so nothing here is that turn's end. */
	it("leaves a send whose turn never started pending", () => {
		expect(settleAccepted([pending("live")])).toEqual([pending("live")]);
	});

	/**
	 * #8107, with two sends in flight — the shape a stale `ready` opens. Order is the correlation,
	 * so every row here is about position: the turn begins for the oldest send waiting for one, the
	 * rewrite leaves that send where it stood, and the accept reaches the running turn's send and
	 * not whichever pending row happens to come first.
	 */
	it("gives each turn to the oldest send still waiting for one", () => {
		const both = [pending("first"), pending("second")];

		const running = markTurnRunning(both);
		expect(running).toEqual([{key: "first", state: "pending", turn: "running"}, pending("second")]);
		expect(runningSend(running)?.key).toBe("first");

		const first = settleAccepted(running);
		expect(first).toEqual([{key: "first", state: "accepted"}, pending("second")]);
		// Nothing is running now, so a `ready` arriving before the next turn begins accepts nothing.
		expect(settleAccepted(first)).toEqual(first);

		const second = settleAccepted(markTurnRunning(first));
		expect(second).toEqual([
			{key: "first", state: "accepted"},
			{key: "second", state: "accepted"},
		]);
	});

	/**
	 * The Claude row's queue order: `prompting` is published at the send, so a second send under a
	 * live turn queues both beginnings ahead of either end (`claude/agent/ClaudeAiAgent.ts`). Two
	 * turns are then running at once, and the ends still pair off oldest-first.
	 */
	it("pairs each turn's end with its own beginning when two begin before either ends", () => {
		const bothRunning = markTurnRunning(markTurnRunning([pending("first"), pending("second")]));
		expect(bothRunning).toEqual([
			{key: "first", state: "pending", turn: "running"},
			{key: "second", state: "pending", turn: "running"},
		]);

		const first = settleAccepted(bothRunning);
		expect(first).toEqual([
			{key: "first", state: "accepted"},
			{key: "second", state: "pending", turn: "running"},
		]);
		expect(settleAccepted(first)).toEqual([
			{key: "first", state: "accepted"},
			{key: "second", state: "accepted"},
		]);
	});

	it("settles every send in flight when the session ends under them", () => {
		const refusal = failure(PROMPT_ERROR, "refused");
		const running = markTurnRunning([pending("first"), pending("second")]);
		expect(settleEndedSession(running, refusal)).toEqual([
			{key: "first", state: "refused", failure: refusal},
			{key: "second", state: "uncertain", failure: refusal},
		]);
		expect(settleEndedSession(running, null)).toEqual([
			{key: "first", state: "uncertain", failure: null},
			{key: "second", state: "uncertain", failure: null},
		]);
	});

	/**
	 * #8236's ruling: the session survives a per-turn refusal, so the sends it is not about keep
	 * their own turns coming. Rewriting them `uncertain` here made a row `runningSend` could no
	 * longer reach, and its turn's end then accepted nothing — the operator was told text might not
	 * have crossed when it did.
	 */
	it("leaves the sends a per-turn failure is not about pending, with their turn progress", () => {
		const refusal = failure(PROMPT_ERROR, "refused");
		const running = markTurnRunning([pending("first"), pending("second")]);
		expect(settleFailedTurn(running, refusal)).toEqual([
			{key: "first", state: "refused", failure: refusal},
			pending("second"),
		]);

		const bothRunning = markTurnRunning(running);
		expect(settleFailedTurn(bothRunning, refusal)).toEqual([
			{key: "first", state: "refused", failure: refusal},
			{key: "second", state: "pending", turn: "running"},
		]);
	});

	it("accepts a send that outlived a per-turn refusal when its own turn ends", () => {
		const refusal = failure(PROMPT_ERROR, "refused");
		const after = settleFailedTurn(markTurnRunning([pending("first"), pending("second")]), refusal);

		const second = settleAccepted(markTurnRunning(after));
		expect(second).toEqual([
			{key: "first", state: "refused", failure: refusal},
			{key: "second", state: "accepted"},
		]);
	});

	it("marks nothing running when no send is in flight", () => {
		const settled = [{key: "old", state: "accepted"} as const];
		expect(markTurnRunning(settled)).toEqual(settled);
		expect(markTurnRunning([])).toEqual([]);
	});

	it("writes a failure onto the key it belongs to", () => {
		const refusal = failure(PROMPT_ERROR, "refused");
		expect(settledBy("k1", refusal)).toEqual({key: "k1", state: "refused", failure: refusal});
		const doubt = failure(TRANSPORT_ERROR, "disconnected");
		expect(settledBy("k1", doubt)).toEqual({key: "k1", state: "uncertain", failure: doubt});
	});
});
