import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {
	type CloseAct,
	type ClosingMerge,
	closeComment,
	type IssueRead,
	judgeClosingMerge,
	type OpenMerge,
	settleClosingMerge,
} from "./closing-merge.ts";

const issueAt = (state: string, isPullRequest = false): IssueRead => ({
	_tag: "Present",
	value: {state, isPullRequest},
});

describe("judgeClosingMerge — closing merge, issue open / closed / unread", () => {
	it("answers Open for an issue that still reads open, carrying the merged PRs", () => {
		expect(judgeClosingMerge(42, [7329], issueAt("open"))).toEqual({
			_tag: "Open",
			issue: 42,
			merged: [7329],
		});
	});

	it("answers Closed for an issue that reads closed", () => {
		expect(judgeClosingMerge(42, [7329], issueAt("closed"))).toEqual({_tag: "Closed", issue: 42});
	});

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

describe("settleClosingMerge — only an open issue reaches the closer", () => {
	const closer = (act: CloseAct) => {
		const asked: OpenMerge[] = [];
		return {
			asked,
			close: (open: OpenMerge) =>
				Effect.sync(() => {
					asked.push(open);
					return act;
				}),
		};
	};
	const settle = (merge: ClosingMerge, act: CloseAct = {_tag: "Closed"}) => {
		const fake = closer(act);
		return Effect.runPromise(settleClosingMerge(merge, fake.close)).then((settled) => ({
			settled,
			asked: fake.asked,
		}));
	};

	it("closes an open issue and answers closed-by-lane", async () => {
		const {settled, asked} = await settle({_tag: "Open", issue: 42, merged: [7329]});
		expect(asked).toHaveLength(1);
		expect(settled.close).toBe("closed-by-lane");
	});

	it("answers close-failed where the close failed", async () => {
		const {settled} = await settle(
			{_tag: "Open", issue: 42, merged: [7329]},
			{_tag: "Failed", reason: "HTTP 403"},
		);
		expect(settled.close).toBe("close-failed");
		expect(settled.note).toContain("HTTP 403");
	});

	it("never calls the closer on a closed or unread issue", async () => {
		const closed = await settle({_tag: "Closed", issue: 42});
		const unread = await settle({_tag: "Unread", issue: 42, reason: "cannot read #42: x"});
		expect(closed.asked).toEqual([]);
		expect(closed.settled.close).toBe("already-closed");
		expect(unread.asked).toEqual([]);
		expect(unread.settled.close).toBe("unread");
	});
});

describe("closeComment", () => {
	it("names every merged PR by URL", () => {
		const url = "https://forge.test/o/r/pull/7329";
		expect(closeComment(42, [url])).toContain(url);
	});
});
