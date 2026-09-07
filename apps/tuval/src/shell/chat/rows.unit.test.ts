/**
 * The transcript stitch, without a DOM. Everything the component decides about *which* rows exist —
 * the single head row, the page cursor, the anchor lookup, the de-duplication a prepend needs — is
 * decided here, so it is proven here.
 */

import {describe, expect, it} from "vitest";
import {promptItem} from "../../ai-agent/core/fold.ts";
import {planTranscriptPage, planTranscriptWindow} from "../../ai-agent/history/index.ts";
import {ItemId} from "../../ai-agent/ports/index.ts";
import {
	assistantItem,
	call,
	systemItem,
	thinkingItem,
	toolItem,
	transcriptOf,
	userItem,
} from "./chat.testing.ts";
import type {ChatRow} from "./rows.ts";
import {chatRows, mergeOlder, oldestLoadedId, rowIndexOfItem, rowKey} from "./rows.ts";

const base = {older: [], tail: [], omitted: 0, loading: false, atOldest: false};

/** The operator's turn exactly as the core records it on send: `local: true` under a `local:` id. */
const sent = (key: string, text: string) => promptItem({text, key, timestamp: 1_756_000_000_000});

const itemIds = (rows: ReadonlyArray<ChatRow>): ReadonlyArray<string> =>
	rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []));

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

	it("replaces the omitted line with the refusal detail and keeps the history cursor", () => {
		const rows = chatRows({
			...base,
			tail: transcriptOf(2),
			omitted: 4,
			pageError: "The history cursor is unknown.",
		});
		expect(rows.map((row) => row.kind)).toEqual(["page-error", "item", "item"]);
		expect(rows[0]).toEqual({kind: "page-error", detail: "The history cursor is unknown."});
		expect(oldestLoadedId(rows)).toBe("i0");
		expect(rowKey({kind: "page-error", detail: "The history cursor is unknown."})).toBe(
			"page-error",
		);
	});

	it("shows loading instead of a prior refusal while retrying", () => {
		const rows = chatRows({
			...base,
			tail: transcriptOf(2),
			pageError: "The history cursor is unknown.",
			loading: true,
		});
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

describe("chatRows folds a subagent's calls under the call that spawned it", () => {
	const group = [
		call("agent", {name: "Agent"}),
		call("child-1", {parentId: "agent"}),
		call("child-2", {parentId: "agent"}),
		call("own", {name: "Bash"}),
	];

	it("shows the group head with its count and hides the calls under it while collapsed", () => {
		const rows = chatRows({...base, tail: group, atOldest: true});
		expect(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
			"agent",
			"own",
		]);
		const head = rows[0];
		expect(head?.kind === "item" && head.nestedIds).toEqual(["child-1", "child-2"]);
		expect(head?.kind === "item" && head.nested).toBe(false);
		expect(head?.kind === "item" && head.depth).toBe(0);
	});

	it("lays the folded calls out under the head once it is expanded, marked nested", () => {
		const rows = chatRows({
			...base,
			tail: group,
			atOldest: true,
			unfolded: new Set(["agent"]),
		});
		expect(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
			"agent",
			"child-1",
			"child-2",
			"own",
		]);
		expect(rows.flatMap((row) => (row.kind === "item" && row.nested ? [row.item.id] : []))).toEqual(
			["child-1", "child-2"],
		);
	});

	it("leaves a row whose parent is not loaded in place, marked nested and heading nothing", () => {
		const orphan = call("child-1", {parentId: "agent"});
		const rows = chatRows({...base, tail: [orphan], atOldest: true});
		expect(rows).toEqual([{kind: "item", item: orphan, nestedIds: [], nested: true, depth: 1}]);
	});

	it("gives a folded row that is itself a group head its own count and its own children", () => {
		// The one-level fold used to drop this shape whole: the grandchild was skipped by the head
		// loop because its parent was present, and pushed by no other loop, so it appeared nowhere and
		// its parent's head line read no count (#8027).
		const deep = [
			call("agent", {name: "Agent"}),
			call("inner", {name: "Agent", parentId: "agent"}),
			call("leaf", {parentId: "inner"}),
		];
		const both = chatRows({
			...base,
			tail: deep,
			atOldest: true,
			unfolded: new Set(["agent", "inner"]),
		});
		expect(both).toEqual([
			{kind: "item", item: deep[0], nestedIds: ["inner"], nested: false, depth: 0},
			{kind: "item", item: deep[1], nestedIds: ["leaf"], nested: true, depth: 1},
			{kind: "item", item: deep[2], nestedIds: [], nested: true, depth: 2},
		]);

		const outerOnly = chatRows({...base, tail: deep, atOldest: true, unfolded: new Set(["agent"])});
		expect(outerOnly.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
			"agent",
			"inner",
		]);
		expect(outerOnly[1]?.kind === "item" && outerOnly[1].nestedIds).toEqual(["leaf"]);
	});

	it("emits every marked row exactly once even when the parent chain loops back on itself", () => {
		const cycle = [call("a", {parentId: "b"}), call("b", {parentId: "a"}), call("free")];
		const rows = chatRows({...base, tail: cycle, atOldest: true, unfolded: new Set(["a", "b"])});
		expect(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
			"free",
			"a",
			"b",
		]);
	});

	it("folds a subagent's own reply and reasoning under its head, not just its calls", () => {
		const inside = ItemId.make("agent");
		const prose = [
			call("agent", {name: "Agent"}),
			{...assistantItem("reply"), parentId: inside},
			{...thinkingItem("weighing"), parentId: inside},
			call("child", {parentId: "agent"}),
		];
		const collapsed = chatRows({...base, tail: prose, atOldest: true});
		expect(itemIds(collapsed)).toEqual(["agent"]);
		expect(collapsed[0]?.kind === "item" && collapsed[0].nestedIds).toEqual([
			"reply",
			"weighing",
			"child",
		]);

		const open = chatRows({...base, tail: prose, atOldest: true, unfolded: new Set(["agent"])});
		expect(open.flatMap((row) => (row.kind === "item" ? [[row.item.id, row.depth]] : []))).toEqual([
			["agent", 0],
			["reply", 1],
			["weighing", 1],
			["child", 1],
		]);
	});

	it("leaves a row whose parent is a session notice in place rather than behind it", () => {
		const notice = systemItem("note");
		const child = call("child", {parentId: "note"});
		const rows = chatRows({...base, tail: [notice, child], atOldest: true});
		expect(rows).toEqual([
			{kind: "session", items: [notice]},
			{kind: "item", item: child, nestedIds: [], nested: true, depth: 1},
		]);
	});

	it("leaves a transcript with no parent marked on it exactly as it was", () => {
		const flat = [call("a"), call("b")];
		const rows = chatRows({...base, tail: flat, atOldest: true});
		expect(rows).toEqual([
			{kind: "item", item: flat[0], nestedIds: [], nested: false, depth: 0},
			{kind: "item", item: flat[1], nestedIds: [], nested: false, depth: 0},
		]);
	});
});

