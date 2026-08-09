import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	comments,
	ENV,
	HEAD,
	OTHER_HEAD,
	pull,
	reviews,
	unexhaustedPage,
} from "./fixtures.test-support.ts";
import {inForce, runGate} from "./gate-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4321\/comments/;
const REVIEWS = /^gh api -i repos\/o\/r\/pulls\/4321\/reviews/;
const ACL = /^gh api repos\/o\/r\/collaborators\/[^ ]+\/permission/;

const options = {
	pr: 4321,
	sha: HEAD,
	require: ["review-code"] as ReadonlyArray<string>,
	cp: false,
	repo: null,
	json: false,
	env: ENV,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runGate({...options, ...overrides}), fakeShell(script).layer));

const marker = (namespace: string, polarity: string, sha: string): string =>
	`${namespace}: ${polarity} @ ${sha} — the clause`;

const candidate = (sha: string, stamp: string) => ({
	namespace: "review-code",
	polarity: "PASS" as const,
	sha,
	carrier: "marker" as const,
	stamp,
	commentId: 1,
});

describe("inForce", () => {
	it("prefers a head-bound verdict over a newer stale one (#4189)", () => {
		const winner = inForce(
			[candidate(OTHER_HEAD, "2026-08-08T02:00:00Z"), candidate(HEAD, "2026-08-08T01:00:00Z")],
			HEAD,
		);
		expect(winner?.sha).toBe(HEAD);
	});

	it("orders by the WRITE stamp among equally-bound candidates (#4200)", () => {
		const winner = inForce(
			[
				{...candidate(HEAD, "2026-08-08T01:00:00Z"), commentId: 1},
				{...candidate(HEAD, "2026-08-08T03:00:00Z"), polarity: "FAIL", commentId: 2},
			],
			HEAD,
		);
		expect(winner?.commentId).toBe(2);
	});
});

describe("runGate", () => {
	it("prints one ns line per required namespace and satisfies only when all pass", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 2})],
				[
					COMMENTS,
					comments(
						{id: 1, body: marker("review-code", "PASS", HEAD)},
						{id: 2, body: marker("review-doc", "PASS", HEAD)},
					),
				],
				[REVIEWS, reviews()],
				[ACL, okOut("write")],
			],
			{require: ["review-code", "review-doc"]},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`gate\tsatisfied\t${HEAD}`,
				"ns\treview-code\tpass\tmarker",
				"ns\treview-doc\tpass\tmarker",
				"",
			].join("\n"),
		);
	});

	it("does not collapse repeated --require: a live FAIL in the second namespace blocks (#4520)", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 2})],
				[
					COMMENTS,
					comments(
						{id: 1, body: marker("review-code", "PASS", HEAD)},
						{id: 2, body: marker("review-doc", "FAIL", HEAD)},
					),
				],
				[REVIEWS, reviews()],
				[ACL, okOut("write")],
			],
			{require: ["review-code", "review-doc"]},
		);
		expect(out.stdout.split("\n")[0]).toBe(`gate\tblocked\t${HEAD}`);
		expect(out.stdout).toContain("ns\treview-doc\tfail\tmarker");
	});

	it("blocks on `absent` — a PR with no live-head verdict at all (#3944)", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMENTS, comments()],
			[REVIEWS, reviews()],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[`gate\tblocked\t${HEAD}`, "ns\treview-code\tabsent\t-", ""].join("\n"),
		);
	});

	it("blocks on `stale` and keeps it a distinct token from absent", async () => {
		const out = await run([
			[PULL, pull({comments: 1})],
			[COMMENTS, comments({id: 1, body: marker("review-code", "PASS", OTHER_HEAD)})],
			[REVIEWS, reviews()],
			[ACL, okOut("write")],
		]);
		expect(out.stdout).toContain("ns\treview-code\tstale\tmarker");
	});

	it("drops an unauthorized author's marker rather than counting it (ADR 0055)", async () => {
		const out = await run([
			[PULL, pull({comments: 1})],
			[COMMENTS, comments({id: 1, body: marker("review-code", "PASS", HEAD)})],
			[REVIEWS, reviews()],
			[ACL, okOut("read")],
		]);
		expect(out.stdout).toContain("ns\treview-code\tabsent\t-");
	});

	it("refuses on 11 when the ACL lookup itself fails — never `absent`", async () => {
		const out = await run([
			[PULL, pull({comments: 1})],
			[COMMENTS, comments({id: 1, body: marker("review-code", "PASS", HEAD)})],
			[REVIEWS, reviews()],
			[ACL, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("folds a decisive native review at this head into the code namespace", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMENTS, comments()],
			[REVIEWS, reviews({login: "cansirin", state: "APPROVED", commit: HEAD})],
		]);
		expect(out.stdout).toContain("ns\treview-code\tpass\treview-fold");
	});

	it("treats a §CP advisory carrying a [FAIL] row as fail and says so (ADR 0226)", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[
					COMMENTS,
					comments({
						id: 1,
						body: `review-code: advisory — a clause\n\nReviewed-head: @ ${HEAD}\n\n- [FAIL] a criterion`,
					}),
				],
				[REVIEWS, reviews()],
				[ACL, okOut("write")],
			],
			{cp: true},
		);
		expect(out.stdout).toContain("ns\treview-code\tfail\tadvisory");
		expect(out.stderr.some((line) => line.includes("an invalid emission (ADR 0226)"))).toBe(true);
	});

	it("refuses an off-vocabulary --require on 10", async () => {
		const out = await run([[PULL, pull()]], {require: ["review-vibes"]});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("is not a review namespace");
	});

	it("refuses a truncated comment sweep on 13", async () => {
		const out = await run([
			[PULL, pull({comments: 9})],
			[COMMENTS, comments({id: 1, body: "hi"})],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	// Reviews declare no total, so the completeness proof is a terminal page with no `next` link.
	it("refuses an unexhausted review read on 13 — pagination is the reviews' only proof", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMENTS, comments()],
			[REVIEWS, unexhaustedPage()],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toBe(
			"ship gate: the review read never reached a terminal page — pagination is unexhausted, so the native-review fold would rest on a truncated set; refusing the partial resolution.",
		);
	});

	it("refuses a closed PR on 7", async () => {
		const out = await run([[PULL, pull({state: "closed"})]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});
