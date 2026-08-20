import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {comments, ENV, HEAD, OTHER_HEAD, pull} from "../ship/fixtures.test-support.ts";
import {
	NOTHING_TO_RERUN,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	RERUN_UNKNOWN,
	TARGET_ABSENT,
	VERDICT_ABSENT,
	VERDICT_FAIL,
	VERDICT_STALE,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {governanceMarker, httpError, oneRun, runsAtHead} from "./fixtures.test-support.ts";
import {runRerun} from "./rerun-verb.ts";

const API = "https:\\/\\/api\\.github\\.com";
const PULL = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/pulls\\/4321$`);
const COMMENTS = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/issues\\/4321\\/comments\\?`);
const RUNS = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/actions\\/runs\\?head_sha=`);
const RERUN = new RegExp(`^POST ${API}\\/repos\\/o\\/r\\/actions\\/runs\\/77\\/rerun$`);
const ONE_RUN = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/actions\\/runs\\/77$`);

/** The rerun endpoint answers 201 with no body. */
const ACCEPTED: HttpReply = {status: 201, body: ""};

/** The shared payload fixtures speak `gh`'s `ExecResult`; the seam now serves the same bytes. */
const reply = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(
		Effect.provide(runRerun({pr: 4321, repo: null, env: ENV}), fakeSeams(script).layer),
	);

const PASSING = reply(comments({id: 1, body: governanceMarker("PASS", HEAD)}));

describe("recipe rerun — the gate is read before anything moves", () => {
	it("reruns the failed run and proves it by the run's own new attempt", async () => {
		const seams = fakeSeams([
			[PULL, reply(pull())],
			[COMMENTS, PASSING],
			[RUNS, runsAtHead({id: 77, name: "ci"}, {id: 78, conclusion: "success"})],
			[RERUN, ACCEPTED],
			[ONE_RUN, oneRun({id: 77, attempt: 2, status: "queued", conclusion: null})],
		]);

		const out = await Effect.runPromise(
			Effect.provide(runRerun({pr: 4321, repo: null, env: ENV}), seams.layer),
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			pr: 4321,
			head: HEAD,
			verdict: "PASS",
			rerun: [{id: 77, name: "ci", attempt: 2}],
		});
		// The read-back is a real second call, not the POST's own status re-read as evidence.
		expect(seams.requests.filter((line) => ONE_RUN.test(line))).toHaveLength(1);
	});

	it("is VERDICT_ABSENT with nothing posted when the PR carries no governance verdict", async () => {
		const seams = fakeSeams([
			[PULL, reply(pull())],
			[COMMENTS, reply(comments({id: 1, body: `review-code: PASS @ ${HEAD} — ok`}))],
		]);

		const out = await Effect.runPromise(
			Effect.provide(runRerun({pr: 4321, repo: null, env: ENV}), seams.layer),
		);

		expect(out.code).toBe(VERDICT_ABSENT);
		expect(seams.requests.some((line) => line.startsWith("POST "))).toBe(false);
	});

	it("is VERDICT_STALE when the verdict is bound to another head — never folded into absent", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[COMMENTS, reply(comments({id: 1, body: governanceMarker("PASS", OTHER_HEAD)}))],
		]);

		expect(out.code).toBe(VERDICT_STALE);
		expect(out.code).not.toBe(VERDICT_ABSENT);
	});

	it("is VERDICT_FAIL on a FAIL at head, and reruns nothing", async () => {
		const seams = fakeSeams([
			[PULL, reply(pull())],
			[COMMENTS, reply(comments({id: 1, body: governanceMarker("FAIL", HEAD)}))],
		]);

		const out = await Effect.runPromise(
			Effect.provide(runRerun({pr: 4321, repo: null, env: ENV}), seams.layer),
		);

		expect(out.code).toBe(VERDICT_FAIL);
		expect(seams.requests.some((line) => line.startsWith("POST "))).toBe(false);
	});

	it("takes the latest verdict by write stamp, so a FAIL upserted into an older comment wins", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[
				COMMENTS,
				reply(
					comments(
						{id: 1, body: governanceMarker("FAIL", HEAD), updatedAt: "2026-08-16T02:00:00Z"},
						{id: 2, body: governanceMarker("PASS", HEAD), updatedAt: "2026-08-16T01:00:00Z"},
					),
				),
			],
		]);

		expect(out.code).toBe(VERDICT_FAIL);
	});

	it("is TARGET_ABSENT on a closed PR", async () => {
		expect((await run([[PULL, reply(pull({state: "closed"}))]])).code).toBe(TARGET_ABSENT);
	});

	it('is UNKNOWN when the comments cannot be read — never "no verdict"', async () => {
		const out = await run([
			[PULL, reply(pull())],
			[COMMENTS, httpError(503, "api down")],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.code).not.toBe(VERDICT_ABSENT);
	});
});

describe("recipe rerun — nothing to do, and writes that do not prove themselves", () => {
	const gated: ReadonlyArray<Scripted> = [
		[PULL, reply(pull())],
		[COMMENTS, PASSING],
	];

	it("is NOTHING_TO_RERUN when no run at the head concluded in failure", async () => {
		const out = await run([...gated, [RUNS, runsAtHead({id: 78, conclusion: "success"})]]);

		expect(out.code).toBe(NOTHING_TO_RERUN);
	});

	it('is UNKNOWN when the run list cannot be read — never "nothing to rerun"', async () => {
		const out = await run([...gated, [RUNS, httpError(503, "api down")]]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.code).not.toBe(NOTHING_TO_RERUN);
	});

	// A walk that read fewer runs than the endpoint declared is a short list, and answering over it
	// would seat "nothing to rerun" on a page nobody read — the `--paginate` era's truncation refusal,
	// re-derived against the platform's own count.
	it("is UNKNOWN when fewer runs arrived than the endpoint declared", async () => {
		const short = runsAtHead({id: 77});
		const out = await run([
			...gated,
			[RUNS, {...short, body: JSON.stringify({...JSON.parse(short.body), total_count: 4})}],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("is WRITE_UNKNOWN when the rerun request itself does not land", async () => {
		const out = await run([
			...gated,
			[RUNS, runsAtHead({id: 77})],
			[RERUN, httpError(422, "Unprocessable")],
		]);

		expect(out.code).toBe(WRITE_UNKNOWN);
	});

	it("is RERUN_UNKNOWN when the request landed and the run cannot be re-read", async () => {
		const out = await run([
			...gated,
			[RUNS, runsAtHead({id: 77})],
			[RERUN, ACCEPTED],
			[ONE_RUN, httpError(503, "api down")],
		]);

		expect(out.code).toBe(RERUN_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("is READBACK_MISMATCH when the re-read shows the same attempt on a completed run", async () => {
		const out = await run([
			...gated,
			[once(RUNS), runsAtHead({id: 77, attempt: 3})],
			[RERUN, ACCEPTED],
			[ONE_RUN, oneRun({id: 77, attempt: 3, status: "completed"})],
		]);

		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
	});

	it("accepts a run still on its old attempt once it has left `completed`", async () => {
		const out = await run([
			...gated,
			[RUNS, runsAtHead({id: 77, attempt: 3})],
			[RERUN, ACCEPTED],
			[ONE_RUN, oneRun({id: 77, attempt: 3, status: "in_progress", conclusion: null})],
		]);

		expect(out.code).toBe(0);
	});
});
