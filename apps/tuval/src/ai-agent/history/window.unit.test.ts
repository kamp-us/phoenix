import {describe, expect, it} from "vitest";
import {
	assistantItem,
	nestedUnder,
	randomStream,
	randomTranscript,
	systemItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import {
	anchorsCursor,
	isNestedItem,
	isNoticeItem,
	isTranscriptPayload,
	type TranscriptItem,
} from "../ports/index.ts";
import {pageCursor} from "./cursor.ts";
import {groupTranscript, itemBytes} from "./groups.ts";
import {
	nestedLimitsFor,
	noticeLimitsFor,
	planTranscriptWindow,
	TRANSCRIPT_WINDOW_BYTE_LIMIT,
	TRANSCRIPT_WINDOW_ITEM_LIMIT,
} from "./window.ts";

const bytesOf = (items: ReadonlyArray<TranscriptItem>) =>
	items.reduce((total, item) => total + itemBytes(item), 0);

/** One prompt and the tool calls it produced: `count` items the bounds may never cut apart. */
const oneExchange = (
	prefix: string,
	count: number,
	output = "ok",
): ReadonlyArray<TranscriptItem> => [
	userItem(`${prefix}-u`),
	...Array.from({length: count - 1}, (_, index) => toolItem(`${prefix}-t${index}`, output)),
];

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

	it("keeps the newest exchange whole rather than emptying the tail the bound cannot hold", () => {
		const history = [userItem("u1"), assistantItem("a1"), toolItem("t1")];
		const plan = planTranscriptWindow(history, {itemLimit: 2});
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;
		expect(plan.items.map((item) => item.id)).toEqual(["u1", "a1", "t1"]);
		expect(plan.omitted).toEqual({items: 0, bytes: 0, reason: "none"});
	});

	it("carries a turn of 45 tool calls whole, over the item bound on its own", () => {
		const history = oneExchange("big", 45);
		const plan = planTranscriptWindow(history);
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;
		expect(history.length).toBeGreaterThan(TRANSCRIPT_WINDOW_ITEM_LIMIT);
		expect(plan.items).toEqual(history);
		expect(plan.omitted.items).toBe(0);
	});

	it("carries a turn past the byte bound whole too", () => {
		const history = oneExchange("heavy", 34, "x".repeat(8_000));
		const plan = planTranscriptWindow(history);
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;
		expect(history.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_ITEM_LIMIT);
		expect(bytesOf(history)).toBeGreaterThan(TRANSCRIPT_WINDOW_BYTE_LIMIT);
		expect(plan.items).toEqual(history);
		expect(plan.omitted.items).toBe(0);
	});

	it("drops the older exchanges around a newest one the bounds cannot hold", () => {
		const history = [userItem("u1"), assistantItem("a1"), ...oneExchange("big", 45)];
		const plan = planTranscriptWindow(history, {itemLimit: 5});
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;
		expect(plan.items).toEqual(history.slice(2));
		expect(plan.omitted).toEqual({
			items: 2,
			bytes: bytesOf(history.slice(0, 2)),
			reason: "item-limit",
		});
	});

	it("ends just older than a cursor that opens a group", () => {
		const history = [userItem("u1"), assistantItem("a1"), userItem("u2"), assistantItem("a2")];
		const plan = planTranscriptWindow(history, {before: "u2"});
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;
		expect(plan.items.map((item) => item.id)).toEqual(["u1", "a1"]);
	});
});

/**
 * #9514: the founder's desk restored a `claude-session` window holding forty top-level notices and
 * not one turn. Each notice had cost a full item slot, so the forty spent the whole bound, and no
 * row left in the window could anchor a page — the transcript rendered as one collapsed line and
 * "Load earlier messages" did nothing.
 */
