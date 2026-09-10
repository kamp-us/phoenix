/**
 * The transcript stitch, without a DOM. Everything the component decides about *which* rows exist —
 * the single head row, the page cursor, the anchor lookup, the de-duplication a prepend needs — is
 * decided here, so it is proven here.
 */

import {describe, expect, it} from "vitest";
import {promptItem} from "../../ai-agent/core/fold.ts";
import {remarkCutReplies} from "../../ai-agent/core/state.ts";
import {planTranscriptPage, planTranscriptWindow} from "../../ai-agent/history/index.ts";
import {ItemId, type TranscriptItem} from "../../ai-agent/ports/index.ts";
import {subagentSlot} from "../../ai-agent-fixtures/transcripts.ts";
import {
	assistantItem,
	call,
	compactionItem,
	systemItem,
	thinkingItem,
	toolItem,
	transcriptOf,
	userItem,
} from "./chat.testing.ts";
import type {ChatRow} from "./rows.ts";
import {
	chatRows,
	mergeOlder,
	NO_SUBAGENTS,
	olderPageRequest,
	oldestLoadedId,
	rowIndexOfItem,
	rowKey,
	subagentHeads,
	subagentRows,
	turnDuration,
} from "./rows.ts";

const base = {older: [], tail: [], omitted: 0, loading: false, atOldest: false};

/** The operator's turn exactly as the core records it on send: `local: true` under a `local:` id. */
const sent = (key: string, text: string) => promptItem({text, key, timestamp: 1_756_000_000_000});

/**
 * A history row from a backend that keys its live tail in another id space: the row's own stored id,
 * plus the `item-<index>` the same turn carries in the tail (Pi, `pi/ai-agent/entries.ts`).
 */
const stored = <Item extends TranscriptItem>(item: Item, position: number): Item => ({
	...item,
	alias: ItemId.make(`item-${position}`),
});

const itemIds = (rows: ReadonlyArray<ChatRow>): ReadonlyArray<string> =>
	rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []));

/** Every transcript item a row carries, in list order — a run's calls included (#8612). */
const carriedIds = (rows: ReadonlyArray<ChatRow>): ReadonlyArray<string> =>
	rows.flatMap((row) => {
		if (row.kind === "item") return [row.item.id];
		if (row.kind === "tools") return row.calls.map((call) => call.id);
		return [];
	});

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
		expect(carriedIds(rows)).toEqual(["agent", "child-1", "child-2", "own"]);
		// The two worker calls are consecutive at one depth, so they are one run (#8612) — and the
		// run is marked nested, which is what the indent and the spoken author name both read.
		const run = rows[1];
		expect(run?.kind).toBe("tools");
		expect(run?.kind === "tools" && run.nested).toBe(true);
		expect(run?.kind === "tools" && run.depth).toBe(1);
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

	it("leaves a transcript with no parent marked on it unnested, at depth zero", () => {
		const flat = [call("a"), assistantItem("mid", "thinking about it"), call("b")];
		const rows = chatRows({...base, tail: flat, atOldest: true});
		expect(rows).toEqual([
			{kind: "item", item: flat[0], nestedIds: [], nested: false, depth: 0},
			{kind: "item", item: flat[1], nestedIds: [], nested: false, depth: 0},
			{kind: "item", item: flat[2], nestedIds: [], nested: false, depth: 0},
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

	it("drops a page copy the tail holds under the other id, and keeps dropping it", () => {
		const held = [userItem("item-0", "merhaba"), assistantItem("item-1", "hoş")];
		const first = mergeOlder(held, [userItem("e0", "önce"), stored(userItem("e1", "merhaba"), 0)]);
		expect(first.map((item) => item.id)).toEqual(["e0", "item-0", "item-1"]);
		expect(mergeOlder(first, [stored(userItem("e1", "merhaba"), 0)])).toBe(first);
	});
});

/**
 * The Pi shape #8032 reported: the live tail keys a turn `item-<index>` and the history page keys
 * the same turn by its session entry, so a single-id join renders it twice. The page row carries
 * the live id in `alias`, which is what the stitch matches on. The tail rows here are ordinary
 * confirmed rows — Pi echoes every turn, so the `local` mark is long gone by the time an operator
 * can page at all, and the text join has nothing to work with.
 */
describe("a page and a tail that key one turn in two id spaces", () => {
	it("emits one row for a user turn the page and the tail both carry", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [userItem("item-0", "merhaba")],
			older: [stored(userItem("e1", "merhaba"), 0)],
		});
		expect(itemIds(rows)).toEqual(["item-0"]);
	});

	it("emits one row for an assistant turn too, since the re-key is not the user turn's alone", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [assistantItem("item-1", "buyurun")],
			older: [stored(assistantItem("e2", "buyurun"), 1)],
		});
		expect(itemIds(rows)).toEqual(["item-1"]);
	});

	it("keeps two genuinely different turns of identical text as two rows", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [userItem("item-4", "merhaba")],
			older: [stored(userItem("e1", "merhaba"), 0), stored(userItem("e5", "merhaba"), 4)],
		});
		expect(itemIds(rows)).toEqual(["e1", "item-4"]);
	});
});

