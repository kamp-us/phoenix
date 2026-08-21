import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {comments, HEAD, OLD_HEAD, pull} from "./fixtures.test-support.ts";
import {runVerdicts} from "./verdicts-verb.ts";

const PULL = /GET .*\/repos\/o\/r\/pulls\/4321\b/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4321\/comments/;

/** A canned payload as the platform serves it — the fixtures speak `ExecResult`, the seam HTTP. */
const served = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

const CURRENT = `review-doc: PASS @ ${HEAD} — guide matches shipped behavior`;
const STALE = `review-code: PASS @ ${OLD_HEAD} — merge-ready`;
const ADVISORY = `review-skill: advisory — blocking-set PR (manual merge)\n\nReviewed-head: @ ${HEAD}\n`;

const options = {
	pr: 4321,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(runVerdicts({...options, ...overrides}), fakeSeams(script).layer),
	);

describe("runVerdicts", () => {
	it("prints the three bindings as THREE distinct tokens, newest first", async () => {
		const out = await run([
			[PULL, served(pull({comments: 2}))],
			[COMMENTS, served(comments({id: 5154891644, body: STALE}, {id: 5154902211, body: CURRENT}))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`verdicts\t${HEAD}\t2`,
				`review-doc\tPASS\t${HEAD}\tcurrent\t5154902211`,
				`review-code\tPASS\t${OLD_HEAD}\tstale\t5154891644`,
				"",
			].join("\n"),
		);
	});

	it("never lets a stale PASS print as a current one", async () => {
		const out = await run([
			[PULL, served(pull({comments: 1}))],
			[COMMENTS, served(comments({id: 1, body: STALE}))],
		]);
		expect(out.stdout).toContain("\tstale\t");
		expect(out.stdout).not.toContain("\tcurrent\t");
	});

	it("prints unbindable on EVERY row when the live head could not be resolved", async () => {
		const out = await run([
			[PULL, {status: 502, body: "{}"}],
			[COMMENTS, served(comments({id: 1, body: CURRENT}, {id: 2, body: STALE}))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("verdicts\t-\t2");
		expect(out.stdout).not.toContain("\tcurrent\t");
		expect(out.stdout).not.toContain("\tstale\t");
		expect(out.stdout.match(/\tunbindable\t/g)).toHaveLength(2);
		expect(out.stderr[0]).toContain("every row prints unbindable");
	});

	it("counts 0 as a proven answer — the PR carries no verdict", async () => {
		const out = await run([
			[PULL, served(pull({comments: 1}))],
			[COMMENTS, served(comments({id: 1, body: "just a normal comment"}))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`verdicts\t${HEAD}\t0\n`);
	});

	it("surfaces a drifted marker as a malformed ROW, never drops it from the sweep", async () => {
		const out = await run([
			[PULL, served(pull({comments: 1}))],
			[COMMENTS, served(comments({id: 77, body: "review-code: PASS — merge-ready"}))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("malformed\t-\t-\t-\t77");
		expect(out.stderr.at(-1)).toContain("comment 77 reaches for a marker and fails the format");
	});

	it("reads an advisory carrier as ADVISORY, bound by its Reviewed-head line", async () => {
		const out = await run([
			[PULL, served(pull({comments: 1}))],
			[COMMENTS, served(comments({id: 9, body: ADVISORY}))],
		]);
		expect(out.stdout).toBe(`verdicts\t${HEAD}\t1\nreview-skill\tADVISORY\t${HEAD}\tcurrent\t9\n`);
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("review verdicts: PR #4321 not found in o/r.");
	});

	it("refuses an unreadable comment list on 11 — never zero", async () => {
		const out = await run([
			[PULL, served(pull())],
			[COMMENTS, {status: 502, body: "{}"}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("whether verdicts exist is UNKNOWN, never zero");
	});

	it("refuses a provably short sweep on 13 rather than narrowing", async () => {
		const out = await run([
			[PULL, served(pull({comments: 12}))],
			[COMMENTS, served(comments({id: 1, body: CURRENT}))],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"review verdicts: received 1 of 12 comments — refusing the partial sweep.",
		);
	});

	it("emits the record with --json, keeping malformed rows in their own array", async () => {
		const out = await run(
			[
				[PULL, served(pull({comments: 2}))],
				[COMMENTS, served(comments({id: 1, body: CURRENT}, {id: 2, body: "review-code: nope"}))],
			],
			{json: true},
		);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.markers).toHaveLength(1);
		expect(parsed.malformed).toHaveLength(1);
		expect(parsed.head).toBe(HEAD);
	});
});