describe("a page carrying a turn the layer never echoed back", () => {
	// The layer emits no `user` item, so the send keeps its `local:` id forever; the layer's own
	// history store still returns that turn under the layer's id, and an id-only stitch renders
	// both (#7998).
	const local = sent("k1", "merhaba");
	const fromLayer = userItem("uuid-1", "merhaba");

	it("renders the turn once, keeping the copy the tail already holds", () => {
		const rows = chatRows({...base, older: [fromLayer], tail: [local], atOldest: true});
		expect(itemIds(rows)).toEqual(["local:k1"]);
	});

	it("keeps that row's key stable across the prepend, so the measurement cache survives", () => {
		const beforePage = chatRows({...base, tail: [local], atOldest: true});
		const afterPage = chatRows({
			...base,
			older: [userItem("uuid-0", "önce"), fromLayer],
			tail: [local],
			atOldest: true,
		});
		expect(beforePage.map(rowKey)).toEqual(["item:local:k1"]);
		expect(afterPage.map(rowKey)).toEqual(["item:uuid-0", "item:local:k1"]);
	});

	it("leaves two deliberate sends of the same text as two rows", () => {
		const rows = chatRows({
			...base,
			older: [userItem("uuid-1", "merhaba"), userItem("uuid-2", "merhaba")],
			tail: [sent("k1", "merhaba"), sent("k2", "merhaba")],
			atOldest: true,
		});
		expect(itemIds(rows)).toEqual(["local:k1", "local:k2"]);
	});

	it("spends one unconfirmed turn on one page copy, and drops the newest of them", () => {
		const rows = chatRows({
			...base,
			older: [userItem("uuid-1", "merhaba"), userItem("uuid-2", "merhaba")],
			tail: [sent("k2", "merhaba")],
			atOldest: true,
		});
		expect(itemIds(rows)).toEqual(["uuid-1", "local:k2"]);
	});

	it("still joins a confirmed tail item by id alone, matching text or not", () => {
		const rows = chatRows({
			...base,
			older: [userItem("uuid-1", "merhaba"), userItem("uuid-2", "merhaba")],
			tail: [userItem("uuid-2", "merhaba")],
			atOldest: true,
		});
		expect(itemIds(rows)).toEqual(["uuid-1", "uuid-2"]);
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

	it("drops a page copy of a turn it already holds as unconfirmed, and keeps dropping it", () => {
		const held = [sent("k1", "merhaba"), assistantItem("d")];
		const first = mergeOlder(held, [userItem("uuid-0", "önce"), userItem("uuid-1", "merhaba")]);
		expect(first.map((item) => item.id)).toEqual(["uuid-0", "local:k1", "d"]);
		expect(mergeOlder(first, [userItem("uuid-1", "merhaba")])).toBe(first);
	});

	it("leaves a page copy alone when the held turn is confirmed, whatever its text", () => {
		const held = [userItem("b", "merhaba")];
		expect(mergeOlder(held, [userItem("a", "merhaba")]).map((item) => item.id)).toEqual(["a", "b"]);
	});

	it("never lets one unconfirmed turn cancel two page copies of the same text", () => {
		const held = [sent("k1", "merhaba")];
		const merged = mergeOlder(held, [userItem("a", "merhaba"), userItem("b", "merhaba")]);
		expect(merged.map((item) => item.id)).toEqual(["a", "local:k1"]);
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
		expect(
			rowKey({kind: "item", item: assistantItem("x"), nestedIds: [], nested: false, depth: 0}),
		).toBe("item:x");
		expect(rowKey({kind: "loading"})).toBe("loading");
		expect(rowKey({kind: "older", items: 3})).toBe("older");
	});

	it("keys a session run on its first notice, so the key holds as the run grows", () => {
		expect(rowKey({kind: "session", items: [systemItem("s1"), systemItem("s2")]})).toBe(
			"session:s1",
		);
	});
});

/**
 * The rabbit-hole this window is built to avoid: the SDK's fifteen-odd `system` subtypes arriving
 * as fifteen-odd row shapes, and a burst of hook frames pushing the transcript around per frame.
 * Both are answered here, before any component sees a row.
 */
describe("consecutive session notices", () => {
	const kinds = (rows: ReadonlyArray<ChatRow>): ReadonlyArray<string> =>
		rows.map((row) => row.kind);

	it("become one row rather than one row each", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go"),
				systemItem("s1", "hook started"),
				systemItem("s2", "hook running"),
				systemItem("s3", "hook finished"),
				assistantItem("a", "done"),
			],
		});
		expect(kinds(rows)).toEqual(["item", "session", "item"]);
		const run = rows[1];
		expect(run?.kind === "session" ? run.items.map((item) => item.id) : []).toEqual([
			"s1",
			"s2",
			"s3",
		]);
	});

	it("stay two runs when a turn lands between them", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [systemItem("s1"), assistantItem("a", "done"), systemItem("s2")],
		});
		expect(kinds(rows)).toEqual(["session", "item", "session"]);
	});

	it("carry the page cursor and the prepend anchor like any other row", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [systemItem("s1"), systemItem("s2"), assistantItem("a", "done")],
		});
		expect(oldestLoadedId(rows)).toBe("s1");
		// Membership, not the run's key: an anchor may name a notice buried mid-run.
		expect(rowIndexOfItem(rows, "s2")).toBe(0);
		expect(rowIndexOfItem(rows, "a")).toBe(1);
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

