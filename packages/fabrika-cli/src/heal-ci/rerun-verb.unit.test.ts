import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	INCOMPLETE_SCAN,
	OFF_VOCABULARY,
	PROVEN_NOT_IN_STATE,
	READBACK_MISMATCH,
	RERUN_UNRECORDED,
	STALE_HEAD,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	accepted,
	commentBody,
	comments,
	createdComment,
	ENV,
	HEAD,
	httpError,
	OTHER_HEAD,
	pull,
	RERUN,
	RUN,
	workflowRun,
} from "./fixtures.test-support.ts";
import {renderMarker} from "./marker.ts";
import {runRerun} from "./rerun-verb.ts";

const PULL = /^GET .*\/repos\/o\/r\/pulls\/4321$/;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/4321\/comments\?/;
const CREATE_COMMENT = /^POST .*\/repos\/o\/r\/issues\/\d+\/comments$/;
const READ_COMMENT = /^GET .*\/repos\/o\/r\/issues\/comments\/\d+$/;

/** The shared payload fixtures speak `gh`'s `ExecResult`; the seam now serves the same bytes. */
const reply = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

const RUN_ID = 9182736450;
const MARKER = renderMarker({head: HEAD, run: RUN_ID, signature: "preview-warmup"});

const options = {
	pr: 4321,
	run: RUN_ID,
	sha: HEAD,
	signature: "preview-warmup",
	repo: null,
	json: false,
	env: ENV,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runRerun({...options, ...overrides}), fakeSeams(script).layer));

/** The whole happy path: failed run at attempt 1, no marker, a new attempt, a matching read-back. */
const happy = (): ReadonlyArray<Scripted> => [
	[PULL, reply(pull())],
	[COMMENTS, reply(comments())],
	[CREATE_COMMENT, reply(createdComment(5155001122), 201)],
	[READ_COMMENT, reply(commentBody(MARKER))],
	[once(RUN), workflowRun({attempt: 1})],
	[RERUN, accepted],
	[RUN, workflowRun({attempt: 2})],
];

describe("runRerun spends the one rerun and records it", () => {
	it("prints the attempt READ BACK, never the one the caller held", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			`rerun\t2\t${RUN_ID}\thttps://example.test/pull/4321#issuecomment-5155001122\n`,
		);
	});
});

describe("the guard lives in the verb, and trusts nothing it was told", () => {
	it("refuses a head that moved past --sha on 12", async () => {
		const out = await run([[PULL, reply(pull({head: OTHER_HEAD}))]]);
		expect(out.code).toBe(STALE_HEAD);
		expect(out.stderr.at(-1)).toContain("refusing to rerun against a tree nobody classified");
	});

	it("refuses a run that did not fail on 14 — nothing was mutated", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[RUN, workflowRun({conclusion: "success"})],
		]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("refusing to rerun a run that did not fail");
	});

	it("refuses a head already rerun by run_attempt on 14", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[RUN, workflowRun({attempt: 2})],
		]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("a second rerun is escalation, not retry");
	});

	it("refuses a head already rerun by a bound marker on 14 — the other independent signal", async () => {
		const out = await run([
			[PULL, reply(pull({comments: 1}))],
			[COMMENTS, reply(comments({id: 91, body: MARKER}))],
			[RUN, workflowRun({attempt: 1})],
		]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("marker 91");
	});

	it("refuses a closed PR on 14", async () => {
		const out = await run([[PULL, reply(pull({state: "closed"}))]]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
	});

	it("refuses a truncated marker read on 13 — an unexhausted read licenses no rerun", async () => {
		const out = await run([
			[PULL, reply(pull({comments: 40}))],
			[COMMENTS, reply(comments())],
			[RUN, workflowRun({attempt: 1})],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses an off-vocabulary --signature on 10 before any read", async () => {
		const out = await run([], {signature: "flaky"});
		expect(out.code).toBe(OFF_VOCABULARY);
	});

	it("refuses a run proven absent on 7", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[RUN, httpError(404, "Not Found")],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});

describe("the marker is written only once a new attempt is confirmed", () => {
	it("refuses a 2xx that materialised no new attempt on 8, writing NO marker", async () => {
		const seams = fakeSeams([
			[PULL, reply(pull())],
			[COMMENTS, reply(comments())],
			[RUN, workflowRun({attempt: 1})],
			[RERUN, accepted],
		]);
		const out = await Effect.runPromise(Effect.provide(runRerun(options), seams.layer));
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("no marker written");
		expect(seams.requests.filter((request) => CREATE_COMMENT.test(request))).toEqual([]);
	});

	it("refuses a failed rerun request on 8 with nothing written", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[COMMENTS, reply(comments())],
			[RUN, workflowRun({attempt: 1})],
			[RERUN, httpError(502, "Bad gateway")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("no new attempt, no marker written");
	});

	it("reports a landed rerun whose marker could not be written on 16, not on 8", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[COMMENTS, reply(comments())],
			[CREATE_COMMENT, httpError(502, "Bad gateway")],
			[once(RUN), workflowRun({attempt: 1})],
			[RERUN, accepted],
			[RUN, workflowRun({attempt: 2})],
		]);
		expect(out.code).toBe(RERUN_UNRECORDED);
		expect(out.stderr.at(-1)).toContain("rerun and UNRECORDED");
	});

	it("reports a marker whose read-back does not match on 9", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[COMMENTS, reply(comments())],
			[CREATE_COMMENT, reply(createdComment(77), 201)],
			[READ_COMMENT, reply(commentBody("something else entirely"))],
			[once(RUN), workflowRun({attempt: 1})],
			[RERUN, accepted],
			[RUN, workflowRun({attempt: 2})],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("the rerun is real, the record is not");
	});
});

