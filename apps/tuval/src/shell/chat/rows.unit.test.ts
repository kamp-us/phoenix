/**
 * The transcript stitch, without a DOM. Everything the component decides about *which* rows exist —
 * the single head row, the page cursor, the anchor lookup, the de-duplication a prepend needs — is
 * decided here, so it is proven here.
 */

import {describe, expect, it} from "vitest";
import {planTranscriptPage, planTranscriptWindow} from "../../ai-agent/history/index.ts";
import {assistantItem, toolItem, transcriptOf, userItem} from "./chat.testing.ts";
import {chatRows, mergeOlder, oldestLoadedId, rowIndexOfItem, rowKey} from "./rows.ts";

const base = {older: [], tail: [], omitted: 0, loading: false, atOldest: false};

describe("chatRows", () => {
	it("puts one head row above the transcript while there is history behind it", () => {
		const rows = chatRows({...base, tail: transcriptOf(3), omitted: 12});
		expect(rows.map((row) => row.kind)).toEqual(["older", "item", "item", "item"]);
		const head = rows[0];
		expect(head?.kind).toBe("older");
		if (head?.kind === "older") expect(head.items).toBe(12);
	});

	it("replaces the omitted line with the loading row rather than showing both", () => {
		const rows = chatRows({...base, tail: transcriptOf(2), omitted: 4, loading: true});
		expect(rows.map((row) => row.kind)).toEqual(["loading", "item", "item"]);
	});

	it("drops the head row at the beginning of history", () => {
		const rows = chatRows({...base, tail: transcriptOf(2), atOldest: true});
		expect(rows.map((row) => row.kind)).toEqual(["item", "item"]);
	});

	it("shows no head row on an empty transcript", () => {
		expect(chatRows(base)).toEqual([]);
	});

	it("puts the walked-back pages before the live tail and drops what the tail already holds", () => {
		const older = [userItem("a"), assistantItem("b"), userItem("c")];
		const tail = [userItem("c"), assistantItem("d")];
		const rows = chatRows({...base, older, tail, atOldest: true});
		expect(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	});
});

describe("mergeOlder", () => {
	it("prepends a page oldest-first and never doubles an item it already holds", () => {
		const held = [userItem("c"), assistantItem("d")];
		const merged = mergeOlder(held, [userItem("a"), assistantItem("b"), userItem("c")]);
		expect(merged.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("returns the same array when the page adds nothing, so no re-render is provoked", () => {
		const held = [userItem("a")];
		expect(mergeOlder(held, [userItem("a")])).toBe(held);
	});
});

describe("the page cursor and the prepend anchor", () => {
	it("names the oldest item the window holds, never the head row", () => {
		const rows = chatRows({...base, tail: transcriptOf(3), omitted: 1});
		expect(rows[0]?.kind).toBe("older");
		expect(oldestLoadedId(rows)).toBe("i0");
	});

	it("has no cursor on an empty transcript", () => {
		expect(oldestLoadedId([])).toBeNull();
	});

	it("finds the anchor row wherever the prepend moved it, head row or not", () => {
		const anchor = "i0";
		const withHead = chatRows({...base, older: transcriptOf(3, "p"), tail: transcriptOf(2)});
		const atOldest = chatRows({
			...base,
			older: transcriptOf(3, "p"),
			tail: transcriptOf(2),
			atOldest: true,
		});
		expect(rowIndexOfItem(withHead, anchor)).toBe(4);
		expect(rowIndexOfItem(atOldest, anchor)).toBe(3);
		expect(rowIndexOfItem(withHead, "nothing")).toBe(-1);
		expect(rowIndexOfItem(withHead, null)).toBe(-1);
	});
});

describe("rowKey", () => {
	it("keys an item on its own id, so a status update does not remount its row", () => {
		expect(rowKey({kind: "item", item: assistantItem("x")})).toBe("item:x");
		expect(rowKey({kind: "loading"})).toBe("loading");
		expect(rowKey({kind: "older", items: 3})).toBe("older");
	});
});

describe("a live tail carrying an exchange the bounds cannot hold", () => {
	const older = [userItem("u0"), assistantItem("a0")];
	const turn = [userItem("u1"), ...Array.from({length: 44}, (_, index) => toolItem(`t${index}`))];
	const history = [...older, ...turn];

	it("pages the exchange older than it and renders every item once", () => {
		const live = planTranscriptWindow(history, {itemLimit: 5});
		expect(live.kind).toBe("window");
		if (live.kind !== "window") return;
		expect(live.items).toEqual(turn);

		const page = planTranscriptPage(history, {before: "u1", limit: 5});
		expect(page.kind).toBe("page");
		if (page.kind !== "page") return;
		expect(page.items).toEqual(older);
		expect(page.next).toBeNull();

		const rows = chatRows({
			older: mergeOlder([], page.items),
			tail: live.items,
			omitted: live.omitted.items,
			loading: false,
			atOldest: true,
		});
		const ids = rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []));
		expect(ids).toEqual(history.map((item) => item.id));
		expect(new Set(ids).size).toBe(ids.length);
	});
});
