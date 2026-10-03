import {describe, expect, it} from "vitest";
import {closeComment, type IssueRead, judgeClosingMerge} from "./closing-merge.ts";

const issueAt = (state: string, isPullRequest = false): IssueRead => ({
	_tag: "Present",
	value: {state, isPullRequest},
});

describe("judgeClosingMerge — an issue read that proves neither open nor closed", () => {
	it("answers Unread for a read that failed, never Open or Closed", () => {
		expect(judgeClosingMerge(42, [7329], {_tag: "Unknown", reason: "HTTP 502"})).toEqual({
			_tag: "Unread",
			issue: 42,
			reason: "cannot read #42: HTTP 502",
		});
	});

	it("answers Unread for an absent issue, a pull request, and a state it does not know", () => {
		expect(judgeClosingMerge(42, [1], {_tag: "Absent"})._tag).toBe("Unread");
		expect(judgeClosingMerge(42, [1], issueAt("open", true))._tag).toBe("Unread");
		expect(judgeClosingMerge(42, [1], issueAt("locked"))._tag).toBe("Unread");
	});
});

describe("closeComment", () => {
	it("names every merged PR by URL", () => {
		const url = "https://forge.test/o/r/pull/7329";
		expect(closeComment(42, [url])).toContain(url);
	});
});