describe("the page cursor and the prepend anchor", () => {
	it("skips local echoes for the cursor but keeps one as the visual prepend anchor", () => {
		const local = {...userItem("local:send"), local: true};
		const tail = [local, assistantItem("stored-reply")];
		const rows = chatRows({...base, tail});
		expect(olderPageRequest(rows)).toEqual({before: "stored-reply", anchor: local.id});
		expect(oldestLoadedId(rows)).toBe(local.id);
		const prepended = chatRows({...base, tail, older: [userItem("older", "earlier prompt")]});
		expect(rowIndexOfItem(prepended, local.id)).toBe(2);
	});

	it("waits through the first partial reply without losing the local prepend anchor", () => {
		const local = {...userItem("local:send"), local: true};
		const reply = assistantItem("live-reply");
		const streaming = chatRows({...base, tail: [local, {...reply, partial: true}], omitted: 40});
		expect(olderPageRequest(streaming)).toBeNull();
		expect(oldestLoadedId(streaming)).toBe(local.id);
		const completed = chatRows({...base, tail: [local, reply], omitted: 40});
		expect(olderPageRequest(completed)).toEqual({before: reply.id, anchor: local.id});
	});

	it("makes no older request from only local rows, even with an omitted-history head", () => {
		const tail = [
			{...userItem("local:first"), local: true},
			{...userItem("local:second"), local: true},
		];
		const rows = chatRows({...base, tail, omitted: 40});
		expect(rows[0]?.kind).toBe("older");
		expect(olderPageRequest(rows)).toBeNull();
		expect(olderPageRequest([])).toBeNull();
	});

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
		const ids = carriedIds(rows);
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

/**
 * What the window's `subagents` memo answers, and the identity that makes flag-off cost nothing.
 * A fresh empty `Set` per worker frame would be a changed memo value on the one path the flag is
 * supposed to leave alone (review round 2 on #8405).
 */
describe("subagentHeads", () => {
	const slot = (id: string, lastLine: string) => subagentSlot(id, {lastLine});

	it("answers the very same set every time the flag is off, whatever the slots say", () => {
		const first = subagentHeads({a: slot("a", "reading")}, false);
		const second = subagentHeads({a: slot("a", "writing")}, false);
		expect(first).toBe(NO_SUBAGENTS);
		expect(second).toBe(first);
		expect([...first]).toEqual([]);
	});

	it("answers the same set for an absent slot record, so a window with no state costs nothing", () => {
		expect(subagentHeads(null, true)).toBe(NO_SUBAGENTS);
		expect(subagentHeads(undefined, true)).toBe(NO_SUBAGENTS);
	});

	it("names every spawning call the session holds a slot for when the flag is on", () => {
		const heads = subagentHeads({a: slot("a", "reading"), b: slot("b", "writing")}, true);
		expect([...heads].sort()).toEqual(["a", "b"]);
	});

	// The shared set is handed to `chatRows` and to nothing else, so a caller that mutated it would
	// silently hide rows in every window of the process.
	it("hands out a set nothing can add to", () => {
		expect(Object.isFrozen(NO_SUBAGENTS)).toBe(true);
	});
});

/**
 * The swapped-in view's own list (#8406, founder ruling Q7). The slot carries everything the worker
 * produced, so this is a build over one array with no page walk and no live-tail stitch. What it has
 * to get right is the depth: every row in the slot names the spawning call as its parent, and that
 * call is the agent's row rather than one of these.
 */
describe("subagentRows", () => {
	const under = (head: string) => ({parentId: ItemId.make(head)});

	it("reads the worker's own rows at depth zero, not as rows nested under a head it lacks", () => {
		// The worker's turn is settled, so its own summary row folds the trailing call away (#8614);
		// opened, all three of its rows are back in the list and the depth is what this is about.
		const rows = subagentRows(
			subagentSlot("agent", {
				items: [
					{...userItem("u1", "go and look"), ...under("agent")},
					{...assistantItem("a1", "looking"), ...under("agent")},
					call("t1", {parentId: "agent"}),
				],
			}),
			new Set(["turn:u1"]),
		);
		expect(itemIds(rows)).toEqual(["u1", "a1", "t1"]);
		expect(rows.every((row) => row.kind !== "item" || (!row.nested && row.depth === 0))).toBe(true);
	});

	it("has no head row: a subagent's rows arrive with its slot, and nothing older can be asked for", () => {
		const rows = subagentRows(
			subagentSlot("agent", {items: [{...userItem("u1", "go"), ...under("agent")}]}),
		);
		expect(rows.map((row) => row.kind)).toEqual(["item"]);
	});

	it("is empty for a worker that has written nothing yet", () => {
		expect(subagentRows(subagentSlot("agent"))).toEqual([]);
	});

	// A call the worker made itself heads a fold inside this view exactly as it does in the agent's,
	// so #8027's disclosure still holds one level in.
	it("still folds the calls the worker nested under its own", () => {
		const slot = subagentSlot("agent", {
			items: [
				call("t1", {parentId: "agent"}),
				{...assistantItem("nested", "reading"), ...under("t1")},
			],
		});
		const folded = subagentRows(slot);
		expect(itemIds(folded)).toEqual(["t1"]);
		expect(folded[0]?.kind === "item" && folded[0].nestedIds).toEqual(["nested"]);

		const open = subagentRows(slot, new Set(["t1"]));
		expect(itemIds(open)).toEqual(["t1", "nested"]);
		expect(open[1]?.kind === "item" && open[1].depth).toBe(1);
	});
});

/**
 * The run scan (#8612). Six reads are one line saying "Read 6 files", not six labelled blocks — so
 * what has to be proven here is where a run *ends*, because a boundary the scan misses is two
 * unrelated stretches of work read as one sentence.
 */
describe("chatRows collapses a run of consecutive tool calls", () => {
	const runAt = (rows: ReadonlyArray<ChatRow>, index: number) => {
		const row = rows[index];
		return row?.kind === "tools" ? row.calls.map((item) => item.id) : null;
	};

	it("groups a maximal span into one row carrying the calls in order", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			// Unfolded, because the turn is settled and the run is what its summary hides (#8614).
			unfolded: new Set(["turn:u"]),
			tail: [userItem("u", "go"), call("t1"), call("t2"), call("t3"), assistantItem("a", "done")],
		});
		expect(rows.map((row) => row.kind)).toEqual(["item", "turn", "tools", "item"]);
		expect(runAt(rows, 2)).toEqual(["t1", "t2", "t3"]);
	});

	it("leaves a span of one as the tool row it was, disclosure and all", () => {
		const rows = chatRows({...base, atOldest: true, tail: [call("t1"), assistantItem("a")]});
		expect(rows.map((row) => row.kind)).toEqual(["item", "item"]);
	});

	it("breaks on a compaction row, so two contexts never read as one run", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [call("t1"), call("t2"), compactionItem("c1"), call("t3"), call("t4")],
		});
		expect(rows.map((row) => row.kind)).toEqual(["tools", "item", "tools"]);
		expect(runAt(rows, 0)).toEqual(["t1", "t2"]);
		expect(runAt(rows, 2)).toEqual(["t3", "t4"]);
	});

	it("breaks on a session notice, which keeps its own row untouched", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [call("t1"), call("t2"), systemItem("s1"), call("t3"), call("t4")],
		});
		expect(rows.map((row) => row.kind)).toEqual(["tools", "session", "tools"]);
	});

	it("breaks on a spawning call, and never absorbs one", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				call("t1"),
				call("t2"),
				call("agent", {name: "Agent"}),
				call("child", {parentId: "agent"}),
				call("t3"),
				call("t4"),
			],
		});
		// The spawning call stays an item row: its fold, its `aria-expanded` and the rows it reveals
		// are a second disclosure a sentence has no room for (#8027/#8057).
		expect(rows.map((row) => row.kind)).toEqual(["tools", "item", "tools"]);
		expect(rows[1]?.kind === "item" && rows[1].item.id).toBe("agent");
		expect(rows[1]?.kind === "item" && rows[1].nestedIds).toEqual(["child"]);
	});

	it("never absorbs a spawning call whose worker rows left the window entirely", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			subagents: new Set(["agent"]),
			tail: [
				call("t1"),
				call("agent", {name: "Agent"}),
				call("child", {parentId: "agent"}),
				call("t2"),
			],
		});
		// With the worker's rows gone the call heads nothing, so the slot is the only thing left
		// saying it spawned — and the scan has to read that rather than the now-empty `nestedIds`.
		expect(carriedIds(rows)).toEqual(["t1", "agent", "t2"]);
		expect(rows.every((row) => row.kind === "item")).toBe(true);
	});

	it("breaks on a reply, a thought and the operator's own turn between calls", () => {
		for (const between of [assistantItem("a", "done"), thinkingItem("th"), userItem("u", "go")]) {
			const rows = chatRows({
				...base,
				atOldest: true,
				tail: [call("t1"), call("t2"), between, call("t3"), call("t4")],
			});
			expect(rows.map((row) => row.kind)).toEqual(["tools", "item", "tools"]);
		}
	});

	it("breaks on a depth change, so a worker's calls and the agent's are two runs", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			unfolded: new Set(["agent"]),
			tail: [
				call("agent", {name: "Agent"}),
				call("child-1", {parentId: "agent"}),
				call("child-2", {parentId: "agent"}),
				call("own-1"),
				call("own-2"),
			],
		});
		expect(rows.map((row) => row.kind)).toEqual(["item", "tools", "tools"]);
		expect(rows[1]?.kind === "tools" && rows[1].depth).toBe(1);
		expect(rows[2]?.kind === "tools" && rows[2].depth).toBe(0);
	});

	it("keys the run apart from every call's own row id, so one `expanded` set holds both", () => {
		const first = call("t1");
		const calls = [first, call("t2")];
		const rows = chatRows({...base, atOldest: true, tail: calls});
		const key = rowKey(rows[0] as ChatRow);
		expect(key).toBe("tools:t1");
		expect(key).not.toBe(
			rowKey({kind: "item", item: first, nestedIds: [], nested: false, depth: 0}),
		);
		expect(calls.map((item) => String(item.id))).not.toContain(key);
	});

	it("carries the page cursor and the prepend anchor like any other row", () => {
		const rows = chatRows({...base, atOldest: true, tail: [call("t1"), call("t2")]});
		expect(oldestLoadedId(rows)).toBe("t1");
		// Membership, not the run's key: an anchor may name a call buried mid-run.
		expect(rowIndexOfItem(rows, "t2")).toBe(0);
	});
});

