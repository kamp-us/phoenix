import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type FakeFsOptions, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {captureComment, captureMarker, forfeitMarker, WORKSPACE_MASK} from "./bodies.ts";
import {runCapture} from "./capture-verb.ts";
import {
	AUTHOR_UNAUTHORIZED,
	EMPTY_STDIN,
	LEAKED_PATH,
	NO_EVIDENCE,
	NO_WORKSPACE,
	READ_OR_EXEC_UNKNOWN,
	READBACK_MISMATCH,
	WORKSPACE_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	CLOSE,
	COMMENTS,
	commentsPayload,
	ENV,
	EVIDENCE,
	evidenceRecord,
	evidenceText,
	ISSUE,
	issuePayload,
	LEAKY_EVIDENCE,
	LEAKY_MANIFEST,
	LEAKY_TMP_ROOT,
	LEAKY_WORKSPACE,
	MANIFEST,
	manifestText,
	NONCE,
	ONE_RUN,
	ONE_RUN_DIGEST,
	PERMISSION,
	POST,
	READBACK,
	SPIKE,
	TMP_ROOT,
	VIEWER,
	WORKSPACE,
} from "./fixtures.test-support.ts";
import {sha256OfText} from "./workspace.ts";

const DECISION = "A single-use token needs no new table — the verification record carries it.";
const BODY = captureComment({
	nonce: NONCE,
	evidenceDigest: ONE_RUN_DIGEST,
	decision: DECISION,
	records: [evidenceRecord(1)],
	workspace: WORKSPACE,
});

const resident: FakeFsOptions = {
	directories: [WORKSPACE],
	files: {[MANIFEST]: manifestText(), [EVIDENCE]: ONE_RUN},
};

const options = {
	spike: SPIKE,
	nonce: NONCE,
	repo: null as string | null,
	env: ENV,
	tmpRoot: TMP_ROOT,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: DECISION}),
};

const identity: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[VIEWER, okOut("agent")],
	[PERMISSION, okOut("write")],
];

const happy: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	...identity,
	[ISSUE, okOut(issuePayload())],
	[COMMENTS, okOut(commentsPayload([]))],
	[POST, okOut(JSON.stringify({id: 512347, html_url: "https://example.test/#c"}))],
	[READBACK, okOut(JSON.stringify({body: BODY}))],
	[CLOSE, okOut("{}")],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
	fs: FakeFsOptions = resident,
) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(
			runCapture({...options, ...overrides}),
			Layer.merge(fakeFs(fs).layer, shell.layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

describe("runCapture records a decision the log grounds", () => {
	it("posts, reads back, closes and answers", async () => {
		const {outcome} = await run(happy);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			spike: SPIKE,
			nonce: NONCE,
			commentId: 512347,
			runs: 1,
			evidenceDigest: ONE_RUN_DIGEST,
			state: "closed",
			discardedStdin: false,
		});
	});

	it("transcribes the run table beside the decision", async () => {
		const {calls} = await run(happy);
		const posted = calls.find((line) => POST.test(line)) ?? "";
		expect(posted).toContain("## Runs");
		expect(posted).toContain("printf");
	});

	it("captures a run whose argv names the workspace, masking it instead of refusing (#5553)", async () => {
		const records = [evidenceRecord(1, {command: ["bash", `${LEAKY_WORKSPACE}/probe.sh`]})];
		const log = evidenceText(records);
		const body = captureComment({
			nonce: NONCE,
			evidenceDigest: sha256OfText(log),
			decision: DECISION,
			records,
			workspace: LEAKY_WORKSPACE,
		});
		const {outcome, calls} = await run(
			[
				...identity,
				[ISSUE, okOut(issuePayload())],
				[COMMENTS, okOut(commentsPayload([]))],
				[POST, okOut(JSON.stringify({id: 512349, html_url: "https://example.test/#c"}))],
				[READBACK, okOut(JSON.stringify({body}))],
				[CLOSE, okOut("{}")],
			],
			{tmpRoot: LEAKY_TMP_ROOT},
			{
				directories: [LEAKY_WORKSPACE],
				files: {[LEAKY_MANIFEST]: manifestText(), [LEAKY_EVIDENCE]: log},
			},
		);
		expect(outcome.code).toBe(0);
		const posted = calls.find((line) => POST.test(line)) ?? "";
		expect(posted).toContain(`${WORKSPACE_MASK}/probe.sh`);
		expect(posted).not.toContain(LEAKY_WORKSPACE);
	});
});

describe("runCapture reds on zero scope — the precondition it most exists for", () => {
	it("refuses a log with zero recorded runs on 14, naming both ways forward", async () => {
		const {outcome, calls} = await run(
			happy,
			{},
			{...resident, files: {[MANIFEST]: manifestText()}},
		);
		expect(outcome.code).toBe(NO_EVIDENCE);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("spike run");
		expect(outcome.stderr.join("\n")).toContain("--forfeit");
		expect(calls.filter((line) => POST.test(line))).toHaveLength(0);
	});
});

