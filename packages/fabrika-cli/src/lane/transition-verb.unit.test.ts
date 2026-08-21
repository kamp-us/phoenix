import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {
	APPEND_UNKNOWN,
	CAUSE_UNRECOGNISED,
	CLASS_UNRECOGNISED,
	EVENT_REFUSED,
	LANE_ABSENT,
	TASK_UNKNOWN,
} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runTransition} from "./transition-verb.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/42/workflow.json`;
const LOG = `${ROOT}/42/events.jsonl`;

const logLine = (event: string): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at: "2026-08-16T00:00:00.000Z"})}\n`;

const run = (
	fs: ReturnType<typeof fakeFs>,
	event: string,
	task: string | null = null,
	cause: string | null = null,
	classes: ReadonlyArray<string> = [],
) =>
	Effect.runPromise(
		Effect.provide(runTransition({root: ROOT, lane: "42", event, task, cause, classes}), fs.layer),
	);

const freshLane = (log?: string, extra: Parameters<typeof fakeFs>[0] = {}) =>
	fakeFs({
		files: {[WORKFLOW]: coderTemplateText(), ...(log === undefined ? {} : {[LOG]: log})},
		...extra,
	});

describe("lane transition — the answer", () => {
	it("appends the accepted event and answers the two stateValues around the fold", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP");
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			previous: {pipeline: {issue: "queued"}},
			event: "ISSUE.WIP",
			current: {pipeline: {issue: "build"}},
			taskAffected: "issue",
		});

		const appended = fs.written.get(LOG);
		expect(appended).toBeDefined();
		expect(JSON.parse(appended?.trim() ?? "")).toMatchObject({task: "issue", event: "ISSUE.WIP"});
	});

	it("folds the existing log first, so the event lands on the folded state", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "DONE");
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			previous: {pipeline: {issue: "build"}},
			current: {pipeline: {issue: "review"}},
		});
	});

	it("folds a lower-case event to the operator's spelling", async () => {
		const out = await run(freshLane(), "wip");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({event: "ISSUE.WIP"});
	});
});

describe("lane transition — refuse without append", () => {
	it("refuses an event the state holds no cell for, log byte-identical, nothing written", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "PASS");
		expect(out.code).toBe(EVENT_REFUSED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("NoCellError");
		expect(out.stderr.at(-1)).toContain("log unappended");
		expect(fs.written.size).toBe(0);
	});

	it("refuses an event outside the operator's six the same way", async () => {
		const fs = freshLane();

		const out = await run(fs, "MERGE");
		expect(out.code).toBe(EVENT_REFUSED);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a task the machine does not have on its own code", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP", "nope");
		expect(out.code).toBe(TASK_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('"nope"');
		expect(fs.written.size).toBe(0);
	});

	it("refuses a lane that is provably not there, naming the remedy", async () => {
		const fs = fakeFs({files: {}});

		const out = await run(fs, "WIP");
		expect(out.code).toBe(LANE_ABSENT);
		expect(out.stderr.at(-1)).toContain("template");
		expect(fs.written.size).toBe(0);
	});

	it("reports an append that did not land as NOT recorded, never as an answer", async () => {
		const fs = freshLane(undefined, {unwritable: [LOG]});

		const out = await run(fs, "WIP");
		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("NOT recorded");
	});

	it("seats its codes above the reserved band, distinct from each other", () => {
		const codes = [LANE_ABSENT, EVENT_REFUSED, TASK_UNKNOWN, APPEND_UNKNOWN, CAUSE_UNRECOGNISED];
		expect(new Set(codes).size).toBe(codes.length);
		for (const code of codes) expect(code).toBeGreaterThanOrEqual(3);
	});
});

describe("lane transition — the park cause a driver-originated BLOCKED carries (#6480)", () => {
	it("records a known cause on the event line", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "BLOCKED", null, "worktree-holds-branch");

		expect(out.code).toBe(0);
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(appended).toMatchObject({event: "ISSUE.BLOCKED", cause: "worktree-holds-branch"});
	});

	it("refuses a cause outside the closed set, log byte-identical", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "BLOCKED", null, "the-tree-was-busy");

		expect(out.code).toBe(CAUSE_UNRECOGNISED);
		expect(out.stderr.at(-1)).toContain("log unappended");
		expect(fs.written.size).toBe(0);
	});

	it("refuses a cause on an event that is not a park", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP", null, "worktree-holds-branch");

		expect(out.code).toBe(CAUSE_UNRECOGNISED);
		expect(fs.written.size).toBe(0);
	});

	it("appends a causeless event with no cause key, exactly as it always did", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "BLOCKED");

		expect(out.code).toBe(0);
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(Object.keys(appended).sort()).toEqual(["at", "event", "task"]);
	});
});

describe("lane transition — the lane class the `class:<name>` arms route on (ADR 0317)", () => {
	it("records a known class on the event line and routes the arm that reads it", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP", null, null, ["ui"]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({current: {pipeline: {issue: "build:ui"}}});
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(appended).toMatchObject({event: "ISSUE.WIP", classes: ["ui"]});
	});

	it("refuses a class outside the closed set instead of routing it as unclassed", async () => {
		const fs = freshLane();

		// The miss this closes: `UI` matched no `class:ui` arm, so the guarded array fell through and
		// the lane built plain — a routing failure nothing said out loud.
		const out = await run(fs, "WIP", null, null, ["UI-ish"]);

		expect(out.code).toBe(CLASS_UNRECOGNISED);
		expect(out.stderr.at(-1)).toContain("log unappended");
		expect(fs.written.size).toBe(0);
	});

	it("normalises a class's spelling the way a cause's is normalised", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP", null, null, [" UI "]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({current: {pipeline: {issue: "build:ui"}}});
	});
});
