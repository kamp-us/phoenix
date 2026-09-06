/**
 * The transcript half of the fold, over a turn that outgrows the bounds while it is still open.
 *
 * `foldItem` re-plans over `transcript.items` rather than over full history, so whatever a plan
 * leaves out is gone from state and reachable only by paging (#8031). That makes an empty accepted
 * plan unrecoverable, and this file is where that stays proven.
 */

import {describe, expect, it} from "vitest";
import {assistantItem, toolItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";
import type {TranscriptItem, TranscriptPayload} from "../ports/index.ts";
import {foldItem, type WindowLimits} from "./fold.ts";

const empty: TranscriptPayload = {items: [], omitted: {items: 0, bytes: 0, reason: "none"}};

/** Fold a stream item by item, answering the transcript after each one. */
const foldAll = (
	start: TranscriptPayload,
	stream: ReadonlyArray<TranscriptItem>,
	limits: WindowLimits,
): ReadonlyArray<TranscriptPayload> => {
	const steps: Array<TranscriptPayload> = [];
	let transcript = start;
	for (const item of stream) {
		transcript = foldItem(transcript, item, limits);
		steps.push(transcript);
	}
	return steps;
};

describe("folding a turn that outgrows the bounds", () => {
	it("never empties the tail while the open group is still growing", () => {
		const turn = [
			userItem("u1"),
			...Array.from({length: 11}, (_, index) => toolItem(`t${index}`)),
			assistantItem("a1"),
		];
		const steps = foldAll(empty, turn, {itemLimit: 5});
		expect(steps.map((step) => step.items.length)).toEqual(turn.map((_, index) => index + 1));
		expect(steps.at(-1)?.items).toEqual(turn);
		expect(steps.at(-1)?.omitted).toEqual({items: 0, bytes: 0, reason: "none"});
	});

	it("drops the exchange before it once, and keeps the growing one whole", () => {
		const older = [userItem("u0"), assistantItem("a0")];
		const turn = [userItem("u1"), ...Array.from({length: 8}, (_, index) => toolItem(`t${index}`))];
		const seeded = foldAll(empty, older, {itemLimit: 5}).at(-1) ?? empty;
		const steps = foldAll(seeded, turn, {itemLimit: 5});
		expect(steps.every((step) => step.items.length > 0)).toBe(true);
		expect(steps.at(-1)?.items).toEqual(turn);
		expect(steps.at(-1)?.omitted.items).toBe(older.length);
		expect(steps.at(-1)?.omitted.reason).toBe("item-limit");
	});
});
