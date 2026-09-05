/**
 * The view slot's read-back. It is total on purpose: a window opened for the first time holds
 * `null`, and a window re-bound onto this program after another one holds that other program's
 * record — neither is something a renderer may throw on, because the window contract's fallbacks
 * are values (`../window/host.ts`).
 */

import {describe, expect, it} from "vitest";
import {asChatView, initialChatView} from "./view.ts";

describe("asChatView", () => {
	it("reads a slot this window wrote", () => {
		expect(asChatView({scroll: 420, draft: "hello", cursor: "i7", atOldest: true})).toEqual({
			scroll: 420,
			draft: "hello",
			cursor: "i7",
			atOldest: true,
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
		expect(asChatView({scroll: "far", draft: 3, cursor: 9, atOldest: "yes"})).toEqual(
			initialChatView,
		);
		expect(asChatView({scroll: 12, cursor: "i1"})).toEqual({
			scroll: 12,
			draft: "",
			cursor: "i1",
			atOldest: false,
		});
	});

	it("refuses a non-finite scroll offset, which would take the virtualizer with it", () => {
		expect(asChatView({scroll: Number.NaN}).scroll).toBe(0);
		expect(asChatView({scroll: Number.POSITIVE_INFINITY}).scroll).toBe(0);
	});
});
