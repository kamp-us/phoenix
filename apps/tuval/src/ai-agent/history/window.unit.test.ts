import {describe, expect, it} from "vitest";
import {
	assistantItem,
	randomStream,
	randomTranscript,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import {isTranscriptPayload, type TranscriptItem} from "../ports/index.ts";
import {groupTranscript, itemBytes} from "./groups.ts";
import {
	planTranscriptWindow,
	TRANSCRIPT_WINDOW_BYTE_LIMIT,
	TRANSCRIPT_WINDOW_ITEM_LIMIT,
} from "./window.ts";

const bytesOf = (items: ReadonlyArray<TranscriptItem>) =>
	items.reduce((total, item) => total + itemBytes(item), 0);

describe("the live-tail window", () => {
	it("declares both bounds", () => {
		expect(TRANSCRIPT_WINDOW_ITEM_LIMIT).toBe(40);
		expect(TRANSCRIPT_WINDOW_BYTE_LIMIT).toBe(256_000);
	});

	it("carries a whole short transcript with nothing omitted", () => {
		const history = [userItem("u1"), assistantItem("a1"), toolItem("t1")];
		const plan = planTranscriptWindow(history);
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;
		expect(plan.items.map((item) => item.id)).toEqual(["u1", "a1", "t1"]);
		expect(plan.omitted).toEqual({items: 0, bytes: 0, reason: "none"});
		expect(isTranscriptPayload(plan)).toBe(true);
	});

	it("drops whole oldest exchanges when the item bound bites, and says so", () => {
		const history = [
			userItem("u1"),
			assistantItem("a1"),
			userItem("u2"),
			assistantItem("a2"),
			userItem("u3"),
			assistantItem("a3"),
		];
		const plan = planTranscriptWindow(history, {itemLimit: 5});
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;
		expect(plan.items.map((item) => item.id)).toEqual(["u2", "a2", "u3", "a3"]);
		expect(plan.omitted).toEqual({
			items: 2,
			bytes: bytesOf(history.slice(0, 2)),
			reason: "item-limit",
		});
	});

	it("names the byte bound when that is what bit", () => {
		const history = [
			userItem("u1", "x".repeat(400)),
			assistantItem("a1", "x".repeat(400)),
			userItem("u2", "hi"),
			assistantItem("a2", "there"),
		];
		const plan = planTranscriptWindow(history, {byteLimit: 500});
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;
		expect(plan.items.map((item) => item.id)).toEqual(["u2", "a2"]);
		expect(plan.omitted.reason).toBe("byte-limit");
	});

	it("returns an empty window rather than half an exchange the bound cannot hold", () => {
		const history = [userItem("u1"), assistantItem("a1"), toolItem("t1")];
		const plan = planTranscriptWindow(history, {itemLimit: 2});
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;
		expect(plan.items).toEqual([]);
		expect(plan.omitted).toEqual({items: 3, bytes: bytesOf(history), reason: "item-limit"});
	});

	it("ends just older than a cursor that opens a group", () => {
		const history = [userItem("u1"), assistantItem("a1"), userItem("u2"), assistantItem("a2")];
		const plan = planTranscriptWindow(history, {before: "u2"});
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;
		expect(plan.items.map((item) => item.id)).toEqual(["u1", "a1"]);
	});
});

describe("the window refuses rather than cutting", () => {
	const history = [userItem("u1"), assistantItem("a1"), toolItem("t1"), userItem("u2")];

	it("refuses a boundary that would split an atomic group", () => {
		expect(planTranscriptWindow(history, {before: "t1"})).toEqual({
			kind: "refused",
			reason: "cursor-splits-group",
			cursor: "t1",
		});
		expect(planTranscriptWindow(history, {before: "a1"})).toEqual({
			kind: "refused",
			reason: "cursor-splits-group",
			cursor: "a1",
		});
	});

	it("refuses a cursor no item carries", () => {
		expect(planTranscriptWindow(history, {before: "gone"})).toEqual({
			kind: "refused",
			reason: "cursor-not-found",
			cursor: "gone",
		});
	});

	it("refuses a bound that is not a positive integer", () => {
		expect(planTranscriptWindow(history, {itemLimit: 0})).toEqual({
			kind: "refused",
			reason: "limit-not-positive",
			limit: 0,
		});
		expect(planTranscriptWindow(history, {byteLimit: 1.5})).toEqual({
			kind: "refused",
			reason: "limit-not-positive",
			limit: 1.5,
		});
	});
});

describe("the window holds both bounds over random transcripts", () => {
	it("never exceeds either bound and never splits a group, across 200 seeds", () => {
		const failures: Array<string> = [];
		for (let seed = 1; seed <= 200; seed += 1) {
			const random = randomStream(seed * 7919);
			const history = randomTranscript(seed, {groups: 4 + random.int(14)});
			const itemLimit = 1 + random.int(20);
			const byteLimit = 200 + random.int(4_000);
			const plan = planTranscriptWindow(history, {itemLimit, byteLimit});
			if (plan.kind !== "window") {
				failures.push(`seed ${seed}: refused ${plan.reason}`);
				continue;
			}
			const ids = plan.items.map((item) => item.id);
			const tail = history.slice(plan.start).map((item) => item.id);
			if (plan.items.length > itemLimit)
				failures.push(`seed ${seed}: ${ids.length} > ${itemLimit}`);
			if (bytesOf(plan.items) > byteLimit) failures.push(`seed ${seed}: over the byte bound`);
			if (JSON.stringify(ids) !== JSON.stringify(tail)) {
				failures.push(`seed ${seed}: window is not the newest tail`);
			}
			const split = groupTranscript(history).some((group) => {
				const inside = group.items.filter((item) => ids.includes(item.id)).length;
				return inside !== 0 && inside !== group.items.length;
			});
			if (split) failures.push(`seed ${seed}: split an atomic group`);
			const dropped = history.slice(0, plan.start);
			if (plan.omitted.items !== dropped.length || plan.omitted.bytes !== bytesOf(dropped)) {
				failures.push(`seed ${seed}: omission metadata does not match what was dropped`);
			}
			if ((plan.omitted.reason === "none") !== (dropped.length === 0)) {
				failures.push(`seed ${seed}: omission reason disagrees with the drop`);
			}
		}
		expect(failures).toEqual([]);
	});
});
