/**
 * What one window does with the text it has already sent, before any of it is rendered.
 *
 * The rule the rest of the slice rests on is the one about silence: a key the session has said
 * nothing about is neither recoverable nor droppable, so no path through `readHeld` lets go of text
 * on an answer that has not arrived.
 */

import {describe, expect, it} from "vitest";
import type {SendOutcome} from "../../ai-agent/core/index.ts";
import {
	asOutgoing,
	dropSend,
	heldLimit,
	holdSend,
	type OutgoingSend,
	readHeld,
	recoverInto,
} from "./outgoing.ts";

const refusal = {tag: "tuval/ai-agent/PromptError", reason: "refused", detail: "no"};

describe("holding a send", () => {
	it("keeps one copy per key and drops the oldest past its bound", () => {
		const held = Array.from({length: heldLimit + 2}, (_, index) => index).reduce(
			(carried, index) => holdSend(carried, {key: `k${index}`, text: `t${index}`}),
			[] as ReadonlyArray<OutgoingSend>,
		);
		expect(held.length).toBe(heldLimit);
		expect(held[0]?.key).toBe("k2");
		expect(holdSend(held, {key: "k2", text: "again"}).filter((send) => send.key === "k2")).toEqual([
			{key: "k2", text: "again"},
		]);
	});

	it("lets go of one key without touching the rest", () => {
		const held = holdSend(holdSend([], {key: "a", text: "one"}), {key: "b", text: "two"});
		expect(dropSend(held, "a")).toEqual([{key: "b", text: "two"}]);
		expect(dropSend(held, "missing")).toEqual(held);
	});
});

describe("reading what the session said about held sends", () => {
	const held: ReadonlyArray<OutgoingSend> = [
		{key: "quiet", text: "no answer yet"},
		{key: "running", text: "in flight"},
		{key: "landed", text: "took it"},
		{key: "refused", text: "never crossed"},
		{key: "doubtful", text: "might have crossed"},
	];
	const sends: ReadonlyArray<SendOutcome> = [
		{key: "running", state: "pending", turn: "unstarted"},
		{key: "landed", state: "accepted"},
		{key: "refused", state: "refused", failure: refusal},
		{key: "doubtful", state: "uncertain", failure: null},
	];

	it("offers back only what settled against the operator, and releases only what landed", () => {
		expect(readHeld(held, sends)).toEqual({
			unsent: [
				{key: "refused", text: "never crossed", reason: "refused"},
				{key: "doubtful", text: "might have crossed", reason: "uncertain"},
			],
			landed: ["landed"],
		});
	});

	it("holds on through silence: an unanswered key is neither offered back nor dropped", () => {
		expect(readHeld(held, [])).toEqual({unsent: [], landed: []});
	});

	// Two windows over one process read the same `sends` and hold their own keys, so the outcome one
	// of them earned reaches the other's list nowhere.
	it("reads only the keys this window holds", () => {
		expect(readHeld([{key: "mine", text: "mine"}], sends)).toEqual({unsent: [], landed: []});
	});
});

describe("recovering into the composer", () => {
	it("replaces an empty draft and goes above a newer one, so nothing typed since is lost", () => {
		expect(recoverInto("", "the long prompt")).toBe("the long prompt");
		expect(recoverInto("something newer", "the long prompt")).toBe(
			"the long prompt\n\nsomething newer",
		);
	});
});

describe("reading held sends back off the slot", () => {
	it("keeps the pairs and refuses everything else, bounded", () => {
		expect(
			asOutgoing([{key: "a", text: "one"}, {key: 1, text: "two"}, "three", null, {key: "b"}]),
		).toEqual([{key: "a", text: "one"}]);
		expect(asOutgoing(undefined)).toEqual([]);
		expect(asOutgoing("outgoing")).toEqual([]);
		expect(
			asOutgoing(Array.from({length: heldLimit + 3}, (_, index) => ({key: `k${index}`, text: "x"})))
				.length,
		).toBe(heldLimit);
	});
});