/**
 * The removal (#8405). A subagent's work is read in the running list and in the view Q7 switches
 * to, never as rows in the agent's own transcript — so an item whose parent chain reaches a
 * spawning call the session holds a slot for is not emitted at all.
 *
 * `subagents` is the whole of what turns this on, which is what keeps the distinction above from
 * being an assertion: every case in the fold describe passes none, and every one of them still
 * folds exactly as it did.
 */
describe("chatRows leaves a subagent's rows out of the agent window", () => {
	const spawned = [
		call("agent", {name: "Agent"}),
		call("child-1", {parentId: "agent"}),
		{...assistantItem("reply"), parentId: ItemId.make("agent")},
		{...thinkingItem("weighing"), parentId: ItemId.make("agent")},
		call("own", {name: "Bash"}),
	];

	it("emits the spawning call as a plain row heading nothing, and none of its rows", () => {
		const rows = chatRows({
			...base,
			tail: spawned,
			atOldest: true,
			subagents: new Set(["agent"]),
		});
		expect(itemIds(rows)).toEqual(["agent", "own"]);
		expect(rows[0]?.kind === "item" && rows[0].nestedIds).toEqual([]);
	});

	it("keeps them out even with the head's fold open, since there is nothing left to disclose", () => {
		const rows = chatRows({
			...base,
			tail: spawned,
			atOldest: true,
			subagents: new Set(["agent"]),
			unfolded: new Set(["agent"]),
		});
		expect(itemIds(rows)).toEqual(["agent", "own"]);
	});

	it("reaches every depth, on a transcript where a subagent spawns a subagent (Q5)", () => {
		const deep = [
			call("agent", {name: "Agent"}),
			call("inner", {name: "Agent", parentId: "agent"}),
			call("leaf", {parentId: "inner"}),
			{...assistantItem("inner-reply"), parentId: ItemId.make("inner")},
			call("own", {name: "Bash"}),
		];
		const rows = chatRows({
			...base,
			tail: deep,
			atOldest: true,
			// Only the outer call is a slot the session holds: the inner one is a row of the outer
			// worker, so the walk has to reach it through its parent rather than through the set.
			subagents: new Set(["agent"]),
			unfolded: new Set(["agent", "inner"]),
		});
		expect(itemIds(rows)).toEqual(["agent", "own"]);
	});

	it("leaves an ordinary tool call's own fold exactly as it is, subagents or not", () => {
		const mixed = [
			call("agent", {name: "Agent"}),
			call("child-1", {parentId: "agent"}),
			call("plain", {name: "Bash"}),
			call("plain-child", {parentId: "plain"}),
		];
		const rows = chatRows({
			...base,
			tail: mixed,
			atOldest: true,
			subagents: new Set(["agent"]),
			unfolded: new Set(["plain"]),
		});
		expect(itemIds(rows)).toEqual(["agent", "plain", "plain-child"]);
		expect(rows[1]?.kind === "item" && rows[1].nestedIds).toEqual(["plain-child"]);
	});

	it("keeps a finished worker's rows out too, so a stopped slot does not flood the window back", () => {
		const rows = chatRows({...base, tail: spawned, atOldest: true, subagents: new Set(["agent"])});
		expect(itemIds(rows)).toEqual(["agent", "own"]);
	});

	it("emits every row when the session holds no slots at all, which is the flag-off window", () => {
		const rows = chatRows({...base, tail: spawned, atOldest: true, subagents: new Set()});
		expect(itemIds(rows)).toEqual(["agent", "own"]);
		expect(rows[0]?.kind === "item" && rows[0].nestedIds).toEqual(["child-1", "reply", "weighing"]);
	});

	it("drops a row of a subagent whose own spawning call is older than the loaded pages", () => {
		const orphan = call("child", {parentId: "agent"});
		const rows = chatRows({...base, tail: [orphan], atOldest: true, subagents: new Set(["agent"])});
		expect(rows).toEqual([]);
	});
});
