import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, once, type Scripted} from "../fakes.test-support.ts";
import {
	accepted,
	checkRuns,
	HEAD_CHECK_RUNS,
	httpError,
	RERUN_ALL as RERUN,
	RUN,
	runsAtHead,
	workflowRun,
} from "../heal-ci/fixtures.test-support.ts";
import {CHECK_RUN_NAME} from "../ship/floor-check.ts";
import {HEAD} from "./fixtures.test-support.ts";
import {assertFloorAt, floorLine, floorToken, needsRefire} from "./floor-assert.ts";

/** The paged envelope read at the head — `&per_page=100&page=1` follows, so no `$` anchor. */
const RUNS = /^GET .*\/repos\/o\/r\/actions\/runs\?head_sha=/;

/** The repository's workflow inventory, paged like the run list. */
const WORKFLOWS = /^GET .*\/repos\/o\/r\/actions\/workflows\?/;

/** An inventory of the named workflows, active unless listed in `disabled`. */
const inventory = (
	names: ReadonlyArray<string>,
	over: {declared?: number; disabled?: ReadonlyArray<string>} = {},
): ReadonlyArray<Scripted> => [
	[
		WORKFLOWS,
		{
			status: 200,
			body: JSON.stringify({
				total_count: over.declared ?? names.length,
				workflows: names.map((name, id) => ({
					id,
					name,
					path: `.github/workflows/${name}.yml`,
					state: over.disabled?.includes(name) ? "disabled_manually" : "active",
				})),
			}),
		},
	],
];

/** A repository that carries the floor workflow, beside CI. */
const withFloor = inventory(["ci", "governance-floor"]);

/** The floor's own check-run at the head, in whichever state the case is about. */
const floorCheck = (
	over: {status?: string; conclusion?: string | null} = {},
): ReadonlyArray<Scripted> => [
	[
		HEAD_CHECK_RUNS,
		{
			status: 200,
			body: checkRuns(1, [
				{
					name: CHECK_RUN_NAME,
					status: over.status ?? "completed",
					conclusion: over.conclusion === undefined ? "failure" : over.conclusion,
				},
			]).stdout,
		},
	],
];

/** A head carrying no check-run of the floor's name at all — a run that predates `--publish-check`. */
const noFloorCheck: ReadonlyArray<Scripted> = [
	[
		HEAD_CHECK_RUNS,
		{
			status: 200,
			body: checkRuns(1, [{name: "ci", status: "completed", conclusion: "success"}]).stdout,
		},
	],
];

/**
 * Whether one recorded request WROTE a check-run — the fence this module must never trip.
 *
 * Every method that is not a GET counts. `ship floor --publish-check` creates with POST and rewrites
 * with PATCH, so a POST-shaped fence would let a PATCH-shaped fabricated conclusion straight
 * through.
 */
