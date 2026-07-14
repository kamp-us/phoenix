import {assert, describe, it} from "@effect/vitest";
import {type PrComment, scanPrComments} from "./scan-pr.ts";

describe("scanPrComments — fan findCommentLeaks over a PR's landed comments (#3019)", () => {
	it("clean comments → no leaks", () => {
		const comments: ReadonlyArray<PrComment> = [
			{id: 1, kind: "issue", body: "review-code: PASS @ abc1234 — merge-ready"},
			{id: 2, kind: "review", body: "see apps/web/worker for the handler"},
		];
		assert.deepStrictEqual(scanPrComments(comments), []);
	});

	it("a leaking issue comment → reports the comment id, surface, matched span", () => {
		const comments: ReadonlyArray<PrComment> = [
			{id: 42, kind: "issue", body: "review-doc: PASS — see /private/tmp/review-verdict.E2CYtu"},
		];
		const leaks = scanPrComments(comments);
		assert.strictEqual(leaks.length, 1);
		assert.strictEqual(leaks[0]?.id, 42);
		assert.strictEqual(leaks[0]?.kind, "issue");
		assert.include(leaks[0]?.leak.matched, "/private/tmp/review-verdict.E2CYtu");
	});

	it("a leaking inline review comment is scanned too (both surfaces)", () => {
		const comments: ReadonlyArray<PrComment> = [
			{id: 7, kind: "review", body: "nit: this path /Users/someone/x should be repo-relative"},
		];
		const leaks = scanPrComments(comments);
		assert.strictEqual(leaks.length, 1);
		assert.strictEqual(leaks[0]?.kind, "review");
		assert.include(leaks[0]?.leak.matched, "/Users/someone");
	});

	it("the raw @filepath bypass shape (#3018/#3005) is caught wherever it landed", () => {
		const comments: ReadonlyArray<PrComment> = [
			{
				id: 100,
				kind: "issue",
				body: "review-doc: FAIL @ deadbeef1234\n\n/var/folders/8f/abc/T/tmp.X",
			},
		];
		const leaks = scanPrComments(comments);
		assert.strictEqual(leaks.length, 1);
		assert.strictEqual(leaks[0]?.id, 100);
		assert.include(leaks[0]?.leak.matched, "/var/folders/8f/abc/T/tmp.X");
	});

	it("multiple leaks across multiple comments are each reported", () => {
		const comments: ReadonlyArray<PrComment> = [
			{id: 1, kind: "issue", body: "clean here"},
			{id: 2, kind: "issue", body: "/tmp/a and /Users/b/c both leak"},
			{id: 3, kind: "review", body: "/private/tmp/d"},
		];
		const leaks = scanPrComments(comments);
		assert.strictEqual(leaks.length, 3);
		assert.deepStrictEqual(
			leaks.map((l) => l.id),
			[2, 2, 3],
		);
	});
});
