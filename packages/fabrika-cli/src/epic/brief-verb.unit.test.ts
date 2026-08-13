import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {RULES, read as readHandoff} from "../wire/slice-handoff.ts";
import {runBrief} from "./brief-verb.ts";
import {BAD_SECTIONS, BREAKER_TRIPPED, OFF_VOCABULARY} from "./codes.ts";
import {
	BASE,
	BRANCH,
	BRANCH_NAME,
	COMMENTS,
	childJson,
	ENV,
	EPIC,
	GIT_DIRS,
	HEAD,
	LANDED,
	LEDGER,
	ledgerOf,
	MINE,
	ON_LANE,
	PERM,
	PLAN,
	planFile,
	REV_PARSE,
	ROOT,
	RUN,
	verdictMarkerFor,
	WRITE,
} from "./fixtures.test-support.ts";

const C1_ISSUE = /^gh api repos\/o\/r\/issues\/4301$/;

const WORLD: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, GIT_DIRS],
	[BRANCH, ON_LANE],
	[COMMENTS, MINE],
	[PERM, WRITE],
	[C1_ISSUE, childJson(4301, "extract the totals module")],
	[HEAD, okOut(`${BASE}\n`)],
];

const OPENED = {files: {[LEDGER]: ledgerOf({event: "run-opened"}), [PLAN]: planFile()}};

const run = (
	options: Partial<Parameters<typeof runBrief>[0]> = {},
	files: FakeFsOptions = OPENED,
	script: ReadonlyArray<readonly [RegExp, ExecResult]> = WORLD,
) =>
	Effect.runPromise(
		Effect.provide(
			runBrief({
				number: EPIC,
				slice: "C1",
				retry: false,
				repo: null,
				env: ENV,
				tmpRoot: "/run",
				...options,
			}),
			Layer.merge(fakeShell(script).layer, fakeFs(files).layer),
		),
	);

describe("runBrief", () => {
	it("composes the brief through the registered wire format, and it reads back Found", async () => {
		const outcome = await run();
		expect(outcome.code).toBe(0);
		const read = readHandoff(outcome.stdout);
		expect(read._tag).toBe("Found");
		if (read._tag !== "Found") return;
		expect(read.value).toMatchObject({
			id: "C1",
			issue: 4301,
			tree: ROOT,
			branch: BRANCH_NAME,
			base: BASE,
			handoff: `/run/fabrika-epic/${RUN}/C1/handoff.md`,
			fixFirst: null,
		});
		expect(read.value.criteria).toEqual([
			"- [ ] cart and invoice render through one totals module",
			"- [ ] no behavior change: existing totals tests pass unmodified",
		]);
	});

	it("carries the format's byte-fixed rules, not a per-run phrasing", async () => {
		const outcome = await run();
		expect(outcome.stdout).toContain(RULES);
	});

	it("prepends the latest FAIL verdict's first line with --retry", async () => {
		const outcome = await run(
			{retry: true},
			{
				files: {
					[LEDGER]: ledgerOf(
						{event: "run-opened"},
						{event: "slice-dispatched", slice: "C1", sha: BASE},
						{event: "slice-landed", slice: "C1", sha: LANDED},
						{
							event: "verdict-recorded",
							slice: "C1",
							detail: verdictMarkerFor("C1", "FAIL", LANDED, "the parser drops the final row"),
						},
					),
					[PLAN]: planFile(),
				},
			},
		);
		expect(outcome.code).toBe(0);
		const read = readHandoff(outcome.stdout);
		expect(read._tag).toBe("Found");
		if (read._tag !== "Found") return;
		expect(read.value.fixFirst).toBe("the parser drops the final row");
	});

	it("refuses --retry with no FAIL verdict on record, on 10", async () => {
		const outcome = await run({retry: true});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'epic brief: --retry, but slice "C1" has no FAIL verdict on record.',
		);
	});

	it("refuses a slice the run does not carry, on 10", async () => {
		const outcome = await run({slice: "C9"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});

	it("refuses to brief past a tripped breaker on 23 — escalate, do not dispatch", async () => {
		const dead = {event: "dispatch-dead" as const, slice: "C1"};
		const outcome = await run(
			{},
			{
				files: {[LEDGER]: ledgerOf({event: "run-opened"}, dead, dead), [PLAN]: planFile()},
			},
		);
		expect(outcome.code).toBe(BREAKER_TRIPPED);
		expect(outcome.stderr.at(-1)).toContain("escalate; do not dispatch");
	});

	it("refuses a child whose acceptance criteria drifted — no criterion is invented", async () => {
		const drifted = childJson(4301, "extract the totals module");
		const outcome = await run({}, OPENED, [
			[
				C1_ISSUE,
				okOut(drifted.stdout.replace("### Acceptance criteria", "### Acceptance Criteria")),
			],
			...WORLD,
		]);
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stdout).toBe("");
	});
});
