/** The three read verbs, plus the load refusals they all share. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {WAIT_BUDGET} from "../wait-budget.ts";
import {LANE_ABSENT, LANE_UNREADABLE, MALFORMED_RECORD} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runHistory} from "./history-verb.ts";
import {runPrint} from "./print-verb.ts";
import {runStatus} from "./status-verb.ts";
import type {LaneRef} from "./store.ts";

const ROOT = ".fabrika/lanes";
const REF: LaneRef = {root: ROOT, lane: "42"};
const WORKFLOW = `${ROOT}/42/workflow.json`;
const LOG = `${ROOT}/42/events.jsonl`;

const logLine = (event: string): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at: "2026-08-16T00:00:00.000Z"})}\n`;

const run = (fs: ReturnType<typeof fakeFs>, verb: typeof runStatus) =>
	Effect.runPromise(Effect.provide(verb(REF), fs.layer));

const freshLane = (files: Record<string, string> = {}) =>
	fakeFs({files: {[WORKFLOW]: coderTemplateText(), ...files}});

describe("lane status", () => {
	it("answers the fresh-lane shape with no events.jsonl on disk at all", async () => {
		const out = await run(freshLane(), runStatus);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			stateValue: {pipeline: {issue: "queued"}},
			status: "active",
			context: {
				issue: {retries: 0, maxRetries: 2, waits: 0, maxWaits: WAIT_BUDGET},
				errors: [],
			},
		});
	});

	it("folds the log fresh each invocation — state comes from the events, nowhere else", async () => {
		const out = await run(freshLane({[LOG]: logLine("WIP") + logLine("DONE")}), runStatus);

		expect(JSON.parse(out.stdout)).toMatchObject({stateValue: {pipeline: {issue: "review"}}});
	});

	it("refuses a log that does not replay through the machine as a malformed record", async () => {
		const out = await run(freshLane({[LOG]: logLine("PASS")}), runStatus);

		expect(out.code).toBe(MALFORMED_RECORD);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("does not replay");
	});
});

describe("lane history", () => {
	it("answers the log verbatim, [] on a fresh lane", async () => {
		const fresh = await run(freshLane(), runHistory);
		expect(fresh.code).toBe(0);
		expect(JSON.parse(fresh.stdout)).toEqual([]);

		const out = await run(freshLane({[LOG]: logLine("WIP")}), runHistory);
		expect(JSON.parse(out.stdout)).toEqual([
			{task: "issue", event: "ISSUE.WIP", at: "2026-08-16T00:00:00.000Z"},
		]);
	});

	it("refuses a log line that does not parse, naming the line", async () => {
		const out = await run(freshLane({[LOG]: `${logLine("WIP")}not json\n`}), runHistory);

		expect(out.code).toBe(MALFORMED_RECORD);
		expect(out.stderr.join("\n")).toContain("line 2");
	});
});

describe("lane print", () => {
	it("answers the compiled topology — phases, terminals, per-state legal events", async () => {
		const out = await run(freshLane(), runPrint);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			phases: [{name: "pipeline", tasks: ["issue"]}],
			terminals: {complete: "complete", tripped: "tripped"},
			tasks: {issue: {initial: "queued", maxRetries: 2, maxWaits: WAIT_BUDGET}},
		});
	});
});

describe("the shared load refusals", () => {
	it("refuses an absent lane as proven absence, naming the template remedy", async () => {
		const out = await run(fakeFs({files: {}}), runStatus);

		expect(out.code).toBe(LANE_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("template");
	});

	it("refuses an unreadable lane as UNKNOWN, never as fresh", async () => {
		const out = await run(fakeFs({files: {[WORKFLOW]: null}, unprobeable: [WORKFLOW]}), runStatus);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.at(-1)).toContain("UNKNOWN");
	});

	it("refuses a workflow.json the compiler rejects, with every defect on stderr", async () => {
		const out = await run(fakeFs({files: {[WORKFLOW]: '{"machine":{"states":{}}}'}}), runPrint);

		expect(out.code).toBe(MALFORMED_RECORD);
		expect(out.stderr.join("\n")).toContain("parallel");
	});

	it("keeps the three load outcomes on three distinct codes", () => {
		expect(new Set([LANE_ABSENT, LANE_UNREADABLE, MALFORMED_RECORD]).size).toBe(3);
	});
});
