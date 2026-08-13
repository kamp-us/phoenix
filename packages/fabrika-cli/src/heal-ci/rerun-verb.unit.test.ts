import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, once} from "../fakes.test-support.ts";
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
	COMMENTS,
	CREATE_COMMENT,
	commentBody,
	comments,
	createdComment,
	ENV,
	HEAD,
	OTHER_HEAD,
	PULL,
	pull,
	READ_COMMENT,
	RERUN,
	RUN,
	workflowRun,
} from "./fixtures.test-support.ts";
import {renderMarker} from "./marker.ts";
import {runRerun} from "./rerun-verb.ts";

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

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runRerun({...options, ...overrides}), fakeShell(script).layer));

/** The whole happy path: failed run at attempt 1, no marker, a new attempt, a matching read-back. */
const happy = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull()],
	[once(RUN), workflowRun({attempt: 1})],
	[COMMENTS, comments()],
	[RERUN, createdComment(0)],
	[RUN, workflowRun({attempt: 2})],
	[CREATE_COMMENT, createdComment(5155001122)],
	[READ_COMMENT, commentBody(MARKER)],
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
		const out = await run([[PULL, pull({head: OTHER_HEAD})]]);
		expect(out.code).toBe(STALE_HEAD);
		expect(out.stderr.at(-1)).toContain("refusing to rerun against a tree nobody classified");
	});

	it("refuses a run that did not fail on 14 — nothing was mutated", async () => {
		const out = await run([
			[PULL, pull()],
			[RUN, workflowRun({conclusion: "success"})],
		]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("refusing to rerun a run that did not fail");
	});

	it("refuses a head already rerun by run_attempt on 14", async () => {
		const out = await run([
			[PULL, pull()],
			[RUN, workflowRun({attempt: 2})],
		]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("a second rerun is escalation, not retry");
	});

	it("refuses a head already rerun by a bound marker on 14 — the other independent signal", async () => {
		const out = await run([
			[PULL, pull({comments: 1})],
			[RUN, workflowRun({attempt: 1})],
			[COMMENTS, comments({id: 91, body: MARKER})],
		]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("marker 91");
	});

	it("refuses a closed PR on 14", async () => {
		const out = await run([[PULL, pull({state: "closed"})]]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
	});

	it("refuses a truncated marker read on 13 — an unexhausted read licenses no rerun", async () => {
		const out = await run([
			[PULL, pull({comments: 40})],
			[RUN, workflowRun({attempt: 1})],
			[COMMENTS, comments()],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses an off-vocabulary --signature on 10 before any read", async () => {
		const out = await run([], {signature: "flaky"});
		expect(out.code).toBe(OFF_VOCABULARY);
	});

	it("refuses a run proven absent on 7", async () => {
		const out = await run([
			[PULL, pull()],
			[RUN, errOut("gh: Not Found (HTTP 404)")],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});

describe("the marker is written only once a new attempt is confirmed", () => {
	it("refuses a 2xx that materialised no new attempt on 8, writing NO marker", async () => {
		const shell = fakeShell([
			[PULL, pull()],
			[RUN, workflowRun({attempt: 1})],
			[COMMENTS, comments()],
			[RERUN, createdComment(0)],
		]);
		const out = await Effect.runPromise(Effect.provide(runRerun(options), shell.layer));
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("no marker written");
		expect(shell.calls.some((call) => call.includes("issues/4321/comments -f"))).toBe(false);
	});

	it("refuses a failed rerun request on 8 with nothing written", async () => {
		const out = await run([
			[PULL, pull()],
			[RUN, workflowRun({attempt: 1})],
			[COMMENTS, comments()],
			[RERUN, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("no new attempt, no marker written");
	});

	it("reports a landed rerun whose marker could not be written on 16, not on 8", async () => {
		const out = await run([
			[PULL, pull()],
			[once(RUN), workflowRun({attempt: 1})],
			[COMMENTS, comments()],
			[RERUN, createdComment(0)],
			[RUN, workflowRun({attempt: 2})],
			[CREATE_COMMENT, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(RERUN_UNRECORDED);
		expect(out.stderr.at(-1)).toContain("rerun and UNRECORDED");
	});

	it("reports a marker whose read-back does not match on 9", async () => {
		const out = await run([
			[PULL, pull()],
			[once(RUN), workflowRun({attempt: 1})],
			[COMMENTS, comments()],
			[RERUN, createdComment(0)],
			[RUN, workflowRun({attempt: 2})],
			[CREATE_COMMENT, createdComment(77)],
			[READ_COMMENT, commentBody("something else entirely")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("the rerun is real, the record is not");
	});
});
