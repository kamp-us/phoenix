import {describe, expect, it} from "vitest";
import {
	assistantItem,
	randomStream,
	randomTranscript,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import {isTranscriptPagePayload, type TranscriptItem} from "../ports/index.ts";
import {groupTranscript, itemBytes} from "./groups.ts";
import {planTranscriptPage} from "./page.ts";

const bytesOf = (items: ReadonlyArray<TranscriptItem>) =>
	items.reduce((total, item) => total + itemBytes(item), 0);

/** Walk from the newest end older until the cursor runs out, collecting each page. */
const walk = (history: ReadonlyArray<TranscriptItem>, limit: number) => {
	const pages: Array<ReadonlyArray<TranscriptItem>> = [];
	let before: string | null = null;
	for (let step = 0; step <= history.length + 1; step += 1) {
		const page = planTranscriptPage(history, {before, limit});
		if (page.kind !== "page") return {pages, refused: page.reason};
		pages.unshift(page.items);
		if (page.next === null) return {pages, refused: null};
		before = page.next;
	}
	return {pages, refused: "did-not-terminate"};
};

describe("the page bound", () => {
	const history = [
		userItem("u1"),
		assistantItem("a1"),
		userItem("u2"),
		assistantItem("a2"),
		toolItem("t2"),
		userItem("u3"),
		assistantItem("a3"),
	];

	it("answers the newest whole exchanges first, oldest-first inside the page", () => {
		const page = planTranscriptPage(history, {before: null, limit: 5});
		expect(page.kind).toBe("page");
		if (page.kind !== "page") return;
		expect(page.items.map((item) => item.id)).toEqual(["u2", "a2", "t2", "u3", "a3"]);
		expect(page.next).toBe("u2");
		expect(page.omitted).toEqual({
			items: 2,
			bytes: bytesOf(history.slice(0, 2)),
			reason: "item-limit",
		});
		expect(isTranscriptPagePayload(page)).toBe(true);
	});

	it("walks older from its own cursor and ends with a null next", () => {
		const older = planTranscriptPage(history, {before: "u2", limit: 4});
		expect(older.kind).toBe("page");
		if (older.kind !== "page") return;
		expect(older.items.map((item) => item.id)).toEqual(["u1", "a1"]);
		expect(older.next).toBe(null);
		expect(older.omitted).toEqual({items: 0, bytes: 0, reason: "none"});
	});

	it("emits an exchange larger than the limit whole, so paging never stalls", () => {
		const big = [userItem("u1"), assistantItem("a1"), toolItem("t1"), toolItem("t2")];
		const page = planTranscriptPage(big, {before: null, limit: 2});
		expect(page.kind).toBe("page");
		if (page.kind !== "page") return;
		expect(page.items.map((item) => item.id)).toEqual(["u1", "a1", "t1", "t2"]);
		expect(page.next).toBe(null);
	});

	it("names the byte bound when that is what stopped the page", () => {
		const wide = [
			userItem("u1", "x".repeat(400)),
			assistantItem("a1", "x".repeat(400)),
			userItem("u2", "hi"),
			assistantItem("a2", "there"),
		];
		const page = planTranscriptPage(wide, {before: null, limit: 40, byteLimit: 500});
		expect(page.kind).toBe("page");
		if (page.kind !== "page") return;
		expect(page.items.map((item) => item.id)).toEqual(["u2", "a2"]);
		expect(page.omitted.reason).toBe("byte-limit");
	});

	it("answers an empty history with an empty page and no cursor", () => {
		const page = planTranscriptPage([], {before: null, limit: 10});
		expect(page.kind).toBe("page");
		if (page.kind !== "page") return;
		expect(page.items).toEqual([]);
		expect(page.next).toBe(null);
	});

	it("refuses a cursor that splits a group, one that is absent, and a bound at zero", () => {
		expect(planTranscriptPage(history, {before: "a2", limit: 4})).toEqual({
			kind: "refused",
			reason: "cursor-splits-group",
			cursor: "a2",
		});
		expect(planTranscriptPage(history, {before: "gone", limit: 4})).toEqual({
			kind: "refused",
			reason: "cursor-not-found",
			cursor: "gone",
		});
		expect(planTranscriptPage(history, {before: null, limit: 0})).toEqual({
			kind: "refused",
			reason: "limit-not-positive",
			limit: 0,
		});
	});
});

describe("consecutive pages tile the history exactly", () => {
	it("leaves no overlap and no gap across 200 seeds", () => {
		const failures: Array<string> = [];
		for (let seed = 1; seed <= 200; seed += 1) {
			const random = randomStream(seed * 104_729);
			const history = randomTranscript(seed, {groups: 3 + random.int(15)});
			const limit = 1 + random.int(12);
			const {pages, refused} = walk(history, limit);
			if (refused !== null) {
				failures.push(`seed ${seed}: ${refused}`);
				continue;
			}
			const tiled = pages.flatMap((page) => page.map((item) => item.id));
			if (JSON.stringify(tiled) !== JSON.stringify(history.map((item) => item.id))) {
				failures.push(`seed ${seed}: pages do not tile the history`);
			}
			const groupOf = new Map<string, number>();
			groupTranscript(history).forEach((group, index) => {
				for (const item of group.items) groupOf.set(item.id, index);
			});
			const straddled = pages.some((page) => {
				const groups = new Set(page.map((item) => groupOf.get(item.id)));
				return [...groups].some((group) => {
					const size = history.filter((item) => groupOf.get(item.id) === group).length;
					return page.filter((item) => groupOf.get(item.id) === group).length !== size;
				});
			});
			if (straddled) failures.push(`seed ${seed}: a page split an atomic group`);
		}
		expect(failures).toEqual([]);
	});
});
