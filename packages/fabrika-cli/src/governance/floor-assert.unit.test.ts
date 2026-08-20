import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeHttp, fakeShell, type HttpReply, once} from "../fakes.test-support.ts";
import {
	accepted,
	ENV,
	httpError,
	RERUN,
	RUN,
	runsAtHead,
	workflowRun,
} from "../heal-ci/fixtures.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {HEAD} from "./fixtures.test-support.ts";
import {assertFloorAt, floorLine, floorToken} from "./floor-assert.ts";

const RUNS = /^gh api --paginate repos\/o\/r\/actions\/runs\?head_sha=/;

const FLOOR = 31_863_008_185;

const assert = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	served: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
) =>
	Effect.runPromise(
		Effect.provide(
			assertFloorAt("o/r", HEAD, ENV),
			Layer.merge(fakeShell(script).layer, fakeHttp(served).layer),
		),
	);

const withCalls = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	served: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
) => {
	const shell = fakeShell(script);
	const http = fakeHttp(served);
	return Effect.runPromise(
		Effect.provide(assertFloorAt("o/r", HEAD, ENV), Layer.merge(shell.layer, http.layer)),
	).then((assertion) => ({assertion, shell, http}));
};

/** The run list at the head, still a `gh` read — it lives in `ship/github.ts`, not this port. */
const listed = (
	...rows: ReadonlyArray<{id: number; name?: string; status?: string; conclusion?: string | null}>
): ReadonlyArray<readonly [RegExp, ExecResult]> => [[RUNS, runsAtHead(rows.length, rows)]];

/** A red floor run at the head, re-fired into a second attempt. */
const red = (): ReadonlyArray<readonly [RegExp, HttpReply]> => [
	[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
	[RERUN, accepted],
	[RUN, workflowRun({id: FLOOR, attempt: 2})],
];

describe("assertFloorAt re-derives the floor rather than claiming it", () => {
	it("re-fires the red floor run at this head and proves the new attempt", async () => {
		const {assertion, shell, http} = await withCalls(
			listed({id: 1, name: "ci"}, {id: FLOOR, name: "governance-floor"}),
			red(),
		);
		expect(assertion).toEqual({_tag: "Refired", run: FLOOR, attempt: 2});
		expect(http.calls.some((call) => RERUN.test(call))).toBe(true);
		// The re-fire re-runs `ship floor` in CI. Nothing here writes a check-run or a status, so the
		// green a PR ends up with is one the gate's own job derived (#5585).
		expect([...shell.calls, ...http.calls].some((call) => call.includes("check-runs"))).toBe(false);
	});

	it("picks the NEWEST floor run at the head, not the first one listed", async () => {
		const {http} = await withCalls(
			listed({id: 700, name: "governance-floor"}, {id: 900, name: "governance-floor"}),
			[
				[once(RUN), workflowRun({id: 900, attempt: 1})],
				[RERUN, accepted],
				[RUN, workflowRun({id: 900, attempt: 2})],
			],
		);
		expect(http.calls.some((call) => call.endsWith("/actions/runs/900"))).toBe(true);
		expect(http.calls.some((call) => call.endsWith("/actions/runs/700"))).toBe(false);
	});

	it("leaves an in-flight run alone — it cannot be re-fired, and saying so is the answer", async () => {
		const {assertion, http} = await withCalls(
			listed({id: FLOOR, name: "governance-floor", status: "in_progress"}),
		);
		expect(assertion).toEqual({_tag: "InFlight", run: FLOOR});
		expect(http.calls.some((call) => RERUN.test(call))).toBe(false);
	});

	it("re-fires nothing when the run at this head already reads green", async () => {
		const {assertion, http} = await withCalls(
			listed({id: FLOOR, name: "governance-floor", conclusion: "success"}),
		);
		expect(assertion).toEqual({_tag: "Green", run: FLOOR});
		expect(http.calls.some((call) => RERUN.test(call))).toBe(false);
	});

	// GitHub bumps `run_attempt` a beat after it accepts the dispatch, and calling that beat UNKNOWN
	// sent three agents to `heal-ci` over re-fires that had taken and went green untouched (#5982).
	it("reads a same-id run that is running again as a re-fire to wait on, not UNKNOWN", async () => {
		const {assertion, http} = await withCalls(listed({id: FLOOR, name: "governance-floor"}), [
			[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
			[RERUN, accepted],
			[RUN, workflowRun({id: FLOOR, attempt: 1, status: "in_progress", conclusion: null})],
		]);
		expect(assertion).toEqual({_tag: "Restarting", run: FLOOR, status: "in_progress"});
		expect(http.calls.some((call) => RERUN.test(call))).toBe(true);
	});

	it("reads a queued same-id run the same way — the counter has simply not caught up", async () => {
		const assertion = await assert(listed({id: FLOOR, name: "governance-floor"}), [
			[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
			[RERUN, accepted],
			[RUN, workflowRun({id: FLOOR, attempt: 1, status: "queued", conclusion: null})],
		]);
		expect(assertion).toEqual({_tag: "Restarting", run: FLOOR, status: "queued"});
	});

	it("answers NoRun when the repository runs no floor at this head", async () => {
		expect(await assert(listed({id: 1, name: "ci"}))).toEqual({_tag: "NoRun"});
	});
});

describe("every unread state is UNKNOWN, never a re-fire nobody proved", () => {
	it("refuses to read NoRun out of a truncated run list", async () => {
		const assertion = await assert([[RUNS, runsAtHead(9, [{id: 1, name: "ci"}])]]);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("of 9 declared runs");
	});

	it("reports a failed re-fire request as UNKNOWN", async () => {
		const assertion = await assert(listed({id: FLOOR, name: "governance-floor"}), [
			[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
			[RERUN, httpError(403, "Forbidden")],
		]);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("403");
	});

	// The dispatch's 2xx is an acknowledgement, not an attempt: a re-fire reported on the strength of
	// the response would tell the caller a red is clearing itself when nothing re-ran.
	it("refuses to call it re-fired when the run stayed completed at the same attempt", async () => {
		const assertion = await assert(listed({id: FLOOR, name: "governance-floor"}), [
			[RUN, workflowRun({id: FLOOR, attempt: 1})],
			[RERUN, accepted],
		]);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("stayed at attempt 1");
	});

	it("reports an unreadable run list as UNKNOWN", async () => {
		const assertion = await assert([[RUNS, errOut("gh: Bad gateway (HTTP 502)")]]);
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
