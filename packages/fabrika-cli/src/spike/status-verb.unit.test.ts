import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type FakeFsOptions, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {captureMarker} from "./bodies.ts";
import {MALFORMED_RECORD, OFF_VOCABULARY, READ_OR_EXEC_UNKNOWN} from "./codes.ts";
import {
	COMMENTS,
	commentsPayload,
	ENV,
	EVIDENCE,
	ISSUE,
	issuePayload,
	MANIFEST,
	manifestText,
	NONCE,
	ONE_RUN,
	ONE_RUN_DIGEST,
	QUESTION,
	SPIKE,
	STATUS,
	TMP_ROOT,
	WORKSPACE,
} from "./fixtures.test-support.ts";
import {runStatus} from "./status-verb.ts";

const resident: FakeFsOptions = {
	directories: [WORKSPACE],
	files: {[MANIFEST]: manifestText(), [EVIDENCE]: ONE_RUN},
};

const options = {nonce: NONCE, repo: null as string | null, env: ENV, tmpRoot: TMP_ROOT};

const happy: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[STATUS, okOut("")],
	[ISSUE, okOut(issuePayload())],
	[COMMENTS, okOut(commentsPayload([]))],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
	fs: FakeFsOptions = resident,
) =>
	Effect.runPromise(
		Effect.provide(
			runStatus({...options, ...overrides}),
			Layer.merge(fakeFs(fs).layer, fakeShell(script).layer),
		),
	);

describe("runStatus reports per-field state inside exit 0", () => {
	it("answers the whole state of a live run", async () => {
		const outcome = await run(happy);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			nonce: NONCE,
			workspace: "present",
			spike: SPIKE,
			kind: "logic",
			question: QUESTION,
			spikeState: "open",
			captured: false,
			runs: 1,
			lastCommandExit: 0,
			evidenceDigest: ONE_RUN_DIGEST,
			treeMatched: true,
		});
	});

	it("reports an absent workspace as a FACT, every derived field null", async () => {
		const outcome = await run([], {}, {});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			nonce: NONCE,
			workspace: "absent",
			spike: null,
			kind: null,
			question: null,
			spikeState: null,
			captured: false,
			runs: null,
			lastCommandExit: null,
			evidenceDigest: null,
			treeMatched: null,
		});
	});

	it("distinguishes a log that was never written from one that hashes empty", async () => {
		const outcome = await run(
			happy,
			{},
			{directories: [WORKSPACE], files: {[MANIFEST]: manifestText()}},
		);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			runs: 0,
			lastCommandExit: null,
			evidenceDigest: null,
		});
	});

	it("reports a captured spike", async () => {
		const outcome = await run([
			[STATUS, okOut("")],
			[ISSUE, okOut(issuePayload({state: "closed"}))],
			[COMMENTS, okOut(commentsPayload([{id: 1, body: captureMarker(NONCE, ONE_RUN_DIGEST)}]))],
		]);
		expect(JSON.parse(outcome.stdout)).toMatchObject({spikeState: "closed", captured: true});
	});

	it("reports treeMatched as information, never as a verdict", async () => {
		const outcome = await run([
			[STATUS, okOut("?? probe.ts\n")],
			[ISSUE, okOut(issuePayload())],
			[COMMENTS, okOut(commentsPayload([]))],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).treeMatched).toBe(false);
	});

	it("reads no spike state at all from a provisional manifest", async () => {
		const outcome = await run(
			[[STATUS, okOut("")]],
			{},
			{
				directories: [WORKSPACE],
				files: {[MANIFEST]: manifestText({spike: null}), [EVIDENCE]: ONE_RUN},
			},
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({spike: null, spikeState: null});
	});
});

describe("the near-totality is bounded by ADR 0092", () => {
	it("refuses a manifest that does not parse on 4 — that is not `absent`", async () => {
		const outcome = await run(happy, {}, {directories: [WORKSPACE], files: {[MANIFEST]: "{}\n"}});
		expect(outcome.code).toBe(MALFORMED_RECORD);
		expect(outcome.stdout).toBe("");
	});

	it("refuses a log that does not parse on 4", async () => {
		const outcome = await run(
			happy,
			{},
			{...resident, files: {...resident.files, [EVIDENCE]: "nope\n"}},
		);
		expect(outcome.code).toBe(MALFORMED_RECORD);
	});

	it("refuses an unreadable spike state on 11 rather than reporting a default", async () => {
		const outcome = await run([
			[STATUS, okOut("")],
			[ISSUE, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(READ_OR_EXEC_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});

	it("refuses an unreadable tree on 11", async () => {
		const outcome = await run([[STATUS, errOut("fatal: not a git repository")]]);
		expect(outcome.code).toBe(READ_OR_EXEC_UNKNOWN);
	});

	it("refuses an off-grammar nonce on 10", async () => {
		const outcome = await run(happy, {nonce: "run-1"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});
});

describe("a proven-absent spike is reported, never fused with an unreadable one", () => {
	it("names it on stderr and leaves the state null at exit 0", async () => {
		const outcome = await run([
			[STATUS, okOut("")],
			[ISSUE, errOut("gh: Not Found (HTTP 404)")],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).spikeState).toBeNull();
		expect(outcome.stderr.join("\n")).toContain("proven absent");
	});
});