/**
 * The turn fold (#8614). What a finished turn leaves on screen is its prompt, its reply, and one
 * line saying how long the work between them took — so what has to be proven here is *which* rows
 * that line stands for, and the four cases where it must not be drawn at all.
 *
 * The rule is T3's (`MessagesTimeline.logic.ts:575-723` at `pingdotgg/t3code@0fe4c99`), read against
 * Tuval's own item union: `partial` is its streaming marker, `AssistantItem.interrupted` its
 * cut-short one, and the timings are the items' own epoch-ms `timestamp`.
 */
describe("chatRows folds a settled turn", () => {
	const AT = 1_756_000_000_000;

	/** A finished turn: a thought and a call before the reply, four point two seconds end to end. */
	const settledTurn: ReadonlyArray<TranscriptItem> = [
		userItem("u", "go", AT),
		thinkingItem("k", "weighing it", AT + 100),
		toolItem("t", "ok", AT + 200),
		assistantItem("a", "done", AT + 4_200),
	];

	const turnRow = (rows: ReadonlyArray<ChatRow>) => {
		const row = rows.find((candidate) => candidate.kind === "turn");
		return row?.kind === "turn" ? row : null;
	};

	const hiddenIds = (rows: ReadonlyArray<ChatRow>): ReadonlyArray<string> =>
		carriedIds(turnRow(rows)?.hidden ?? []);

	it("puts one summary where the work was and leaves the prompt and the reply standing", () => {
		const rows = chatRows({...base, atOldest: true, tail: settledTurn});
		expect(rows.map((row) => row.kind)).toEqual(["item", "turn", "item"]);
		expect(carriedIds(rows)).toEqual(["u", "a"]);
		expect(hiddenIds(rows)).toEqual(["k", "t"]);
		expect(turnRow(rows)?.label).toBe("Worked for 4.2s");
	});

	it("shows the rows again, in place, once its own key is in the unfolded set", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			unfolded: new Set(["turn:u"]),
			tail: settledTurn,
		});
		expect(rows.map((row) => row.kind)).toEqual(["item", "turn", "item", "item", "item"]);
		expect(carriedIds(rows)).toEqual(["u", "k", "t", "a"]);
		expect(turnRow(rows)?.open).toBe(true);
		// The key is the turn's, not the opening prompt's: the two share the one `unfolded` set.
		expect(rowKey(turnRow(rows) as ChatRow)).toBe("turn:u");
	});

	it("folds every reply before the terminal one and leaves that one visible", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				assistantItem("a1", "first", AT + 100),
				assistantItem("a2", "final", AT + 900),
			],
		});
		expect(carriedIds(rows)).toEqual(["u", "a2"]);
		expect(hiddenIds(rows)).toEqual(["a1"]);
	});

	it("does not fold a turn holding a streaming reply, nor one holding a running call", () => {
		const streaming = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				thinkingItem("k", "weighing it", AT + 100),
				{...assistantItem("a", "typ", AT + 300), partial: true},
			],
		});
		expect(turnRow(streaming)).toBeNull();

		const running = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				assistantItem("a", "on it", AT + 100),
				call("t", {status: "running"}),
			],
		});
		expect(turnRow(running)).toBeNull();
	});

	it("does not fold a turn that has produced no reply yet — the one still running", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [userItem("u", "go", AT), thinkingItem("k", "weighing it", AT + 100)],
		});
		expect(turnRow(rows)).toBeNull();
		expect(carriedIds(rows)).toEqual(["u", "k"]);
	});

	it("takes one harmless trailing call into the fold", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				thinkingItem("k", "weighing it", AT + 100),
				assistantItem("a", "done", AT + 400),
				toolItem("t", "ok", AT + 600),
			],
		});
		expect(carriedIds(rows)).toEqual(["u", "a"]);
		expect(hiddenIds(rows)).toEqual(["k", "t"]);
	});

	// T3's own spec case (`MessagesTimeline.logic.test.ts:1401-1484`): three trailing commands stay
	// out of the fold and render as the summary row they already are.
	it("leaves three trailing calls visible, as the run row they collapse into", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				toolItem("before", "ok", AT + 100),
				assistantItem("a", "I could not finish the task.", AT + 500),
				call("x0"),
				call("x1"),
				call("x2"),
			],
		});
		expect(rows.map((row) => row.kind)).toEqual(["item", "turn", "item", "tools"]);
		expect(hiddenIds(rows)).toEqual(["before"]);
	});

	it("leaves a single trailing call visible when it failed", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				toolItem("before", "ok", AT + 100),
				assistantItem("a", "done", AT + 500),
				call("x", {status: "error"}),
			],
		});
		expect(carriedIds(rows)).toEqual(["u", "a", "x"]);
		expect(hiddenIds(rows)).toEqual(["before"]);
	});

	it("draws no summary for a turn with nothing to hide", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [userItem("u", "go", AT), assistantItem("a", "done", AT + 100)],
		});
		expect(rows.map((row) => row.kind)).toEqual(["item", "item"]);
	});

	it("draws no summary when the only thing it would hide is a compaction row", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				assistantItem("a", "done", AT + 100),
				compactionItem("c", "context compacted", AT + 200),
			],
		});
		expect(rows.map((row) => row.kind)).toEqual(["item", "item", "item"]);
	});

	it("takes the compaction row into a fold that already hides work, and closes the turn on it", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				thinkingItem("k", "weighing it", AT + 100),
				assistantItem("a", "done", AT + 400),
				compactionItem("c", "context compacted", AT + 500),
				toolItem("after", "ok", AT + 900),
			],
		});
		// `after` sits past the compaction row, so it belongs to no turn and folds into none.
		expect(carriedIds(rows)).toEqual(["u", "a", "after"]);
		expect(hiddenIds(rows)).toEqual(["k", "c"]);
	});

	it("never folds a spawning call, whichever way this list knows it is one", () => {
		const bySlot = chatRows({
			...base,
			atOldest: true,
			subagents: new Set(["s"]),
			tail: [
				userItem("u", "go", AT),
				call("s", {name: "Agent"}),
				assistantItem("a", "done", AT + 1),
			],
		});
		expect(turnRow(bySlot)).toBeNull();
		expect(carriedIds(bySlot)).toEqual(["u", "s", "a"]);

		const byFold = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				call("s", {name: "Agent"}),
				call("w", {parentId: "s"}),
				assistantItem("a", "done", AT + 1),
			],
		});
		expect(turnRow(byFold)).toBeNull();
		expect(carriedIds(byFold)).toEqual(["u", "s", "a"]);
	});

	it("never folds a session notice into a turn summary", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				systemItem("s1", "hook fired", AT + 100),
				thinkingItem("k", "weighing it", AT + 200),
				assistantItem("a", "done", AT + 400),
			],
		});
		expect(rows.map((row) => row.kind)).toEqual(["item", "session", "turn", "item"]);
		expect(hiddenIds(rows)).toEqual(["k"]);
	});

	it("says the operator stopped it, beside the marker the interrupted reply still renders", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				thinkingItem("k", "weighing it", AT + 100),
				assistantItem("a", "half an ans", AT + 2_000, true),
			],
		});
		expect(turnRow(rows)?.label).toBe("You stopped after 2.0s");
		// The reply itself is the terminal row and stays visible, so its marker and Resend do too.
		expect(carriedIds(rows)).toEqual(["u", "a"]);
	});

	/**
	 * The same turn after the operator paged past it and back. The store's copy of a cut reply says it
	 * finished — agy records no operator stop in its own log — so without the re-mark the window draws
	 * this turn as "Worked for 2.0s" and a half-written answer reads as the model's last word (#8985).
	 * The record it is re-marked from is the session's own `cutReplies` (`ai-agent/core/state.ts`).
	 */
	it("still says the operator stopped it when the turn came back from the store", () => {
		const stored = [
			userItem("u", "go", AT),
			thinkingItem("k", "weighing it", AT + 100),
			assistantItem("a", "half an ans", AT + 2_000),
			userItem("u2", "never mind", AT + 9_000),
			assistantItem("a2", "summarized", AT + 10_000),
		];
		const paged = (items: ReadonlyArray<TranscriptItem>) =>
			chatRows({...base, atOldest: true, older: mergeOlder([], items)});
		expect(paged(stored).find((row) => row.kind === "turn" && row.id === "u")).toMatchObject({
			label: "Worked for 2.0s",
		});
		const remarked = remarkCutReplies(stored, [ItemId.make("a")]);
		expect(paged(remarked).find((row) => row.kind === "turn" && row.id === "u")).toMatchObject({
			label: "You stopped after 2.0s",
		});
	});

	it("falls back to the bare verb when the items do not say how long it took", () => {
		const rows = chatRows({
			...base,
			atOldest: true,
			tail: [
				userItem("u", "go", AT),
				thinkingItem("k", "weighing it", AT + 100),
				{...assistantItem("a", "done", AT), timestamp: Number.NaN},
			],
		});
		expect(turnRow(rows)?.label).toBe("Worked");
	});

	it("formats a duration the way T3 does", () => {
		expect(turnDuration(400)).toBe("400ms");
		expect(turnDuration(4_200)).toBe("4.2s");
		expect(turnDuration(9_960)).toBe("10s");
		expect(turnDuration(12_400)).toBe("12s");
		expect(turnDuration(64_000)).toBe("1m 4s");
		expect(turnDuration(3_600_000)).toBe("1h");
		expect(turnDuration(Number.NaN)).toBeNull();
	});

	it("holds still as a late upsert of the same reply lands", () => {
		const growing = chatRows({
			...base,
			atOldest: true,
			tail: [...settledTurn.slice(0, 3), {...assistantItem("a", "don", AT + 4_200), partial: true}],
		});
		expect(turnRow(growing)).toBeNull();

		const folded = chatRows({...base, atOldest: true, tail: settledTurn});
		const again = chatRows({
			...base,
			atOldest: true,
			tail: [...settledTurn.slice(0, 3), assistantItem("a", "done, and then some", AT + 4_200)],
		});
		expect(hiddenIds(again)).toEqual(hiddenIds(folded));
		expect(turnRow(again)?.label).toBe(turnRow(folded)?.label);
	});

	it("renders a turn whose opening prompt is older than the pages walked back to", () => {
		const rows = chatRows({...base, atOldest: true, tail: settledTurn.slice(1)});
		expect(turnRow(rows)).toBeNull();
		expect(carriedIds(rows)).toEqual(["k", "t", "a"]);
	});

	it("does not re-cut a loaded turn's fold when an older page prepends", () => {
		const older = [
			userItem("u0", "first", AT - 9_000),
			thinkingItem("k0", "weighing it", AT - 8_900),
			assistantItem("a0", "answered", AT - 8_000),
		];
		const before = chatRows({...base, atOldest: true, tail: settledTurn});
		const after = chatRows({...base, atOldest: true, older, tail: settledTurn});
		expect(after.map((row) => row.kind)).toEqual(["item", "turn", "item", "item", "turn", "item"]);
		expect(carriedIds(after.slice(3))).toEqual(carriedIds(before));
		expect(hiddenIds(after.slice(3))).toEqual(hiddenIds(before));
	});

	it("keeps the page cursor and the prepend anchor reachable through the summary", () => {
		const rows = chatRows({...base, atOldest: true, tail: settledTurn});
		expect(oldestLoadedId(rows)).toBe("u");
		// The anchor names a row the fold is hiding, and the summary standing in for it is where the
		// viewport lands — without this a prepend mid-turn would have nothing to restore onto.
		expect(rowIndexOfItem(rows, "t")).toBe(1);
		expect(rowIndexOfItem(rows, "a")).toBe(2);
	});
});