const writesCheckRun = (call: string): boolean =>
	call.includes("check-runs") && !call.startsWith("GET ");

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
			...floorCheck(),
			...listed({id: 1, name: "ci"}, {id: FLOOR, name: "governance-floor"}),
		]);
		expect(assertion).toEqual({_tag: "Refired", run: FLOOR, attempt: 2});
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(true);
		// The re-fire re-runs `ship floor` in CI. Nothing here WRITES a check-run — the read above is
		// how this module learns the floor's state, and the green a PR ends up with is one the job
		// derived for itself. The fence is every method that is not a GET, not `POST` alone:
		// `ship floor --publish-check` rewrites a held row with `PATCH /check-runs/{id}`, so a
		// method-specific fence would let the PATCH-shaped fabrication through.
		expect(seams.requests.some(writesCheckRun)).toBe(false);
	});

	it("picks the NEWEST floor run at the head, not the first one listed", async () => {
		const {seams} = await withCalls([
			[once(RUN), workflowRun({id: 900, attempt: 1})],
			[RERUN, accepted],
			[RUN, workflowRun({id: 900, attempt: 2})],
			...floorCheck(),
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

	it("re-fires nothing when the check-run at this head already reads green", async () => {
		const {assertion, seams} = await withCalls([
			...floorCheck({conclusion: "success"}),
			...listed({id: FLOOR, name: "governance-floor", conclusion: "success"}),
		]);
		expect(assertion).toEqual({_tag: "Green", run: FLOOR});
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(false);
	});

	// The job succeeds whenever it PUBLISHED an answer, so its green says nothing about the floor.
	// A pending check-run beside a green job is the ordinary "no verdict yet" state, and it is
	// exactly the state this module exists to clear.
	it("re-fires a green job whose check-run is still pending", async () => {
		const {assertion, seams} = await withCalls([
			...red(),
			...floorCheck({status: "in_progress", conclusion: null}),
			...listed({id: FLOOR, name: "governance-floor", conclusion: "success"}),
		]);
		expect(assertion).toEqual({_tag: "Refired", run: FLOOR, attempt: 2});
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(true);
	});

	it("falls back to the job's conclusion when the head carries no floor check-run", async () => {
		const {assertion, seams} = await withCalls([
			...noFloorCheck,
			...listed({id: FLOOR, name: "governance-floor", conclusion: "success"}),
		]);
		expect(assertion).toEqual({_tag: "Green", run: FLOOR});
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(false);
	});

	// GitHub bumps `run_attempt` a beat after it accepts the dispatch, and calling that beat UNKNOWN
	// sent three agents to `heal-ci` over re-fires that had taken and went green untouched.
	it("reads a same-id run that is running again as a re-fire to wait on, not UNKNOWN", async () => {
		const {assertion, seams} = await withCalls([
			[once(RUN), workflowRun({id: FLOOR, attempt: 1})],
			[RERUN, accepted],
			[RUN, workflowRun({id: FLOOR, attempt: 1, status: "in_progress", conclusion: null})],
			...floorCheck(),
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
			...floorCheck(),
			...listed({id: FLOOR, name: "governance-floor"}),
		]);
		expect(assertion).toEqual({_tag: "Restarting", run: FLOOR, status: "queued"});
	});

	it("answers NoRun carrying how many runs the head did list", async () => {
		expect(
			await assert([...withFloor, ...listed({id: 1, name: "ci"}, {id: 2, name: "leak-guard"})]),
		).toEqual({
			_tag: "NoRun",
			runsAtHead: 2,
		});
	});

	it("answers NoRun carrying zero when the head lists no run of any name", async () => {
		expect(
			await assert([...withFloor, [RUNS, {status: 200, body: runsAtHead(0, []).stdout}]]),
		).toEqual({
			_tag: "NoRun",
			runsAtHead: 0,
		});
	});

	it("answers NoFloor when the repository carries no governance-floor workflow", async () => {
		const {assertion, seams} = await withCalls([
			...inventory(["ci", "leak-guard"]),
			...listed({id: 1, name: "ci"}, {id: 2, name: "leak-guard"}),
		]);
		expect(assertion).toEqual({_tag: "NoFloor"});
		expect(seams.requests.some((call) => RERUN.test(call))).toBe(false);
	});

	it("answers NoFloor when the governance-floor workflow is disabled", async () => {
		expect(
			await assert([
				...inventory(["ci", "governance-floor"], {disabled: ["governance-floor"]}),
				...listed({id: 1, name: "ci"}),
			]),
		).toEqual({_tag: "NoFloor"});
	});

	it("reads no inventory when the floor run is at the head", async () => {
		const {seams} = await withCalls([
			...floorCheck({conclusion: "success"}),
			...listed({id: FLOOR, name: "governance-floor", conclusion: "success"}),
		]);
		expect(seams.requests.some((call) => WORKFLOWS.test(call))).toBe(false);
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
			...floorCheck(),
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
			...floorCheck(),
			...listed({id: FLOOR, name: "governance-floor"}),
		]);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("stayed at attempt 1");
	});

	// Absence is concluded only from a complete inventory: a failed or short read says nothing about
	// whether the floor workflow exists.
	it("reports an unreadable workflow inventory as UNKNOWN, never as NoFloor", async () => {
		const assertion = await assert([
			[WORKFLOWS, {status: 502, body: "{}"}],
			...listed({id: 1, name: "ci"}),
		]);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("workflows of o/r");
		expect(floorToken(assertion)).toBe("unknown");
	});

	it("refuses to read NoFloor out of a truncated workflow inventory", async () => {
		const assertion = await assert([
			...inventory(["ci"], {declared: 40}),
			...listed({id: 1, name: "ci"}),
		]);
		expect(assertion._tag).toBe("Unknown");
		expect(assertion._tag === "Unknown" && assertion.reason).toContain("of 40 declared workflows");
	});

	it("reports an unreadable run list as UNKNOWN", async () => {
		const assertion = await assert([[RUNS, {status: 502, body: "{}"}]]);
		expect(assertion._tag).toBe("Unknown");
	});

	it("reports an unreadable check-run list as UNKNOWN rather than as a green", async () => {
		const assertion = await assert([
			[HEAD_CHECK_RUNS, {status: 502, body: "{}"}],
			...listed({id: FLOOR, name: "governance-floor", conclusion: "success"}),
		]);
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

	// The head this ticket was filed from listed 31 runs while its floor run existed, so any line
	// concluding a cause over a run-carrying head is false there. The count narrows the read; it
	// never explains it.
	it("states the empty filter over a head that carries runs, and concludes no cause", () => {
		const line = floorLine("governance post", {_tag: "NoRun", runsAtHead: 30});
		expect(line).toContain("30 run(s)");
		expect(line).toContain("unproven");
		expect(line).toContain("re-read");
		expect(line).not.toContain("did not fire");
		expect(line).not.toContain("not installed");
		expect(floorToken({_tag: "NoRun", runsAtHead: 30})).toBe("no-run");
	});

	it("states a repository without the floor workflow as a plain fact, with nothing to re-read", () => {
		const line = floorLine("governance post", {_tag: "NoFloor"});
		expect(line).toContain("runs no governance floor");
		expect(line).toContain("nothing to re-fire");
		expect(line).not.toContain("re-read");
		expect(line).not.toContain("unproven");
		expect(floorToken({_tag: "NoFloor"})).toBe("no-floor");
	});

	it("calls an empty run list unproven rather than an absent floor", () => {
		const line = floorLine("governance post", {_tag: "NoRun", runsAtHead: 0});
		expect(line).toContain("no workflow run at all");
		expect(line).toContain("unproven");
		expect(line).not.toContain("not installed");
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

describe("needsRefire reads the check-run, and the job only where there is none", () => {
	const check = (status: string, conclusion: string | null) => ({
		name: CHECK_RUN_NAME,
		status,
		conclusion,
		startedAt: null,
		id: 1,
		checkSuiteId: 1,
	});

	it("holds a pending check-run to be re-fireable however the job concluded", () => {
		expect(needsRefire("success", check("in_progress", null))).toBe(true);
		expect(needsRefire("failure", check("in_progress", null))).toBe(true);
	});

	it("clears only on a completed, successful check-run", () => {
		expect(needsRefire("success", check("completed", "success"))).toBe(false);
		expect(needsRefire("success", check("completed", "failure"))).toBe(true);
	});

	it("reads the job's conclusion when the head carries no check-run", () => {
		expect(needsRefire("success", null)).toBe(false);
		expect(needsRefire("failure", null)).toBe(true);
		expect(needsRefire(null, null)).toBe(false);
	});
});

describe("the check-run fence these cases assert on", () => {
	it("catches every write method and lets the read through", () => {
		expect(writesCheckRun("POST https://api.github.com/repos/o/r/check-runs")).toBe(true);
		expect(writesCheckRun("PATCH https://api.github.com/repos/o/r/check-runs/55")).toBe(true);
		expect(writesCheckRun("DELETE https://api.github.com/repos/o/r/check-runs/55")).toBe(true);
		expect(
			writesCheckRun("GET https://api.github.com/repos/o/r/commits/abc/check-runs?per_page=100"),
		).toBe(false);
	});
});
