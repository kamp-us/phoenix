import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	type FakeFsOptions,
	fakeFs,
	fakeSeams,
	okOut,
	type Scripted,
} from "../fakes.test-support.ts";
import {captureMarker, forfeitNote} from "./bodies.ts";
import {
	CAPTURE_STALE,
	MALFORMED_RECORD,
	NO_WORKSPACE,
	NOT_CAPTURED,
	READ_OR_EXEC_UNKNOWN,
	REMOVAL_UNPROVEN,
	TREE_MOVED,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {runDispose} from "./dispose-verb.ts";
import {
	CLOSE,
	COMMENTS,
	commentsPayload,
	ENV,
	EVIDENCE,
	evidenceRecord,
	ISSUE,
	issuePayload,
	MANIFEST,
	manifestText,
	NONCE,
	ONE_RUN,
	ONE_RUN_DIGEST,
	POST,
	QUESTION,
	READBACK,
	SPIKE,
	STATUS,
	TMP_ROOT,
	WORKSPACE,
} from "./fixtures.test-support.ts";

const NOTE = forfeitNote({
	nonce: NONCE,
	question: QUESTION,
	records: [evidenceRecord(1)],
	workspace: WORKSPACE,
});

const resident: FakeFsOptions = {
	directories: [WORKSPACE],
	files: {[MANIFEST]: manifestText(), [EVIDENCE]: ONE_RUN},
};

const options = {
	nonce: NONCE,
	forfeit: false,
	repo: null as string | null,
	env: ENV,
	tmpRoot: TMP_ROOT,
};

const CAPTURED = commentsPayload([{id: 500, body: `${captureMarker(NONCE, ONE_RUN_DIGEST)}\n`}]);

const happy: ReadonlyArray<Scripted> = [
	[STATUS, okOut("")],
	[ISSUE, {status: 200, body: issuePayload({state: "closed"})}],
	[COMMENTS, {status: 200, body: CAPTURED}],
];

const run = (
	script: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
	fs: FakeFsOptions = resident,
) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(
			runDispose({...options, ...overrides}),
			Layer.merge(fakeFs(fs).layer, seams.layer),
		),
	).then((outcome) => ({outcome, requests: seams.requests, bodies: seams.bodies}));
};

describe("runDispose removes a captured spike's workspace and proves it is gone", () => {
	it("answers the disposal with the tree it judged", async () => {
		const {outcome} = await run(happy);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			spike: SPIKE,
			nonce: NONCE,
			workspace: "removed",
			treeMatched: true,
			runs: 1,
			forfeited: false,
		});
	});

	it("names no path in the answer — there is nothing left to point at", async () => {
		const {outcome} = await run(happy);
		expect(outcome.stdout).not.toContain(WORKSPACE);
	});

	it("seats a workspace still present on re-probe on 16", async () => {
		const {outcome} = await run(happy, {}, {...resident, survivesRemoval: [WORKSPACE]});
		expect(outcome.code).toBe(REMOVAL_UNPROVEN);
		expect(outcome.stdout).toBe("");
	});
});

describe("the tree comparison runs first, so a 17 never destroys the leak it found", () => {
	const dirty = [
		[STATUS, okOut("?? apps/web/src/probe.ts\n!! node_modules/\n")],
		[ISSUE, {status: 200, body: issuePayload({state: "closed"})}],
		[COMMENTS, {status: 200, body: CAPTURED}],
	] as ReadonlyArray<Scripted>;

	it("refuses on 17 with the workspace intact and nothing posted", async () => {
		const {outcome, requests} = await run(dirty, {forfeit: true});
		expect(outcome.code).toBe(TREE_MOVED);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("NOT removed");
		expect(requests.filter((line) => POST.test(line))).toHaveLength(0);
	});

	it("enumerates every differing line, not only the first", async () => {
		const {outcome} = await run(dirty);
		expect(outcome.stderr.join("\n")).toContain("apps/web/src/probe.ts");
		expect(outcome.stderr.join("\n")).toContain("node_modules/");
	});

	it("counts an ignored path — the check has no hole where prototypes write", async () => {
		const {outcome} = await run([
			[STATUS, okOut("!! dist/\n")],
			[ISSUE, {status: 200, body: issuePayload({state: "closed"})}],
			[COMMENTS, {status: 200, body: CAPTURED}],
		]);
		expect(outcome.code).toBe(TREE_MOVED);
	});

	it("seats an unreadable tree on 11 with nothing removed", async () => {
		const {outcome} = await run([[STATUS, errOut("fatal: not a git repository")]]);
		expect(outcome.code).toBe(READ_OR_EXEC_UNKNOWN);
	});
});

