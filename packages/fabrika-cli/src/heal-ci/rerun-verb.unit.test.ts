import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeHttp, fakeShell, type HttpReply, once} from "../fakes.test-support.ts";
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
	COMMENTS,
	CREATE_COMMENT,
	commentBody,
	comments,
	createdComment,
	ENV,
	HEAD,
	httpError,
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
	served: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runRerun({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fakeHttp(served).layer),
		),
	);

/** The whole happy path: failed run at attempt 1, no marker, a new attempt, a matching read-back. */
const happyShell = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull()],
	[COMMENTS, comments()],
	[CREATE_COMMENT, createdComment(5155001122)],
	[READ_COMMENT, commentBody(MARKER)],
];

const happyHttp = (): ReadonlyArray<readonly [RegExp, HttpReply]> => [
	[once(RUN), workflowRun({attempt: 1})],
	[RERUN, accepted],
	[RUN, workflowRun({attempt: 2})],
];

describe("runRerun spends the one rerun and records it", () => {
	it("prints the attempt READ BACK, never the one the caller held", async () => {
		const out = await run(happyShell(), happyHttp());
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
		const out = await run([[PULL, pull()]], [[RUN, workflowRun({conclusion: "success"})]]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("refusing to rerun a run that did not fail");
	});

	it("refuses a head already rerun by run_attempt on 14", async () => {
		const out = await run([[PULL, pull()]], [[RUN, workflowRun({attempt: 2})]]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("a second rerun is escalation, not retry");
	});

	it("refuses a head already rerun by a bound marker on 14 — the other independent signal", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[COMMENTS, comments({id: 91, body: MARKER})],
			],
			[[RUN, workflowRun({attempt: 1})]],
		);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stderr.at(-1)).toContain("marker 91");
	});

	it("refuses a closed PR on 14", async () => {
		const out = await run([[PULL, pull({state: "closed"})]]);
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
	});

	it("refuses a truncated marker read on 13 — an unexhausted read licenses no rerun", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 40})],
				[COMMENTS, comments()],
			],
			[[RUN, workflowRun({attempt: 1})]],
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses an off-vocabulary --signature on 10 before any read", async () => {
		const out = await run([], [], {signature: "flaky"});
		expect(out.code).toBe(OFF_VOCABULARY);
	});

	it("refuses a run proven absent on 7", async () => {
		const out = await run([[PULL, pull()]], [[RUN, httpError(404, "Not Found")]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});

describe("the marker is written only once a new attempt is confirmed", () => {
	it("refuses a 2xx that materialised no new attempt on 8, writing NO marker", async () => {
		const shell = fakeShell([
			[PULL, pull()],
			[COMMENTS, comments()],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runRerun(options),
				Layer.merge(
					shell.layer,
					fakeHttp([
						[RUN, workflowRun({attempt: 1})],
						[RERUN, accepted],
					]).layer,
				),
			),
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("no marker written");
		expect(shell.calls.some((call) => call.includes("issues/4321/comments -f"))).toBe(false);
	});

	it("refuses a failed rerun request on 8 with nothing written", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[COMMENTS, comments()],
			],
			[
				[RUN, workflowRun({attempt: 1})],
				[RERUN, httpError(502, "Bad gateway")],
			],
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("no new attempt, no marker written");
	});

	it("reports a landed rerun whose marker could not be written on 16, not on 8", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[COMMENTS, comments()],
				[CREATE_COMMENT, errOut("gh: Bad gateway (HTTP 502)")],
			],
			happyHttp(),
		);
		expect(out.code).toBe(RERUN_UNRECORDED);
		expect(out.stderr.at(-1)).toContain("rerun and UNRECORDED");
	});

	it("reports a marker whose read-back does not match on 9", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[COMMENTS, comments()],
				[CREATE_COMMENT, createdComment(77)],
				[READ_COMMENT, commentBody("something else entirely")],
			],
			happyHttp(),
		);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("the rerun is real, the record is not");
	});
});