describe("a tail of session notices", () => {
	const NOTICES = 48;
	const exchanges = [
		userItem("u1", "first question"),
		assistantItem("a1", "first answer"),
		userItem("u2", "second question"),
		assistantItem("a2", "second answer"),
		userItem("u3", "third question"),
		assistantItem("a3", "third answer"),
	];
	const history = [
		...exchanges,
		...Array.from({length: NOTICES}, (_unused, index) => systemItem(`n${index}`, "task progress")),
	];

	it("never spends the whole window, so the conversation survives under it", () => {
		const plan = planTranscriptWindow(history);
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;

		expect(NOTICES).toBeGreaterThan(TRANSCRIPT_WINDOW_ITEM_LIMIT);
		expect(plan.items.filter((item) => !isNoticeItem(item)).map((item) => item.id)).toEqual(
			exchanges.map((item) => item.id),
		);
		expect(plan.items.filter(isNoticeItem).length).toBeLessThanOrEqual(
			noticeLimitsFor({
				items: TRANSCRIPT_WINDOW_ITEM_LIMIT,
				bytes: TRANSCRIPT_WINDOW_BYTE_LIMIT,
			}).items,
		);
		expect(plan.items.length + plan.omitted.items).toBe(history.length);
	});

	it("leaves a row the page cursor can be minted from, so Load earlier has something to ask", () => {
		const plan = planTranscriptWindow(history);
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;

		const oldest = plan.items[0];
		expect(oldest).toBeDefined();
		if (oldest === undefined) return;
		// The oldest loaded row is the cursor the shell mints from (`shell/chat/rows.ts`'s
		// `olderPageRequest`), so that is the one the click depends on.
		expect(pageCursor(plan.items, oldest.id)).toEqual({kind: "page", before: oldest.id});
	});

	it("still carries the newest notice when the notices are all there is", () => {
		const noticesOnly = history.slice(exchanges.length);
		const plan = planTranscriptWindow(noticesOnly);
		expect(plan.kind).toBe("window");
		if (plan.kind !== "window") return;

		expect(plan.items.length).toBeGreaterThan(0);
		expect(plan.items.at(-1)?.id).toBe(noticesOnly.at(-1)?.id);
		expect(plan.items.length + plan.omitted.items).toBe(noticesOnly.length);
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
	/** The conversation's own rows: what the item and byte bounds are spent on (#9514). */
	const conversation = (items: ReadonlyArray<TranscriptItem>) =>
		items.filter((item) => !isNestedItem(item) && !isNoticeItem(item));

	it("holds both bounds except over the group that earns the window, across 200 seeds", () => {
		const failures: Array<string> = [];
		for (let seed = 1; seed <= 200; seed += 1) {
			const random = randomStream(seed * 7919);
			const history = randomTranscript(seed, {groups: 4 + random.int(14)});
			const itemLimit = 1 + random.int(20);
			const byteLimit = 200 + random.int(4_000);
			const noticeLimit = noticeLimitsFor({items: itemLimit, bytes: byteLimit});
			const plan = planTranscriptWindow(history, {itemLimit, byteLimit});
			if (plan.kind !== "window") {
				failures.push(`seed ${seed}: refused ${plan.reason}`);
				continue;
			}
			const ids = plan.items.map((item) => item.id);
			// Two groups may sit over a bound and only they: the newest, carried whole so the tail is
			// never empty (#8031), and the oldest, which the walk takes to bring the window the
			// cursor-eligible row it owes (#9514). Everything between them is bounded, which is what
			// dropping the oldest group leaves behind.
			const bounded = groupTranscript(plan.items)
				.slice(1)
				.flatMap((group) => group.items);
			if (ids.length === 0) failures.push(`seed ${seed}: empty window over a live tail`);
			if (conversation(bounded).length > itemLimit)
				failures.push(`seed ${seed}: ${conversation(bounded).length} > ${itemLimit}`);
			if (bytesOf(conversation(bounded)) > byteLimit)
				failures.push(`seed ${seed}: over the byte bound`);
			const notices = plan.items.filter(isNoticeItem);
			if (notices.length > noticeLimit.items && notices.length > 1)
				failures.push(`seed ${seed}: ${notices.length} notices > ${noticeLimit.items}`);
			// The invariant the empty window was missing: while the input holds a row a page cursor
			// can be minted from, the planned window holds one too.
			if (history.some(anchorsCursor) && !plan.items.some(anchorsCursor))
				failures.push(`seed ${seed}: no row in the window can anchor a page`);
			// The window is the newest tail, minus the notices its own ceiling put down inside it.
			const tail = history.slice(plan.start);
			const missing = tail.filter((item) => !ids.includes(item.id));
			if (
				JSON.stringify(ids) !==
				JSON.stringify(tail.filter((item) => ids.includes(item.id)).map((item) => item.id))
			)
				failures.push(`seed ${seed}: window is not the newest tail in order`);
			if (missing.some((item) => !isNoticeItem(item)))
				failures.push(`seed ${seed}: window is missing a row no ceiling put down`);
			// A group is in or out whole, counting a notice the ceiling put down as out of it.
			const split = groupTranscript(history).some((group) => {
				const inside = group.items.filter((item) => ids.includes(item.id)).length;
				const whole = group.items.filter(
					(item) => !isNoticeItem(item) || ids.includes(item.id),
				).length;
				return inside !== 0 && inside !== whole;
			});
			if (split) failures.push(`seed ${seed}: split an atomic group`);
			if (plan.items.length + plan.omitted.items !== history.length)
				failures.push(`seed ${seed}: omission metadata does not account for every row`);
			if (plan.omitted.bytes !== bytesOf(history) - bytesOf(plan.items))
				failures.push(`seed ${seed}: omitted bytes do not match what was left out`);
			if ((plan.omitted.reason === "none") !== (plan.omitted.items === 0)) {
				failures.push(`seed ${seed}: omission reason disagrees with the drop`);
			}
		}
		expect(failures).toEqual([]);
	});
});

/**
 * The other half of #8814: a worker's rows ride free of the agent's bounds, but not free of every
 * bound. With the subagent list off `chatRows` renders them folded under their call, so a window
 * that exempted them outright would have lifted the ceiling on a rendered tail rather than moved it.
 */
describe("the ceiling a spawned worker's rows answer to", () => {
	const EXCHANGES = 8;
	const ROWS_PER_WORKER = 30;
	const ITEM_LIMIT = 40;

	/** `EXCHANGES` operator turns, each ending in a call whose worker rows arrive tagged. */
	const withWorkers = (rows: number): ReadonlyArray<TranscriptItem> =>
		Array.from({length: EXCHANGES}).flatMap((_exchange, turn) => {
			const call = `call-${turn}`;
			return [
				userItem(`u${turn}`),
				assistantItem(`a${turn}`),
				toolItem(call),
				...Array.from({length: rows}).map((_row, index) =>
					nestedUnder(assistantItem(`w${turn}-${index}`), call),
				),
			];
		});

	const ownIds = (items: ReadonlyArray<TranscriptItem>) =>
		items.filter((item) => item.parentId === undefined).map((item) => item.id);

	const plan = (history: ReadonlyArray<TranscriptItem>) => {
		const planned = planTranscriptWindow(history, {itemLimit: ITEM_LIMIT});
		if (planned.kind !== "window") throw new Error(`refused: ${planned.reason}`);
		return planned;
	};

	it("puts the oldest of them down once they pass it, keeping every row of the agent's own", () => {
		const history = withWorkers(ROWS_PER_WORKER);
		const nestedLimit = nestedLimitsFor({items: ITEM_LIMIT, bytes: TRANSCRIPT_WINDOW_BYTE_LIMIT});
		const window = plan(history);
		const nested = window.items.filter((item) => item.parentId !== undefined);

		expect(EXCHANGES * ROWS_PER_WORKER).toBeGreaterThan(nestedLimit.items);
		expect(ownIds(window.items)).toEqual(ownIds(history));
		expect(nested.length).toBeLessThanOrEqual(nestedLimit.items);
		expect(window.omitted.reason).toBe("item-limit");
	});

	it("counts what it put down as omitted, so no row leaves the tail unaccounted", () => {
		const history = withWorkers(ROWS_PER_WORKER);
		const window = plan(history);

		expect(window.items.length + window.omitted.items).toBe(history.length);
	});

	it("carries them all when they fit, so a spawn under the ceiling costs nothing", () => {
		const history = withWorkers(4);
		const window = plan(history);

		expect(window.items.map((item) => item.id)).toEqual(history.map((item) => item.id));
		expect(window.omitted).toEqual({items: 0, bytes: 0, reason: "none"});
	});
});
