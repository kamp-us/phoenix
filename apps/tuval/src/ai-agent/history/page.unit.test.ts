import {describe, expect, it} from "vitest";
import {
	assistantItem,
	randomStream,
	randomTranscript,
	thinkingItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import {isTranscriptPagePayload, type TranscriptItem} from "../ports/index.ts";
import {pageCursor} from "./cursor.ts";
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

	it("joins a selected live cursor to stored history without changing the local anchor", () => {
		const local = {...userItem("local:send"), local: true};
		const cursor = pageCursor([local, assistantItem("live-reply")], local.id);
		expect(cursor).toEqual({kind: "page", before: "live-reply"});
		if (cursor.kind !== "page") return;
		const page = planTranscriptPage(history, {
			before: cursor.before,
			cursorAliases: new Map([["live-reply", "a3"]]),
			cursorBoundary: "containing-group",
			limit: 3,
		});
		expect(page.kind).toBe("page");
		if (page.kind === "page") expect(page.items.map((item) => item.id)).toEqual(["u2", "a2", "t2"]);
		expect(local.id).toBe("local:send");
	});

	it("preserves explicit newest reads, stored ids and group-boundary distinctions with aliases", () => {
		const cursorAliases = new Map([
			["u2", "u3"],
			["live-reply", "a3"],
		]);
		for (const before of [null, "u2"]) {
			expect(planTranscriptPage(history, {before, cursorAliases, limit: 3})).toEqual(
				planTranscriptPage(history, {before, limit: 3}),
			);
		}
		expect(planTranscriptPage(history, {before: "live-reply", cursorAliases, limit: 3})).toEqual({
			kind: "refused",
			reason: "cursor-splits-group",
			cursor: "a3",
		});
	});

	it("never turns an unknown live alias or an absent alias target into a newest read", () => {
		for (const cursorAliases of [new Map<string, string>(), new Map([["live", "missing"]])]) {
			const page = planTranscriptPage(history, {
				before: "live",
				cursorAliases,
				cursorBoundary: "containing-group",
				limit: 3,
			});
			expect(page.kind).toBe("refused");
			if (page.kind === "refused") expect(page.reason).toBe("cursor-not-found");
		}
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

describe("a local echo is not a stored page cursor", () => {
	const local = {...userItem("local:send", "latest prompt"), local: true};
	const stored = userItem("stored-user", local.text);
	const reply = assistantItem("stored-assistant");
	const older = [userItem("old-user"), assistantItem("old-assistant")];

	it("skips the local prompt and loads older whole exchanges from its stored reply", () => {
		const cursor = pageCursor([local, reply], local.id);
		expect(cursor).toEqual({kind: "page", before: reply.id});
		if (cursor.kind !== "page") return;
		const page = planTranscriptPage([...older, stored, reply], {
			before: cursor.before,
			limit: 10,
			cursorBoundary: "containing-group",
		});
		expect(page.kind).toBe("page");
		if (page.kind !== "page") return;
		expect(page.items).toEqual(older);
		expect(page.next).toBeNull();
	});

	it("has no request for an all-local tail or an evicted local cursor", () => {
		expect(pageCursor([local], local.id)).toEqual({kind: "unavailable"});
		expect(pageCursor([], local.id)).toEqual({kind: "unavailable"});
		expect(pageCursor([reply, local], local.id)).toEqual({kind: "unavailable"});
	});

	it("never selects a partial reply that need not have a stored frame", () => {
		const partial = {...reply, partial: true};
		expect(pageCursor([local, partial], local.id)).toEqual({kind: "unavailable"});
		expect(pageCursor([local, partial], partial.id)).toEqual({kind: "unavailable"});
		expect(pageCursor([local, partial, ...older], local.id)).toEqual({
			kind: "page",
			before: older[0]?.id,
		});
		expect(pageCursor([local, partial], null)).toEqual({kind: "page", before: null});
		expect(pageCursor([local, {...reply, partial: false}], local.id)).toEqual({
			kind: "page",
			before: reply.id,
		});
	});

	// Reasoning grows a partial row of its own (#8288), and it need not have a stored frame either.
	it("never selects reasoning that is still being written", () => {
		const growing = {...thinkingItem("stored-thinking"), partial: true};
		expect(pageCursor([local, growing], local.id)).toEqual({kind: "unavailable"});
		expect(pageCursor([local, growing], growing.id)).toEqual({kind: "unavailable"});
		expect(pageCursor([local, growing, ...older], local.id)).toEqual({
			kind: "page",
			before: older[0]?.id,
		});
		expect(pageCursor([local, thinkingItem("stored-thinking")], local.id)).toEqual({
			kind: "page",
			before: "stored-thinking",
		});
	});

	it("uses the domain marker even when the local id has no prefix", () => {
		const marked = {...local, id: stored.id};
		expect(pageCursor([marked, reply], marked.id)).toEqual({kind: "page", before: reply.id});
	});

	it("preserves an explicit newest read and stored cursors from window-owned older pages", () => {
		expect(pageCursor([local], null)).toEqual({kind: "page", before: null});
		expect(pageCursor([local, reply], "old-user")).toEqual({kind: "page", before: "old-user"});
		expect(pageCursor([local, reply], reply.id)).toEqual({kind: "page", before: reply.id});
	});

	it("still refuses an absent stored cursor in containing-group mode", () => {
		expect(
			planTranscriptPage(older, {
				before: "absent",
				limit: 10,
				cursorBoundary: "containing-group",
			}),
		).toEqual({kind: "refused", reason: "cursor-not-found", cursor: "absent"});
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
