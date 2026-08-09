import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {ENV, pull, timeline, unexhaustedPage} from "./fixtures.test-support.ts";
import {ADDED, MERGED, REMOVED} from "./queue.ts";
import {runReconcile} from "./reconcile-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const RULES = /^gh api repos\/o\/r\/rules\/branches\/main$/;
const SUBJECTS = /^gh api repos\/o\/r\/commits\?sha=main/;
const TIMELINE = /^gh api -i repos\/o\/r\/issues\/4321\/timeline/;

// One poll, zero cadence: the classification is what is under test, not the sleep.
const options = {pr: 4321, polls: 1, cadenceSeconds: 0, repo: null, json: false, env: ENV};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runReconcile({...options, ...overrides}), fakeShell(script).layer),
	);

const withQueue = okOut(JSON.stringify([{type: "merge_queue"}]));
const noSubjects = okOut("");

describe("runReconcile", () => {
	it("classifies landed off merged:true", async () => {
		const out = await run([
			[PULL, pull({merged: true, state: "closed"})],
			[RULES, withQueue],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("reconcile\tlanded\t1\t0\n");
	});

	it("classifies landed off a base-branch squash whose subject ENDS with the number", async () => {
		const out = await run([
			[PULL, pull()],
			[RULES, withQueue],
			[SUBJECTS, okOut("fix(x): a thing (#3924) (#4321)")],
		]);
		expect(out.stdout).toBe("reconcile\tlanded\t1\t0\n");
	});

	it("does NOT credit a landing whose subject merely mentions the number", async () => {
		const out = await run([
			[PULL, pull()],
			[RULES, withQueue],
			[SUBJECTS, okOut("fix(x): a thing (#4321) (#4999)")],
			[TIMELINE, timeline({event: ADDED, at: "2026-08-08T10:00:00Z"})],
		]);
		expect(out.stdout).toBe("reconcile\tunresolved\t1\t0\n");
	});

	it("reports `ejected` as a proven answer at exit 0, never an error (#4557)", async () => {
		const out = await run([
			[PULL, pull()],
			[RULES, withQueue],
			[SUBJECTS, noSubjects],
			[
				TIMELINE,
				timeline(
					{event: ADDED, at: "2026-08-08T10:00:00Z"},
					{event: REMOVED, at: "2026-08-08T10:05:00Z"},
				),
			],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("reconcile\tejected\t1\t0\n");
	});

	it("does not call a merge-paired removal an ejection (#4155)", async () => {
		const out = await run([
			[PULL, pull()],
			[RULES, withQueue],
			[SUBJECTS, noSubjects],
			[
				TIMELINE,
				timeline(
					{event: REMOVED, at: "2026-08-08T10:04:59Z"},
					{event: MERGED, at: "2026-08-08T10:05:00Z"},
				),
			],
		]);
		expect(out.stdout).not.toContain("ejected");
	});

	it("reports `parked` when the arm never entered a queue on a queue-governed base", async () => {
		const out = await run([
			[PULL, pull()],
			[RULES, withQueue],
			[SUBJECTS, noSubjects],
			[TIMELINE, timeline()],
		]);
		expect(out.stdout).toBe("reconcile\tparked\t1\t0\n");
	});

	it("reports `unresolved` off a queue, where a long dwell is ordinary", async () => {
		const out = await run([
			[PULL, pull()],
			[RULES, okOut(JSON.stringify([]))],
			[SUBJECTS, noSubjects],
			[TIMELINE, timeline()],
		]);
		expect(out.stdout).toBe("reconcile\tunresolved\t1\t0\n");
	});

	it("refuses on 11 when every poll failed to read — UNKNOWN, not `unresolved`", async () => {
		const out = await run([
			[PULL, pull()],
			[RULES, withQueue],
			[SUBJECTS, noSubjects],
			[TIMELINE, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('the outcome is UNKNOWN, not "unresolved"');
	});

	it("refuses an unexhausted timeline on 13 — a truncated history classifies nothing", async () => {
		const out = await run([
			[PULL, pull()],
			[RULES, withQueue],
			[SUBJECTS, noSubjects],
			[TIMELINE, unexhaustedPage()],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"ship reconcile: the timeline read never reached a terminal page — pagination is unexhausted; refusing to classify over a truncated history.",
		);
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});
