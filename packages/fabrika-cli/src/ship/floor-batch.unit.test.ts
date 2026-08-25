/**
 * The batch verb's whole job is to put ONE named row on a ref, so the battery pins the two things a
 * frozen merge queue would turn on: the row carries the name a branch protection matches, and no
 * request to any pull-request surface is made on the way — a batch ref has none to read (#6968).
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted, unconfigured} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {checkRuns, ENV, HEAD} from "./fixtures.test-support.ts";
import {BATCH_PLAN, runFloorBatch} from "./floor-batch.ts";
import {CHECK_RUN_NAME} from "./floor-check.ts";

const HEAD_CHECKS = /^GET \S+\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs\?/;
const CREATE = /^POST \S+\/repos\/o\/r\/check-runs$/;
const UPDATE = /^PATCH \S+\/repos\/o\/r\/check-runs\/\d+$/;

const echoed = (status: string, conclusion: string | null, id = 77): HttpReply => ({
	status: 201,
	body: JSON.stringify({id, name: CHECK_RUN_NAME, status, conclusion}),
});

const NO_HELD_CHECK: Scripted = [
	HEAD_CHECKS,
	{
		status: 200,
		body: checkRuns(1, [{name: "ci", status: "completed", conclusion: "success"}]).stdout,
	},
];

const options = {sha: HEAD, repo: null, json: false, env: ENV};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const seams = fakeSeams([...script]);
	return Effect.runPromise(
		Effect.provide(
			runFloorBatch({...options, ...overrides}),
			Layer.merge(seams.layer, unconfigured),
		),
	).then((outcome) => ({outcome, seams}));
};

const written = (seams: {
	readonly requests: ReadonlyArray<string>;
	readonly bodies: ReadonlyArray<string>;
}) => {
	const at = seams.requests.findIndex((call) => CREATE.test(call) || UPDATE.test(call));
	return at === -1 ? null : JSON.parse(seams.bodies[at] ?? "{}");
};

describe("runFloorBatch publishes the required context and reads nothing about a PR", () => {
	it("posts the floor's own check-run name, concluded success, at the batch head", async () => {
		const {outcome, seams} = await run([NO_HELD_CHECK, [CREATE, echoed("completed", "success")]]);
		expect(outcome.code).toBe(0);
		expect(written(seams)).toMatchObject({
			name: CHECK_RUN_NAME,
			head_sha: HEAD,
			status: "completed",
			conclusion: "success",
		});
		expect(outcome.stdout).toContain(`floor\tbatch\t${HEAD}`);
	});

	// The freeze this verb exists to prevent came from a job asking `ship floor` about a PR that is
	// not there. Reading the PR, its files, its comments or its reviews here would be that same bug
	// with a different spelling, so the absence is asserted rather than assumed.
	it("touches no pull-request surface — a batch ref has none", async () => {
		const {seams} = await run([NO_HELD_CHECK, [CREATE, echoed("completed", "success")]]);
		expect(seams.requests.filter((call) => /\/pulls\/|\/issues\//.test(call))).toEqual([]);
	});

	it("rewrites the row this head already carries instead of posting a second one", async () => {
		const {outcome, seams} = await run([
			[
				HEAD_CHECKS,
				{
					status: 200,
					body: checkRuns(1, [
						{name: CHECK_RUN_NAME, status: "completed", conclusion: "success", id: 12},
					]).stdout,
				},
			],
			[UPDATE, echoed("completed", "success", 12)],
		]);
		expect(outcome.code).toBe(0);
		expect(seams.requests.some((call) => CREATE.test(call))).toBe(false);
	});

	it("refuses without publishing when the head's check-runs cannot be enumerated", async () => {
		const {outcome, seams} = await run([[HEAD_CHECKS, {status: 500, body: "boom"}]]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(written(seams)).toBeNull();
	});

	it("refuses when the write fails", async () => {
		const {outcome} = await run([NO_HELD_CHECK, [CREATE, {status: 500, body: "boom"}]]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
	});

	it("refuses when GitHub echoes a state this run did not decide", async () => {
		const {outcome} = await run([NO_HELD_CHECK, [CREATE, echoed("completed", "failure")]]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("refuses a malformed --sha rather than matching every head", async () => {
		const {outcome, seams} = await run([], {sha: ""});
		expect(outcome.code).toBe(1);
		expect(seams.requests).toEqual([]);
	});
});

describe("BATCH_PLAN says what it is and what it is not", () => {
	it("concludes success and names itself batch, never a discharged verdict", () => {
		expect(BATCH_PLAN).toMatchObject({_tag: "Concluded", conclusion: "success", floor: "batch"});
		expect(BATCH_PLAN.summary).toContain("discharges nothing");
	});
});
