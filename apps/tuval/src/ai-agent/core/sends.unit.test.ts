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
	type SendOutcome,
	sendAfterFailure,
	sendLimit,
	sendOutcome,
	settleAccepted,
	settledBy,
	settlePending,
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

		const refused = settlePending(held, failure(PROMPT_ERROR, "refused"));
		expect(sendOutcome(refused, "live")).toMatchObject({state: "refused"});
		expect(sendOutcome(refused, "old")).toEqual({key: "old", state: "accepted"});

		// The failure names another call, so the send in flight is still in flight.
		expect(settlePending(held, failure(MODE_UNSUPPORTED, null))).toEqual(held);
		// Nothing in flight, nothing to settle.
		expect(
			settlePending([{key: "old", state: "accepted"}], failure(PROMPT_ERROR, "refused")),
		).toEqual([{key: "old", state: "accepted"}]);
	});

	it("settles a send the session lost its footing under as uncertain, with no failure to name", () => {
		expect(settlePending([pending("live")], null)).toEqual([
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
