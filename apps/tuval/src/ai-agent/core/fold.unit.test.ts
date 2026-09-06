/**
 * The transcript half of the fold, over a turn that outgrows the bounds while it is still open.
 *
 * `foldItem` re-plans over `transcript.items` rather than over full history, so whatever a plan
 * leaves out is gone from state and reachable only by paging (#8031). That makes an empty accepted
 * plan unrecoverable, and this file is where that stays proven.
 */

import {describe, expect, it} from "vitest";
import {
	assistantItem,
	compactionItem,
	systemItem,
	thinkingItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import type {TranscriptItem, TranscriptPayload} from "../ports/index.ts";
import {foldItem, upsertItem, type WindowLimits} from "./fold.ts";

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

describe("folding the thinking and compaction kinds", () => {
	it("supersedes a thinking row by id, so a growing one stays one row", () => {
		const first = thinkingItem("k1", "weighing the two reads");
		const grown = thinkingItem("k1", "weighing the two reads, then the write");
		expect(upsertItem(upsertItem([userItem("u1")], first), grown)).toEqual([userItem("u1"), grown]);
	});

	it("appends a compaction marker under a fresh id rather than replacing a neighbour", () => {
		const marker = compactionItem("c1");
		expect(upsertItem([userItem("u1"), assistantItem("a1")], marker)).toEqual([
			userItem("u1"),
			assistantItem("a1"),
			marker,
		]);
	});

	// `echoOf` is confined to `user` items, so a reasoning row repeating the prompt's own words
	// cannot be taken for the layer's echo of that prompt and overwrite it.
	it("never joins a thinking row onto a locally-recorded turn of the same text", () => {
		const local: TranscriptItem = {...userItem("u1", "run the tests"), local: true};
		const echoing = thinkingItem("k1", "run the tests");
		expect(upsertItem([local], echoing)).toEqual([local, echoing]);
	});

	it("bounds the tail over the new kinds, cutting at the compaction marker's own edge", () => {
		const stream = [
			systemItem("s0"),
			compactionItem("c0"),
			userItem("u1"),
			thinkingItem("k1"),
			assistantItem("a1"),
		];
		const bounded = foldAll(empty, stream, {itemLimit: 4}).at(-1);
		expect(bounded?.items).toEqual(stream.slice(1));
		expect(bounded?.omitted.items).toBe(1);
		expect(bounded?.omitted.reason).toBe("item-limit");
	});

	it("keeps a thinking row inside its turn, so the bound drops the marker before it", () => {
		const stream = [compactionItem("c0"), userItem("u1"), thinkingItem("k1"), assistantItem("a1")];
		const bounded = foldAll(empty, stream, {itemLimit: 3}).at(-1);
		expect(bounded?.items).toEqual(stream.slice(1));
		expect(bounded?.omitted.items).toBe(1);
	});
});
