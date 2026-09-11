/**
 * The view slot's read-back. It is total on purpose: a window opened for the first time holds
 * `null`, and a window re-bound onto this program after another one holds that other program's
 * record — neither is something a renderer may throw on, because the window contract's fallbacks
 * are values (`../window/host.ts`).
 */

import {describe, expect, it} from "vitest";
import {asChatView, type ChatView, initialChatView, viewMain, viewSubagent} from "./view.ts";

describe("asChatView", () => {
	it("reads a slot this window wrote", () => {
		expect(
			asChatView({
				pinned: false,
				scroll: 420,
				draft: "hello",
				outgoing: [{key: "k1", text: "unsent"}],
				cursor: "i7",
				atOldest: true,
				expanded: ["t1", "t2"],
				unfolded: ["t3"],
			}),
		).toEqual({
			pinned: false,
			scroll: 420,
			draft: "hello",
			outgoing: [{key: "k1", text: "unsent"}],
			cursor: null,
			atOldest: false,
			expanded: ["t1", "t2"],
			unfolded: ["t3"],
			viewing: null,
		});
	});

	// The rows a walk produced are the window's own React state and are rebuilt empty at every mount,
	// so a restored walk names rows the window does not hold — and `atOldest` is what suppresses the
	// affordance that could fetch them (#9047).
	it("answers a fresh walk however far back the slot says this window had paged", () => {
		expect(asChatView({cursor: "i7", atOldest: true})).toEqual(initialChatView);
		expect(asChatView({cursor: "i7", atOldest: false}).cursor).toBeNull();
		expect(asChatView({scroll: 420, draft: "kept", atOldest: true})).toEqual({
			...initialChatView,
			pinned: true,
			scroll: 420,
			draft: "kept",
		});
	});

	it("answers the initial view for a slot no window has written yet", () => {
		expect(asChatView(undefined)).toEqual(initialChatView);
		expect(asChatView(null)).toEqual(initialChatView);
	});

	it("answers the initial view for a slot that is not a record", () => {
		expect(asChatView(7)).toEqual(initialChatView);
		expect(asChatView("scroll")).toEqual(initialChatView);
		expect(asChatView([1, 2, 3])).toEqual(initialChatView);
	});

	it("keeps the fields it recognises and defaults the rest, field by field", () => {
		expect(
			asChatView({
				scroll: "far",
				draft: 3,
				cursor: 9,
				atOldest: "yes",
				expanded: "t1",
				unfolded: "t3",
			}),
		).toEqual(initialChatView);
		expect(asChatView({scroll: 12, cursor: "i1"})).toEqual({
			pinned: true,
			scroll: 12,
			draft: "",
			outgoing: [],
			cursor: null,
			atOldest: false,
			expanded: [],
			unfolded: [],
			viewing: null,
		});
	});

	it("keeps only the string ids out of an id list another writer left something else in", () => {
		expect(asChatView({expanded: ["t1", 7, null, "t2", {}]}).expanded).toEqual(["t1", "t2"]);
		expect(asChatView({unfolded: ["t1", 7, null, "t2", {}]}).unfolded).toEqual(["t1", "t2"]);
	});

	// A slot written before the window followed anything carries no pin, and one written by another
	// program carries whatever that program wrote. Both read as pinned: a window is following its
	// newest turn until its reader scrolls off it, and only the literal `false` is a reader who did.
	it("reads a missing or unrecognised pin as a window that is following its newest turn", () => {
		expect(asChatView({scroll: 900}).pinned).toBe(true);
		expect(asChatView({pinned: "no"}).pinned).toBe(true);
		expect(asChatView({pinned: false}).pinned).toBe(false);
	});

	it("refuses a non-finite scroll offset, which would take the virtualizer with it", () => {
		expect(asChatView({scroll: Number.NaN}).scroll).toBe(0);
		expect(asChatView({scroll: Number.POSITIVE_INFINITY}).scroll).toBe(0);
	});

	// The criterion #8406 states as "a slot written by an older build reads back as main rather than
	// throwing": every one of these is a slot no build of this window ever wrote.
	it("reads a slot with no view field, and every unreadable one, as a window on main", () => {
		expect(asChatView({scroll: 12}).viewing).toBeNull();
		expect(asChatView({viewing: "call-1"}).viewing).toBeNull();
		expect(asChatView({viewing: {}}).viewing).toBeNull();
		expect(asChatView({viewing: {id: ""}}).viewing).toBeNull();
		expect(asChatView({viewing: {id: 7}}).viewing).toBeNull();
		expect(asChatView({viewing: [{id: "call-1"}]}).viewing).toBeNull();
	});

	it("defaults the parked position of a view slot whose park is missing or unreadable", () => {
		expect(asChatView({viewing: {id: "call-1"}}).viewing).toEqual({
			id: "call-1",
			from: {pinned: true, scroll: 0},
		});
		expect(asChatView({viewing: {id: "call-1", from: {scroll: "far", pinned: 3}}}).viewing).toEqual(
			{
				id: "call-1",
				from: {pinned: true, scroll: 0},
			},
		);
		expect(
			asChatView({viewing: {id: "call-1", from: {pinned: false, scroll: 420}}}).viewing,
		).toEqual({id: "call-1", from: {pinned: false, scroll: 420}});
	});
});

describe("swapping the one view slot", () => {
	const main: ChatView = {...initialChatView, pinned: false, scroll: 420};

	it("parks where main was left and starts the subagent on its own newest row", () => {
		const swapped = viewSubagent(main, "call-1");
		expect(swapped.viewing).toEqual({id: "call-1", from: {pinned: false, scroll: 420}});
		expect([swapped.pinned, swapped.scroll]).toEqual([true, 0]);
	});

	it("puts main back exactly where it was left", () => {
		const back = viewMain(viewSubagent(main, "call-1"));
		expect(back.viewing).toBeNull();
		expect([back.pinned, back.scroll]).toEqual([false, 420]);
	});

	// Main was left once. A hop from one worker to another must not re-park the *subagent's* offset
	// as main's, or the back action would land on a position that was never main's.
	it("keeps the original park when the slot hops straight to another subagent", () => {
		const first = viewSubagent(main, "call-1");
		const scrolled = {...first, pinned: false, scroll: 90};
		const second = viewSubagent(scrolled, "call-2");
		expect(second.viewing).toEqual({id: "call-2", from: {pinned: false, scroll: 420}});
		expect(viewMain(second).scroll).toBe(420);
	});

	it("is identity when the slot is already where it is being sent", () => {
		const swapped = viewSubagent(main, "call-1");
		expect(viewSubagent(swapped, "call-1")).toBe(swapped);
		expect(viewMain(main)).toBe(main);
	});

	it("leaves every other field of the slot alone", () => {
		const held: ChatView = {...main, draft: "half a prompt", expanded: ["t1"], cursor: "i7"};
		const swapped = viewSubagent(held, "call-1");
		expect([swapped.draft, swapped.expanded, swapped.cursor]).toEqual([
			"half a prompt",
			["t1"],
			"i7",
		]);
		expect(viewMain(swapped).cursor).toBe("i7");
	});
});