describe("runCapture refuses on the authored text before it reads anything", () => {
	it("refuses empty stdin on 3", async () => {
		const {outcome} = await run(happy, {
			stdin: Effect.succeed<StdinRead>({_tag: "NoStdin", reason: "no pipe on fd 0"}),
		});
		expect(outcome.code).toBe(EMPTY_STDIN);
	});

	it("refuses a decision carrying a machine-local path on 5", async () => {
		const {outcome} = await run(happy, {
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "it is under ~/code/thing.ts"}),
		});
		expect(outcome.code).toBe(LEAKED_PATH);
		expect(outcome.stdout).toBe("");
	});
});

describe("runCapture splits a proven absence from a failed read", () => {
	it("seats a 404 on 7", async () => {
		const {outcome} = await run([...identity, [ISSUE, errOut("gh: Not Found (HTTP 404)")]]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("proven absent");
	});

	it("seats any other read failure on 11", async () => {
		const {outcome} = await run([...identity, [ISSUE, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(outcome.code).toBe(READ_OR_EXEC_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("never granted");
	});

	it("seats an absent workspace on 12, not 7", async () => {
		const {outcome} = await run(happy, {}, {});
		expect(outcome.code).toBe(NO_WORKSPACE);
	});

	it("refuses a manifest naming another spike on 18", async () => {
		const {outcome} = await run(
			happy,
			{},
			{...resident, files: {...resident.files, [MANIFEST]: manifestText({spike: 9999})}},
		);
		expect(outcome.code).toBe(WORKSPACE_MISMATCH);
	});
});

describe("the ACL gate precedes every write, on every path (ADR 0055)", () => {
	it("refuses an author below write on 19", async () => {
		const {outcome, calls} = await run([
			[VIEWER, okOut("agent")],
			[PERMISSION, okOut("read")],
			[ISSUE, okOut(issuePayload())],
			[COMMENTS, okOut(commentsPayload([]))],
		]);
		expect(outcome.code).toBe(AUTHOR_UNAUTHORIZED);
		expect(calls.filter((line) => POST.test(line) || CLOSE.test(line))).toHaveLength(0);
	});

	it("seats a permission read that failed on 11 — UNKNOWN, never a grant", async () => {
		const {outcome} = await run([
			[VIEWER, okOut("agent")],
			[PERMISSION, errOut("gh: Bad gateway (HTTP 502)")],
			[ISSUE, okOut(issuePayload())],
			[COMMENTS, okOut(commentsPayload([]))],
		]);
		expect(outcome.code).toBe(READ_OR_EXEC_UNKNOWN);
	});
});

describe("runCapture's re-entry turns on the newest marker for this nonce", () => {
	const marked = (digest: string, state = "open") =>
		[
			...identity,
			[ISSUE, okOut(issuePayload({state}))],
			[COMMENTS, okOut(commentsPayload([{id: 500, body: `${captureMarker(NONCE, digest)}\n`}]))],
			[POST, okOut(JSON.stringify({id: 512348, html_url: "https://example.test/#c"}))],
			[READBACK, okOut(JSON.stringify({body: BODY}))],
			[CLOSE, okOut("{}")],
		] as ReadonlyArray<readonly [RegExp, ExecResult]>;

	it("posts nothing when the marker already covers this log, and says the stdin was discarded", async () => {
		const {outcome, calls} = await run(marked(ONE_RUN_DIGEST));
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({commentId: 500, discardedStdin: true});
		expect(calls.filter((line) => POST.test(line))).toHaveLength(0);
	});

	it("ensures the close even on that branch, so a re-run after a failed close is safe", async () => {
		const {calls} = await run(marked(ONE_RUN_DIGEST));
		expect(calls.filter((line) => CLOSE.test(line))).toHaveLength(1);
	});

	it("supersedes a marker whose digest differs, and closes either way", async () => {
		const {outcome, calls} = await run(marked("a".repeat(64), "closed"));
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({commentId: 512348, discardedStdin: false});
		expect(calls.filter((line) => POST.test(line))).toHaveLength(1);
	});

	it("refuses a closed spike carrying no marker for this nonce on 7", async () => {
		const {outcome} = await run([
			...identity,
			[ISSUE, okOut(issuePayload({state: "closed"}))],
			[COMMENTS, okOut(commentsPayload([{id: 500, body: forfeitMarker(NONCE, 1)}]))],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("nothing to supersede");
	});
});

describe("runCapture proves the comment landed", () => {
	it("seats an unproven post on 8", async () => {
		const {outcome} = await run([
			...identity,
			[ISSUE, okOut(issuePayload())],
			[COMMENTS, okOut(commentsPayload([]))],
			[POST, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("may or may not have landed");
	});

	it("seats a read-back that differs on 9", async () => {
		const {outcome} = await run([
			...identity,
			[ISSUE, okOut(issuePayload())],
			[COMMENTS, okOut(commentsPayload([]))],
			[POST, okOut(JSON.stringify({id: 512347, html_url: "https://example.test/#c"}))],
			[READBACK, okOut(JSON.stringify({body: "somebody edited it"}))],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("seats a failed close on 8 while saying the decision DID land", async () => {
		const {outcome} = await run([
			...identity,
			[ISSUE, okOut(issuePayload())],
			[COMMENTS, okOut(commentsPayload([]))],
			[once(POST), okOut(JSON.stringify({id: 512347, html_url: "https://example.test/#c"}))],
			[READBACK, okOut(JSON.stringify({body: BODY}))],
			[CLOSE, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("IS on the record");
	});
});
