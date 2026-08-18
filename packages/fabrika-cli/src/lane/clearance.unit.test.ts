import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {RETRY_BUDGET} from "../retry-budget.ts";
import {recordClearedRound} from "./clearance.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {compileText} from "./machine.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/5959/workflow.json`;
const REF = {root: ROOT, lane: "5959"};

const run = (files: Record<string, string | null>, task: string | null, round: number) => {
	const fs = fakeFs({files});
	return Effect.runPromise(
		Effect.provide(recordClearedRound(REF, task, round), fs.layer).pipe(
			Effect.map((result) => ({result, written: fs.written})),
		),
	);
};

describe("recordClearedRound", () => {
	it("writes the round into the task's context, so the guard reads a budget of one more", async () => {
		const {result, written} = await run({[WORKFLOW]: coderTemplateText()}, null, 3);
		expect(result._tag).toBe("Recorded");
		const text = written.get(WORKFLOW) ?? "";
		const compiled = compileText(text);
		if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
		expect(compiled.lane.tasks.issue?.initial.maxRetries).toBe(RETRY_BUDGET + 1);
		expect(compiled.lane.tasks.issue?.extras.clearedRounds).toEqual([3]);
	});

	it("is a set, so re-running the same grant leaves the budget where it was", async () => {
		const {written} = await run({[WORKFLOW]: coderTemplateText()}, null, 3);
		const {result, written: again} = await run({[WORKFLOW]: written.get(WORKFLOW) ?? ""}, null, 3);
		expect(result._tag).toBe("AlreadyHeld");
		expect(again.size).toBe(0);
	});

	it("stacks two distinct rounds, each buying exactly one", async () => {
		const {written} = await run({[WORKFLOW]: coderTemplateText()}, null, 3);
		const {written: again} = await run({[WORKFLOW]: written.get(WORKFLOW) ?? ""}, null, 4);
		const compiled = compileText(again.get(WORKFLOW) ?? "");
		if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
		expect(compiled.lane.tasks.issue?.initial.maxRetries).toBe(RETRY_BUDGET + 2);
	});

	it("answers NoLane rather than failing when there is no lane on this machine", async () => {
		const {result, written} = await run({}, null, 3);
		expect(result._tag).toBe("NoLane");
		expect(written.size).toBe(0);
	});

	it("refuses an unnamed task on a multi-task lane rather than guessing which one", async () => {
		const document = JSON.stringify({
			machine: {context: {issue_1: {retries: 0}, issue_2: {retries: 0}}},
		});
		const {result, written} = await run({[WORKFLOW]: document}, null, 3);
		expect(result).toMatchObject({_tag: "Unusable"});
		expect(written.size).toBe(0);
	});

	it("refuses a task the machine does not hold", async () => {
		const {result} = await run({[WORKFLOW]: coderTemplateText()}, "issue_9", 3);
		expect(result).toMatchObject({_tag: "Unusable"});
	});
});
