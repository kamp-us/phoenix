import {assert, describe, it} from "@effect/vitest";
import {RecommendAnswers} from "./recommends.ts";

describe("RecommendAnswers", () => {
	it("asks about every recommended package nobody answered, each once, in the project's order", () => {
		assert.deepStrictEqual(RecommendAnswers.none.unasked("/work/demlik", ["b", "a", "b"]), [
			"b",
			"a",
		]);
	});

	it("remembers a no for its project only, under any spelling of the folder", () => {
		const answers = RecommendAnswers.none.answer("/work/demlik", "tuval-cron", "decline");
		assert.deepStrictEqual(answers.unasked("/work/demlik/", ["tuval-cron", "tuval-worktree"]), [
			"tuval-worktree",
		]);
		assert.deepStrictEqual(answers.unasked("/work/tea", ["tuval-cron"]), ["tuval-cron"]);
		assert.strictEqual(answers.answerFor("/work/demlik", "tuval-cron"), "decline");
	});

	it("remembers a yes too, so the project is asked once whatever the answer", () => {
		const answers = RecommendAnswers.none.answer("/work/demlik", "tuval-cron", "install");
		assert.deepStrictEqual(answers.unasked("/work/demlik", ["tuval-cron"]), []);
	});

	it("writes one record per folder, and reads it back to the same answers", () => {
		const answers = RecommendAnswers.none
			.answer("/work/demlik", "tuval-cron", "decline")
			.answer("/work/tea", "tuval-worktree", "install")
			.answer("/work/demlik/", "tuval-worktree", "install");
		assert.deepStrictEqual(answers.record, [
			{folder: "/work/demlik", answers: {"tuval-cron": "decline", "tuval-worktree": "install"}},
			{folder: "/work/tea", answers: {"tuval-worktree": "install"}},
		]);
		assert.deepStrictEqual(RecommendAnswers.of(answers.record).record, answers.record);
	});

	it("answers the same answer twice with the same value", () => {
		const once = RecommendAnswers.none.answer("/work/demlik", "tuval-cron", "decline");
		assert.strictEqual(once.answer("/work/demlik", "tuval-cron", "decline"), once);
	});
});
