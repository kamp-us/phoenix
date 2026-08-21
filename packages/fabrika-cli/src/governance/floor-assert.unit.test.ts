import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, once, type Scripted} from "../fakes.test-support.ts";
import {
	accepted,
	httpError,
	RERUN,
	RUN,
	runsAtHead,
	workflowRun,
} from "../heal-ci/fixtures.test-support.ts";
import {HEAD} from "./fixtures.test-support.ts";
import {assertFloorAt, floorLine, floorToken} from "./floor-assert.ts";

/** The paged envelope read at the head — `&per_page=100&page=1` follows, so no `$` anchor. */
const RUNS = /^GET .*\/repos\/o\/r\/actions\/runs\?head_sha=/;

const FLOOR = 31_863_008_185;

const assert = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(Effect.provide(assertFloorAt("o/r", HEAD), fakeSeams(script).layer));

const withCalls = (script: ReadonlyArray<Scripted>) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(Effect.provide(assertFloorAt("o/r", HEAD), seams.layer)).then(
		(assertion) => ({assertion, seams}),
	);
};

/** The `{total_count, workflow_runs}` envelope the run list at a head is read out of. */
const listed = (
	...rows: ReadonlyArray<{id: number; name?: string; status?: string; conclusion?: string | null}>
): ReadonlyArray<Scripted> => [[RUNS, {status: 200, body: runsAtHead(rows.length, rows).stdout}]];

/** A red floor run at the head, re-fired into a second attempt. */
const red = (): ReadonlyArray<Scripted> => [
	[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
	[RERUN, accepted],
	[RUN, workflowRun({id: FLOOR, attempt: 2})],
];

describe("assertFloorAt re-derives the floor rather than claiming it", () => {
	it("re-fires the red floor run at this head and proves the new attempt", async () => {
		const {assertion, seams} = await withCalls([
			...red(),
			...listed({id: 1, name: "ci"}, {id: FLOOR, name: "governance-floor"}),
		]);
		expect(assertion).toEqual({_tag: "Refired", run: FLOOR, attempt: 2});
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(true);
		// The re-fire re-runs `ship floor` in CI. Nothing here writes a check-run or a status, so the
		// green a PR ends up with is one the gate's own job derived (#5585).
		expect(seams.log.some((call) => call.includes("check-runs"))).toBe(false);
	});

	it("picks the NEWEST floor run at the head, not the first one listed", async () => {
		const {seams} = await withCalls([
			[once(RUN), workflowRun({id: 900, attempt: 1})],
			[RERUN, accepted],
			[RUN, workflowRun({id: 900, attempt: 2})],
			...listed({id: 700, name: "governance-floor"}, {id: 900, name: "governance-floor"}),
		]);
		expect(seams.requests.some((call) => call.endsWith("/actions/runs/900"))).toBe(true);
		expect(seams.requests.some((call) => call.endsWith("/actions/runs/700"))).toBe(false);
	});

	it("leaves an in-flight run alone — it cannot be re-fired, and saying so is the answer", async () => {
		const {assertion, seams} = await withCalls(
			listed({id: FLOOR, name: "governance-floor", status: "in_progress"}),
		);
		expect(assertion).toEqual({_tag: "InFlight", run: FLOOR});
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(false);
	});

	it("re-fires nothing when the run at this head already reads green", async () => {
		const {assertion, seams} = await withCalls(
			listed({id: FLOOR, name: "governance-floor", conclusion: "success"}),
		);
		expect(assertion).toEqual({_tag: "Green", run: FLOOR});
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(false);
	});

	// GitHub bumps `run_attempt` a beat after it accepts the dispatch, and calling that beat UNKNOWN
	// sent three agents to `heal-ci` over re-fires that had taken and went green untouched (#5982).
	it("reads a same-id run that is running again as a re-fire to wait on, not UNKNOWN", async () => {
		const {assertion, seams} = await withCalls([
			[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
			[RERUN, accepted],
			[RUN, workflowRun({id: FLOOR, attempt: 1, status: "in_progress", conclusion: null})],
			...listed({id: FLOOR, name: "governance-floor"}),
		]);
		expect(assertion).toEqual({_tag: "Restarting", run: FLOOR, status: "in_progress"});
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(true);
	});

	it("reads a queued same-id run the same way — the counter has simply not caught up", async () => {
		const assertion = await assert([
			[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
			[RERUN, accepted],
			[RUN, workflowRun({id: FLOOR, attempt: 1, status: "queued", conclusion: null})],
			...listed({id: FLOOR, name: "governance-floor"}),
		]);
		expect(assertion).toEqual({_tag: "Restarting", run: FLOOR, status: "queued"});
	});

	it("answers NoRun when the repository runs no floor at this head", async () => {
		expect(await assert(listed({id: 1, name: "ci"}))).toEqual({_tag: "NoRun"});
	});
});

describe("every unread state is UNKNOWN, never a re-fire nobody proved", () => {
	it("refuses to read NoRun out of a truncated run list", async () => {
		const assertion = await assert([
			[RUNS, {status: 200, body: runsAtHead(9, [{id: 1, name: "ci"}]).stdout}],
		]);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("of 9 declared runs");
	});

	it("reports a failed re-fire request as UNKNOWN", async () => {
		const assertion = await assert([
			[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
			[RERUN, httpError(403, "Forbidden")],
			...listed({id: FLOOR, name: "governance-floor"}),
		]);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("403");
	});

	// The dispatch's 2xx is an acknowledgement, not an attempt: a re-fire reported on the strength of
	// the response would tell the caller a red is clearing itself when nothing re-ran.
	it("refuses to call it re-fired when the run stayed completed at the same attempt", async () => {
		const assertion = await assert([
			[RUN, workflowRun({id: FLOOR, attempt: 1})],
			[RERUN, accepted],
			...listed({id: FLOOR, name: "governance-floor"}),
		]);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("stayed at attempt 1");
	});

	it("reports an unreadable run list as UNKNOWN", async () => {
		const assertion = await assert([[RUNS, {status: 502, body: "{}"}]]);
		expect(assertion._tag).toBe("Unknown");
	});
});

describe("floorLine says what the caller must do next", () => {
	it("names the attempt on a re-fire and the residual red otherwise", async () => {
		expect(floorLine("governance post", {_tag: "Refired", run: FLOOR, attempt: 2})).toContain(
			"attempt 2",
		);
		expect(floorLine("governance post", {_tag: "Unknown", reason: "502"})).toContain(
			"may still need a re-fire",
		);
		expect(floorLine("governance post", {_tag: "InFlight", run: FLOOR})).toContain("re-read");
	});

	it("tells a restarting re-fire to wait on its run rather than escalate", () => {
		const line = floorLine("governance post", {
			_tag: "Restarting",
			run: FLOOR,
			status: "in_progress",
		});
		expect(line).toContain(String(FLOOR));
		expect(line).toContain("wait and re-read");
		expect(line).toContain("nothing to escalate");
		expect(floorToken({_tag: "Restarting", run: FLOOR, status: "in_progress"})).toBe("restarting");
	});
});
