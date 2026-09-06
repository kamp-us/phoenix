/**
 * The one rule `sessionSummary` exists for: a field the store could not fill comes out absent, not
 * filled with the value that field's type happens to allow. Assertions are on `"key" in summary`
 * rather than on `=== undefined`, because a present key holding `undefined` is exactly the
 * fabricated absence being refused.
 */

import {describe, expect, it} from "vitest";
import {newestFirst, sessionSummary} from "./sessions.ts";

const base = {sessionId: "s1", lastModified: 1_760_000_000_000, backend: "claude"} as const;

describe("sessionSummary", () => {
	it("keeps the three a backend always has", () => {
		expect(sessionSummary(base)).toEqual(base);
	});

	it("drops a blank, whitespace-only or null string instead of carrying it", () => {
		const summary = sessionSummary({...base, folder: "", branch: "   ", firstPrompt: null});
		expect("folder" in summary).toBe(false);
		expect("branch" in summary).toBe(false);
		expect("firstPrompt" in summary).toBe(false);
	});

	it("trims what it does keep", () => {
		expect(sessionSummary({...base, branch: " main\n"}).branch).toBe("main");
	});

	it("keeps a zero message count, which is an empty session rather than an unknown one", () => {
		expect(sessionSummary({...base, messageCount: 0}).messageCount).toBe(0);
	});

	it("drops a count no store could mean", () => {
		expect("messageCount" in sessionSummary({...base, messageCount: -1})).toBe(false);
		expect("messageCount" in sessionSummary({...base, messageCount: 1.5})).toBe(false);
		expect("messageCount" in sessionSummary({...base, messageCount: Number.NaN})).toBe(false);
	});

	// Pi answers `modified` as a `Date` and Claude `lastModified` as epoch milliseconds; the union
	// sorts on one number, so the conversion happens here rather than at each backend's call site.
	it("takes a Date as readily as epoch milliseconds", () => {
		const at = new Date(1_760_000_000_000);
		expect(sessionSummary({...base, lastModified: at}).lastModified).toBe(at.getTime());
	});
});

describe("newestFirst", () => {
	it("sorts by last modified, newest first, and leaves the input alone", () => {
		const older = sessionSummary({...base, sessionId: "older", lastModified: 1});
		const newer = sessionSummary({...base, sessionId: "newer", lastModified: 2});
		const given = [older, newer];
		expect(newestFirst(given)).toEqual([newer, older]);
		expect(given).toEqual([older, newer]);
	});
});
