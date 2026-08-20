import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeHttp, fakeShell, type HttpReply, okOut, once} from "../fakes.test-support.ts";
import {runsAtHead, workflowRun} from "../heal-ci/fixtures.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {HEAD} from "./fixtures.test-support.ts";
import {assertFloorAt, floorLine, floorToken} from "./floor-assert.ts";

const RUNS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs\?head_sha=/;
const RUN = /^gh api repos\/o\/r\/actions\/runs\/\d+$/;
const RERUN = /^gh api --method POST repos\/o\/r\/actions\/runs\/\d+\/rerun-failed-jobs$/;

const FLOOR = 31_863_008_185;

/** The runs-at-head envelope, served — the read moved to the fetch client, the payload did not. */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

const assert = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	http: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
) =>
	Effect.runPromise(
		Effect.provide(
			assertFloorAt("o/r", HEAD),
			Layer.merge(fakeShell(script).layer, fakeHttp(http).layer),
		),
	);

const withCalls = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	http: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
) => {
	const shell = fakeShell(script);
	const client = fakeHttp(http);
	return Effect.runPromise(
		Effect.provide(assertFloorAt("o/r", HEAD), Layer.merge(shell.layer, client.layer)),
	).then((assertion) => ({assertion, shell, client}));
};

/** A red floor run at the head, re-fired into a second attempt. */
const red = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
	[RERUN, okOut("")],
	[RUN, workflowRun({id: FLOOR, attempt: 2})],
];

/** What the runs read answers for that same red floor run. */
const redRuns = (): ReadonlyArray<readonly [RegExp, HttpReply]> => [
	[
		RUNS,
		served(
			runsAtHead(2, [
				{id: 1, name: "ci"},
				{id: FLOOR, name: "governance-floor"},
			]),
		),
	],
];

describe("assertFloorAt re-derives the floor rather than claiming it", () => {
	it("re-fires the red floor run at this head and proves the new attempt", async () => {
		const {assertion, shell, client} = await withCalls(red(), redRuns());
		expect(assertion).toEqual({_tag: "Refired", run: FLOOR, attempt: 2});
		expect(shell.calls.some((call) => RERUN.test(call))).toBe(true);
		// The re-fire re-runs `ship floor` in CI. Nothing here writes a check-run or a status, so the
		// green a PR ends up with is one the gate's own job derived (#5585).
		expect([...shell.calls, ...client.calls].some((call) => call.includes("check-runs"))).toBe(
			false,
		);
	});

	it("picks the NEWEST floor run at the head, not the first one listed", async () => {
		const {shell} = await withCalls(
			[
				[once(RUN), workflowRun({id: 900, attempt: 1})],
				[RERUN, okOut("")],
				[RUN, workflowRun({id: 900, attempt: 2})],
			],
			[
				[
					RUNS,
					served(
						runsAtHead(2, [
							{id: 700, name: "governance-floor"},
							{id: 900, name: "governance-floor"},
						]),
					),
				],
			],
		);
		expect(shell.calls.some((call) => call.endsWith("/actions/runs/900"))).toBe(true);
		expect(shell.calls.some((call) => call.endsWith("/actions/runs/700"))).toBe(false);
	});

	it("leaves an in-flight run alone — it cannot be re-fired, and saying so is the answer", async () => {
		const {assertion, shell} = await withCalls(
			[],
			[
				[
					RUNS,
					served(runsAtHead(1, [{id: FLOOR, name: "governance-floor", status: "in_progress"}])),
				],
			],
		);
		expect(assertion).toEqual({_tag: "InFlight", run: FLOOR});
		expect(shell.calls.some((call) => RERUN.test(call))).toBe(false);
	});

	it("re-fires nothing when the run at this head already reads green", async () => {
		const {assertion, shell} = await withCalls(
			[],
			[
				[
					RUNS,
					served(runsAtHead(1, [{id: FLOOR, name: "governance-floor", conclusion: "success"}])),
				],
			],
		);
		expect(assertion).toEqual({_tag: "Green", run: FLOOR});
		expect(shell.calls.some((call) => RERUN.test(call))).toBe(false);
	});

	// GitHub bumps `run_attempt` a beat after it accepts the dispatch, and calling that beat UNKNOWN
	// sent three agents to `heal-ci` over re-fires that had taken and went green untouched (#5982).
	it("reads a same-id run that is running again as a re-fire to wait on, not UNKNOWN", async () => {
		const {assertion, shell} = await withCalls(
			[
				[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
				[RERUN, okOut("")],
				[RUN, workflowRun({id: FLOOR, attempt: 1, status: "in_progress", conclusion: null})],
			],
			[[RUNS, served(runsAtHead(1, [{id: FLOOR, name: "governance-floor"}]))]],
		);
		expect(assertion).toEqual({_tag: "Restarting", run: FLOOR, status: "in_progress"});
		expect(shell.calls.some((call) => RERUN.test(call))).toBe(true);
	});

	it("reads a queued same-id run the same way — the counter has simply not caught up", async () => {
		const assertion = await assert(
			[
				[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
				[RERUN, okOut("")],
				[RUN, workflowRun({id: FLOOR, attempt: 1, status: "queued", conclusion: null})],
			],
			[[RUNS, served(runsAtHead(1, [{id: FLOOR, name: "governance-floor"}]))]],
		);
		expect(assertion).toEqual({_tag: "Restarting", run: FLOOR, status: "queued"});
	});

	it("answers NoRun when the repository runs no floor at this head", async () => {
		expect(await assert([], [[RUNS, served(runsAtHead(1, [{id: 1, name: "ci"}]))]])).toEqual({
			_tag: "NoRun",
		});
	});
});

describe("every unread state is UNKNOWN, never a re-fire nobody proved", () => {
	it("refuses to read NoRun out of a truncated run list", async () => {
		const assertion = await assert([], [[RUNS, served(runsAtHead(9, [{id: 1, name: "ci"}]))]]);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("of 9 declared runs");
	});

	it("reports a failed re-fire request as UNKNOWN", async () => {
		const assertion = await assert(
			[
				[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
				[RERUN, errOut("gh: Forbidden (HTTP 403)")],
			],
			[[RUNS, served(runsAtHead(1, [{id: FLOOR, name: "governance-floor"}]))]],
		);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("403");
	});

	// The dispatch's 2xx is an acknowledgement, not an attempt: a re-fire reported on the strength of
	// the response would tell the caller a red is clearing itself when nothing re-ran.
	it("refuses to call it re-fired when the run stayed completed at the same attempt", async () => {
		const assertion = await assert(
			[
				[RUN, workflowRun({id: FLOOR, attempt: 1})],
				[RERUN, okOut("")],
			],
			[[RUNS, served(runsAtHead(1, [{id: FLOOR, name: "governance-floor"}]))]],
		);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("stayed at attempt 1");
	});

	it("reports an unreadable run list as UNKNOWN", async () => {
		const assertion = await assert([], [[RUNS, {status: 502, body: '{"message":"Bad gateway"}'}]]);
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
