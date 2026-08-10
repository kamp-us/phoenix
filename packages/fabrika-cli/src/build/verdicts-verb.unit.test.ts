import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {comments, HEAD, issue, OLD_HEAD, pull} from "./fixtures.test-support.ts";
import {runVerdicts} from "./verdicts-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4310$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4310\/comments/;
const REVIEWS = /^gh api --paginate repos\/o\/r\/pulls\/4310\/reviews/;
const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;

const FAIL_NOW = `review-code: FAIL @ ${HEAD} — the debounce fix races the unmount`;
const PASS_STALE = `review-doc: PASS @ ${OLD_HEAD} — guide matches shipped behavior`;

const NO_REVIEWS = okOut("[]");
const PR = pull({number: 4310, body: "Fixes #4312\n\n## Deviations\nNone.\n"});

const options = {
	pr: 4310,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
	Effect.runPromise(Effect.provide(runVerdicts(options), fakeShell(script).layer));

describe("runVerdicts", () => {
	it("binds each marker to the live head and keeps the latest per gate", async () => {
		const out = await run([
			[PULL, PR],
			[COMMENTS, comments({id: 1, body: PASS_STALE}, {id: 2, body: FAIL_NOW})],
			[REVIEWS, NO_REVIEWS],
			[ISSUE, issue()],
		]);
		expect(out.code).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.head).toBe(HEAD);
		expect(parsed.rows).toHaveLength(2);
		expect(parsed.rows.find((r: {gate: string}) => r.gate === "review-doc").current).toBe(false);
		expect(parsed.rows.find((r: {gate: string}) => r.gate === "review-code").current).toBe(true);
	});

	/** "The FAIL is old" and "there is no FAIL" are different facts (#4105). */
	it("keeps a stale marker in the fold, flagged stale — never drops it", async () => {
		const out = await run([
			[PULL, PR],
			[COMMENTS, comments({id: 1, body: PASS_STALE})],
			[REVIEWS, NO_REVIEWS],
			[ISSUE, issue()],
		]);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.rows).toHaveLength(1);
		expect(parsed.rows[0].current).toBe(false);
	});

	it("reports a native review as its OWN row kind, never coerced into a marker (#4555)", async () => {
		const out = await run([
			[PULL, PR],
			[COMMENTS, okOut("[]")],
			[
				REVIEWS,
				okOut(
					JSON.stringify([{id: 98001, state: "CHANGES_REQUESTED", body: "the debounce races"}]),
				),
			],
			[ISSUE, issue()],
		]);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.rows).toEqual([
			{
				gate: "native-review",
				polarity: "CHANGES_REQUESTED",
				sha: null,
				current: null,
				reviewId: 98001,
				kind: "native",
				body: "the debounce races",
			},
		]);
	});

	it("counts rounds over the FULL comment set and computes capReached from them", async () => {
		const at = (s: number) => new Date(1_770_000_000_000 + s * 1000).toISOString();
		const out = await run([
			[PULL, PR],
			[
				COMMENTS,
				comments(
					{id: 1, body: FAIL_NOW, createdAt: at(0)},
					{id: 2, body: FAIL_NOW, createdAt: at(5)},
					{id: 3, body: FAIL_NOW, createdAt: at(400)},
					{id: 4, body: FAIL_NOW, createdAt: at(900)},
				),
			],
			[REVIEWS, NO_REVIEWS],
			[ISSUE, issue()],
		]);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.rounds).toBe(3);
		expect(parsed.capReached).toBe(true);
	});

	it("lists only the criteria appended AFTER round 2, by their provenance tag", async () => {
		const out = await run([
			[PULL, PR],
			[COMMENTS, okOut("[]")],
			[REVIEWS, NO_REVIEWS],
			[
				ISSUE,
				issue({
					body: [
						"### Acceptance criteria",
						"",
						"- [ ] focus stays put",
						"- [ ] an e2e covers the empty-list case <!-- ac:review pr:#4310 round:3 -->",
						"- [ ] an earlier one <!-- ac:review pr:#4310 round:1 -->",
						"",
					].join("\n"),
				}),
			],
		]);
		expect(JSON.parse(out.stdout).frozenCriteria).toEqual([
			{text: "an e2e covers the empty-list case", appendedRound: 3},
		]);
	});

	it("prints an empty fold as a proven answer on exit 0, with the counts on stderr", async () => {
		const out = await run([
			[PULL, PR],
			[COMMENTS, comments({id: 1, body: "just a normal comment"})],
			[REVIEWS, NO_REVIEWS],
			[ISSUE, issue()],
		]);
		expect(out.code).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.rows).toEqual([]);
		expect(parsed.rounds).toBe(0);
		expect(out.stderr.at(-1)).toContain("scanned 1 comment(s) and 0 review(s)");
	});

	it("refuses a proven-absent PR on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("build verdicts: PR #4310 is proven absent or closed.");
	});

	it("refuses an unreadable comment page on 11 — never a shorter list", async () => {
		const out = await run([
			[PULL, PR],
			[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('the verdict state is UNKNOWN, never "none"');
	});

	it("refuses an unreadable review page on 11 too", async () => {
		const out = await run([
			[PULL, PR],
			[COMMENTS, okOut("[]")],
			[REVIEWS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("paginates both list reads", async () => {
		const shell = fakeShell([
			[PULL, PR],
			[COMMENTS, okOut("[]")],
			[REVIEWS, NO_REVIEWS],
			[ISSUE, issue()],
		]);
		await Effect.runPromise(Effect.provide(runVerdicts(options), shell.layer));
		expect(shell.calls.filter((line) => line.includes("--paginate")).length).toBeGreaterThanOrEqual(
			2,
		);
	});
});
