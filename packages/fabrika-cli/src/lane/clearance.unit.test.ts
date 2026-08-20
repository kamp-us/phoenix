import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {CAP_ROUND, RETRY_BUDGET} from "../retry-budget.ts";
import {recordClearedRound} from "./clearance.ts";
import {coderTemplateText, twoPhaseWorkflow} from "./fixtures.test-support.ts";
import {deriveStatus, foldLog, parseLog} from "./fold.ts";
import {compileText} from "./machine.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/5959/workflow.json`;
const LOG = `${ROOT}/5959/events.jsonl`;
const REF = {root: ROOT, lane: "5959"};

/** Fold what the verb appended back through the compiled template — the budget as a reader sees it. */
const budgetAfter = (workflow: string, log: string): number => {
	const compiled = compileText(workflow);
	if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
	const parsed = parseLog(log);
	if (parsed._tag !== "Parsed") throw new Error(parsed.defects.join("; "));
	const fold = foldLog(compiled.lane, parsed.entries);
	if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
	const issue = deriveStatus(compiled.lane, fold.states).context.issue as {maxRetries: number};
	return issue.maxRetries;
};

const run = (files: Record<string, string | null>, task: string | null, round: number) => {
	const fs = fakeFs({files});
	return Effect.runPromise(
		Effect.provide(recordClearedRound(REF, task, round), fs.layer).pipe(
			Effect.map((result) => ({result, written: fs.written})),
		),
	);
};

describe("recordClearedRound", () => {
	it("appends the round as a CLEARED event, so the fold reads a budget of one more", async () => {
		const {result, written} = await run({[WORKFLOW]: coderTemplateText()}, null, CAP_ROUND);
		expect(result._tag).toBe("Recorded");
		// The machine document is untouched — a grant is a line in the log, never a context edit,
		// which is what keeps an already-recorded FAIL on the routing it took (ADR 0312).
		expect(written.has(WORKFLOW)).toBe(false);
		const log = written.get(LOG) ?? "";
		expect(JSON.parse(log.trim())).toMatchObject({
			task: "issue",
			event: "ISSUE.CLEARED",
			round: CAP_ROUND,
		});
		expect(budgetAfter(coderTemplateText(), log)).toBe(RETRY_BUDGET + 1);
	});

	it("is a set, so re-running the same grant leaves the budget where it was", async () => {
		const {written} = await run({[WORKFLOW]: coderTemplateText()}, null, CAP_ROUND);
		const {result, written: again} = await run(
			{[WORKFLOW]: coderTemplateText(), [LOG]: written.get(LOG) ?? ""},
			null,
			CAP_ROUND,
		);
		expect(result._tag).toBe("AlreadyHeld");
		expect(again.size).toBe(0);
	});

	it("stacks two distinct rounds, each buying exactly one", async () => {
		const {written} = await run({[WORKFLOW]: coderTemplateText()}, null, CAP_ROUND);
		const {written: again} = await run(
			{[WORKFLOW]: coderTemplateText(), [LOG]: written.get(LOG) ?? ""},
			null,
			CAP_ROUND + 1,
		);
		expect(budgetAfter(coderTemplateText(), again.get(LOG) ?? "")).toBe(RETRY_BUDGET + 2);
	});

	it("answers NoLane rather than failing when there is no lane on this machine", async () => {
		const {result, written} = await run({}, null, 3);
		expect(result._tag).toBe("NoLane");
		expect(written.size).toBe(0);
	});

	it("refuses an unnamed task on a multi-task lane rather than guessing which one", async () => {
		const {result, written} = await run(
			{[WORKFLOW]: JSON.stringify(twoPhaseWorkflow())},
			null,
			CAP_ROUND,
		);
		expect(result).toMatchObject({_tag: "Unusable", reason: expect.stringContaining("--task")});
		expect(written.size).toBe(0);
	});

	it("refuses a task the machine does not hold", async () => {
		const {result} = await run({[WORKFLOW]: coderTemplateText()}, "issue_9", 3);
		expect(result).toMatchObject({_tag: "Unusable"});
	});
});
