import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {CAP_ROUND, RETRY_BUDGET} from "../retry-budget.ts";
import {runClear} from "./clear-verb.ts";
import {recordClearedRound} from "./clearance.ts";
import {APPEND_UNKNOWN, GRANT_REFUSED, LANE_ABSENT, RATIONALE_REFUSED} from "./codes.ts";
import {coderTemplateText, fakeProver, parkCauseRead} from "./fixtures.test-support.ts";
import {foldLog, parseLog} from "./fold.ts";
import {compileText} from "./machine.ts";
import {runTransition} from "./transition-verb.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/42/workflow.json`;
const LOG = `${ROOT}/42/events.jsonl`;
const WHY = "the three FAILs were one finding, now answered";

const line = (event: string, extra: Record<string, unknown> = {}): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at: "2026-09-10T00:00:00.000Z", ...extra})}\n`;

/** WIP, then a DONE/FAIL round per retry until the budget is spent and the task parks. */
const spent = (): string =>
	[
		line("WIP"),
		...Array.from({length: RETRY_BUDGET + 1}, () => `${line("DONE")}${line("FAIL")}`),
	].join("");

const run = (fs: ReturnType<typeof fakeFs>, rationale: string | null = WHY) =>
	Effect.runPromise(
		Effect.provide(runClear({root: ROOT, lane: "42", task: null, rationale}), fs.layer),
	);

const laneWith = (log: string, extra: Parameters<typeof fakeFs>[0] = {}) =>
	fakeFs({files: {[WORKFLOW]: coderTemplateText(), [LOG]: log}, ...extra});

describe("lane clear — the grant", () => {
	it("resumes a legacy cap-2 lane for exactly one repair without rewriting its history", async () => {
		const workflow = JSON.parse(coderTemplateText());
		workflow.machine.context.issue.maxRetries = 2;
		const workflowText = JSON.stringify(workflow).replaceAll("human:budget-spent", "frozen");
		const history = `${line("WIP")}${`${line("DONE")}${line("FAIL")}`.repeat(3)}`;
		const fs = fakeFs({files: {[WORKFLOW]: workflowText, [LOG]: history}});
		const transition = (event: string) =>
			Effect.runPromise(
				Effect.provide(
					runTransition(
						{
							root: ROOT,
							lane: "42",
							task: "issue",
							event,
							cause: null,
							classes: [],
							waitGrant: null,
							parkCause: parkCauseRead(),
							rationale: null,
							repo: "o/r",
							cwd: "/checkout",
							env: {},
						},
						fakeProver().prove,
					),
					fs.layer,
				),
			);
		const state = (log: string) => {
			const compiled = compileText(workflowText);
			if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
			const parsed = parseLog(log);
			if (parsed._tag !== "Parsed") throw new Error(parsed.defects.join("; "));
			const fold = foldLog(compiled.lane, parsed.entries);
			if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
			return fold.states.issue;
		};

		expect(CAP_ROUND).toBe(4);
		expect((await transition("UNBLOCKED")).code).toBe(36);
		expect(fs.written.size).toBe(0);
		expect(state(history)).toMatchObject({type: "frozen", retries: 2, maxRetries: 2});

		const grant = await run(fs);
		expect(grant.code).toBe(0);
		expect(JSON.parse(grant.stdout)).toMatchObject({answer: "cleared", round: 3, budget: 3});
		const grantedLog = fs.written.get(LOG) ?? "";
		expect(grantedLog.slice(0, history.length)).toBe(history);
		expect(state(grantedLog)).toMatchObject({type: "frozen", retries: 2, maxRetries: 3});
		expect(state(`${grantedLog}${line("CLEARED", {round: 3})}`)).toEqual(state(grantedLog));

		const repeated = await Effect.runPromise(
			Effect.provide(recordClearedRound({root: ROOT, lane: "42"}, "issue", 3), fs.layer),
		);
		expect(repeated._tag).toBe("AlreadyHeld");
		expect((await run(fs)).code).toBe(GRANT_REFUSED);
		expect(fs.written.get(LOG)).toBe(grantedLog);

		const resumed = await transition("UNBLOCKED");
		expect(resumed.code).toBe(0);
		expect(JSON.parse(resumed.stdout)).toMatchObject({current: {pipeline: {issue: "review"}}});
		expect((await transition("FAIL")).code).toBe(0);
		expect(state(fs.written.get(LOG) ?? "")).toMatchObject({
			type: "build",
			retries: 3,
			maxRetries: 3,
		});
		expect((await transition("DONE")).code).toBe(0);
		expect((await transition("FAIL")).code).toBe(0);
		expect(state(fs.written.get(LOG) ?? "")).toMatchObject({
			type: "frozen",
			retries: 3,
			maxRetries: 3,
		});
		const spentLog = fs.written.get(LOG) ?? "";
		expect((await transition("UNBLOCKED")).code).toBe(36);
		expect(fs.written.get(LOG)).toBe(spentLog);
		expect(spentLog.slice(0, history.length)).toBe(history);
		expect(fs.written.has(WORKFLOW)).toBe(false);
	});

	it("appends the derived round with its rationale and answers the new budget", async () => {
		const fs = laneWith(spent());

		const out = await run(fs);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "cleared",
			task: "issue",
			round: CAP_ROUND,
			budget: RETRY_BUDGET + 1,
			rationale: WHY,
		});
		const appended = (fs.written.get(LOG) ?? "").trim().split("\n");
		expect(JSON.parse(appended[appended.length - 1] ?? "")).toMatchObject({
			task: "issue",
			event: "ISSUE.CLEARED",
			round: CAP_ROUND,
			rationale: WHY,
		});
	});

	it("grants one round per call — the second call derives the round after the first", async () => {
		const fs = laneWith(
			`${spent()}${line("CLEARED", {round: CAP_ROUND})}${line("UNBLOCKED")}${line("FAIL")}`,
		);

		expect(JSON.parse((await run(fs)).stdout)).toMatchObject({
			answer: "cleared",
			round: CAP_ROUND + 1,
		});
	});
});

describe("lane clear — the refusals, each with the log unappended", () => {
	it("refuses a task that still has budget to spend", async () => {
		const fs = laneWith(line("WIP"));

		const out = await run(fs);
		expect(out.code).toBe(GRANT_REFUSED);
		expect(out.stderr.join(" ")).toContain("has budget to spend");
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("refuses an absent rationale — a grant nobody can review is not one", async () => {
		const fs = laneWith(spent());

		const out = await run(fs, null);
		expect(out.code).toBe(RATIONALE_REFUSED);
		expect(out.stderr.join(" ")).toContain("absent");
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("refuses a blank rationale for the same reason, before it reads the lane at all", async () => {
		const fs = fakeFs({files: {}});

		const out = await run(fs, "   ");
		expect(out.code).toBe(RATIONALE_REFUSED);
		expect(out.stderr.join(" ")).toContain("blank");
	});

	it("refuses an absent lane", async () => {
		const fs = fakeFs({files: {}});

		expect((await run(fs)).code).toBe(LANE_ABSENT);
	});

	it("reports a failed append as UNKNOWN, never as a cleared round", async () => {
		const fs = laneWith(spent(), {unwritable: [LOG]});

		const out = await run(fs);
		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stderr.join(" ")).toContain("NOT cleared");
	});
});
