import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, LOGS_EXPIRED, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	checkRuns,
	ENV,
	HEAD,
	httpError,
	JOB_LOG,
	JOBS,
	jobs,
	pull,
	runsAtHead,
} from "./fixtures.test-support.ts";
import {runLogs, tailBytes} from "./logs-verb.ts";

const PULL = /^GET .*\/repos\/o\/r\/pulls\/4321$/;
const CHECK_RUNS = /^GET .*\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs\?/;
const RUNS_AT_HEAD = /^GET .*\/repos\/o\/r\/actions\/runs\?head_sha=/;

/** The shared payload fixtures speak `gh`'s `ExecResult`; the seam now serves the same bytes. */
const reply = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

const options = {
	pr: 4321,
	sha: "",
	context: "",
	maxBytes: 65536,
	repo: null,
	json: false,
	env: ENV,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runLogs({...options, ...overrides}), fakeSeams(script).layer));

/** A served log body: the bytes GitHub's signed URL answers with, not JSON. */
const logText = (text: string): HttpReply => ({status: 200, body: text});

const failed = (name: string) => ({name, status: "completed", conclusion: "failure"});
const passed = (name: string) => ({name, status: "completed", conclusion: "success"});

describe("tailBytes", () => {
	it("keeps the LAST n bytes, because the failure is at the end", () => {
		expect(tailBytes("abcdef", 3)).toEqual({text: "def", bytes: 3, truncated: true});
	});

	it("declares nothing truncated when the whole log fits", () => {
		expect(tailBytes("abc", 10).truncated).toBe(false);
	});
});

describe("runLogs reads every failing gating context, not the first", () => {
	it("frames one block per failing context with its job, bytes and truncation", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[
				CHECK_RUNS,
				reply(checkRuns(3, [failed("unit tests"), failed("typecheck"), passed("lint")])),
			],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[
				JOBS,
				jobs(2, [
					{id: 441, name: "unit tests"},
					{id: 442, name: "typecheck"},
				]),
			],
			[JOB_LOG, logText("AssertionError: expected 3 to be 2")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`logs\t2\t${HEAD}`);
		expect(out.stdout).toContain("==== context unit tests job 441 bytes 34 truncated false ====");
		expect(out.stdout).toContain("==== context typecheck job 442 bytes 34 truncated false ====");
	});

	it("answers `logs 0` when nothing gating is failing — a proven answer, not a refusal", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [passed("ci-required")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(0, []))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`logs\t0\t${HEAD}\n`);
	});

	it("excludes an informational context before anything is fetched (ADR 0061)", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("deploy (web)")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(0, []))],
		]);
		expect(out.stdout).toBe(`logs\t0\t${HEAD}\n`);
	});

	it("emits a context with no workflow job behind it rather than failing the whole read", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(2, [failed("external scan"), failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
			[JOB_LOG, logText("AssertionError")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`logs\t2\t${HEAD}`);
		expect(out.stdout).toContain("==== context external scan job - bytes 0 truncated false ====");
		expect(out.stderr.join("\n")).toContain("posted by an external check");
	});

	it("declares truncation rather than letting a bounded log read as complete", async () => {
		const out = await run(
			[
				[PULL, reply(pull())],
				[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
				[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
				[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
				[JOB_LOG, logText("0123456789")],
			],
			{maxBytes: 4},
		);
		expect(out.stdout).toContain("bytes 4 truncated true");
		expect(out.stderr.join("\n")).toContain("truncated to the last 4 bytes of 10");
	});
});

describe("runLogs refuses rather than answering `no failed steps`", () => {
	it("refuses expired logs on 15 — a fact about the run, not a failed read", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
			[JOB_LOG, httpError(410, "Gone")],
		]);
		expect(out.code).toBe(LOGS_EXPIRED);
		expect(out.stdout).toBe("");
	});

	it("refuses a purged log on 15 when the platform answers 404 rather than 410", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(1, [{id: 441, name: "unit tests"}])],
			[JOB_LOG, httpError(404, "Not Found")],
		]);
		expect(out.code).toBe(LOGS_EXPIRED);
		expect(out.stdout).toBe("");
	});

	it("refuses an unreadable check-run read on 11", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, httpError(502, "Bad gateway")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "no failed steps"');
	});

	it("refuses a short job enumeration on 13", async () => {
		const out = await run([
			[PULL, reply(pull())],
			[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			[RUNS_AT_HEAD, reply(runsAtHead(1, [{id: 77}]))],
			[JOBS, jobs(9, [{id: 441, name: "unit tests"}])],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses a --context naming no failing gating context on 7, listing the ones there are", async () => {
		const out = await run(
			[
				[PULL, reply(pull())],
				[CHECK_RUNS, reply(checkRuns(1, [failed("unit tests")]))],
			],
			{context: "typecheck"},
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("failing contexts are: unit tests");
	});
});