/**
 * What the at-most-once guard does and does not cover when two callers reach it at once (#7209).
 *
 * The two heal-ci sweeps that collided in the incident overlapped by minutes, so the question is not
 * academic. The answer these tests record: the guard is **read-before-write per caller**, so it holds
 * absolutely once either of its two signals has landed, and does NOT hold across the window between
 * one caller's read and its own write. Nothing in the verb closes that window — GitHub offers no
 * conditional create — so it is recorded here rather than asserted away.
 */
describe("the at-most-once guard under two concurrent callers at one head", () => {
	/** Both signals still say un-rerun: the board each caller sees before either has written. */
	const beforeEitherWrote = (): ReadonlyArray<Scripted> => [
		[PULL, reply(pull())],
		[COMMENTS, reply(comments())],
		[CREATE_COMMENT, reply(createdComment(5155001122), 201)],
		[READ_COMMENT, reply(commentBody(MARKER))],
		[once(RUN), workflowRun({attempt: 1})],
		[RERUN, accepted],
		[RUN, workflowRun({attempt: 2})],
	];

	it("holds once the marker has landed, whichever caller wrote it", async () => {
		const seams = fakeSeams([
			[PULL, reply(pull({comments: 1}))],
			[COMMENTS, reply(comments({id: 42, body: MARKER}))],
			[RUN, workflowRun({attempt: 1})],
		]);
		const out = await Effect.runPromise(Effect.provide(runRerun(options), seams.layer));
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(seams.requests.some((request) => RERUN.test(request))).toBe(false);
	});

	it("holds once run_attempt has moved, even with no marker to read", async () => {
		const seams = fakeSeams([
			[PULL, reply(pull())],
			[COMMENTS, reply(comments())],
			[RUN, workflowRun({attempt: 2})],
		]);
		const out = await Effect.runPromise(Effect.provide(runRerun(options), seams.layer));
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(seams.requests.some((request) => RERUN.test(request))).toBe(false);
	});

	/**
	 * The open window, stated as a fact rather than a wish: a second caller whose reads all completed
	 * before the first caller's dispatch passes every arm of the guard and dispatches too. Closing it
	 * needs a claim seam this group does not have, so the skill's own serialization is what bounds it.
	 */
	it("does NOT hold when both callers read before either wrote — both dispatch", async () => {
		const first = fakeSeams(beforeEitherWrote());
		const second = fakeSeams(beforeEitherWrote());
		const [a, b] = await Promise.all([
			Effect.runPromise(Effect.provide(runRerun(options), first.layer)),
			Effect.runPromise(Effect.provide(runRerun(options), second.layer)),
		]);
		expect(a.code).toBe(0);
		expect(b.code).toBe(0);
		expect(first.requests.some((request) => RERUN.test(request))).toBe(true);
		expect(second.requests.some((request) => RERUN.test(request))).toBe(true);
	});
});