describe("runDispose refuses to destroy what a decision would rest on", () => {
	it("seats an uncaptured spike on 15, naming both ways forward", async () => {
		const {outcome} = await run([
			[STATUS, okOut("")],
			[ISSUE, {status: 200, body: issuePayload()}],
			[COMMENTS, {status: 200, body: commentsPayload([])}],
		]);
		expect(outcome.code).toBe(NOT_CAPTURED);
		expect(outcome.stderr.join("\n")).toContain("--forfeit");
	});

	it("seats a capture that no longer covers the log on 21, forfeit or not", async () => {
		const stale = [
			[STATUS, okOut("")],
			[ISSUE, {status: 200, body: issuePayload({state: "closed"})}],
			[
				COMMENTS,
				{
					status: 200,
					body: commentsPayload([{id: 500, body: captureMarker(NONCE, "a".repeat(64))}]),
				},
			],
		] as ReadonlyArray<Scripted>;
		expect((await run(stale)).outcome.code).toBe(CAPTURE_STALE);
		const forfeited = await run(stale, {forfeit: true});
		expect(forfeited.outcome.code).toBe(CAPTURE_STALE);
		expect(forfeited.requests.filter((line) => POST.test(line))).toHaveLength(0);
	});

	it("names the human escalation a 19 on capture would force", async () => {
		const {outcome} = await run([
			[STATUS, okOut("")],
			[ISSUE, {status: 200, body: issuePayload({state: "closed"})}],
			[
				COMMENTS,
				{
					status: 200,
					body: commentsPayload([{id: 500, body: captureMarker(NONCE, "a".repeat(64))}]),
				},
			],
		]);
		expect(outcome.stderr.join("\n")).toContain("someone holding write");
	});

	it("seats an absent workspace on 12", async () => {
		const {outcome} = await run(happy, {}, {});
		expect(outcome.code).toBe(NO_WORKSPACE);
	});

	it("seats a manifest that does not parse on 4", async () => {
		const {outcome} = await run(happy, {}, {directories: [WORKSPACE], files: {[MANIFEST]: "{}\n"}});
		expect(outcome.code).toBe(MALFORMED_RECORD);
	});
});

describe("--forfeit abandons the spike on the record before disposing", () => {
	const forfeitScript: ReadonlyArray<Scripted> = [
		[STATUS, okOut("")],
		[ISSUE, {status: 200, body: issuePayload()}],
		[COMMENTS, {status: 200, body: commentsPayload([])}],
		[POST, {status: 201, body: JSON.stringify({id: 700, html_url: "https://example.test/#c"})}],
		[READBACK, {status: 200, body: JSON.stringify({body: NOTE})}],
		[CLOSE, {status: 200, body: "{}"}],
	];

	it("posts the note, closes, disposes and says so", async () => {
		const {outcome, requests} = await run(forfeitScript, {forfeit: true});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).forfeited).toBe(true);
		expect(requests.filter((line) => CLOSE.test(line))).toHaveLength(1);
	});

	it("reads the question from the manifest — dispose takes no --question", async () => {
		const {requests, bodies} = await run(forfeitScript, {forfeit: true});
		expect(bodies[requests.findIndex((line) => POST.test(line))]).toContain(QUESTION);
	});

	it("seats an unproven post on 8 with nothing removed", async () => {
		const {outcome} = await run(
			[
				[STATUS, okOut("")],
				[ISSUE, {status: 200, body: issuePayload()}],
				[COMMENTS, {status: 200, body: commentsPayload([])}],
				[POST, {status: 502, body: "{}"}],
			],
			{forfeit: true},
		);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("Nothing was removed");
	});
});

describe("a provisional manifest skips the issue half entirely", () => {
	it("disposes an orphaned workspace with no GitHub read at all", async () => {
		const {outcome, requests} = await run(
			[[STATUS, okOut("")]],
			{},
			{
				directories: [WORKSPACE],
				files: {[MANIFEST]: manifestText({spike: null})},
			},
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({spike: null, runs: 0, forfeited: false});
		expect(requests).toHaveLength(0);
	});
});
