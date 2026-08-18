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
const PR_ON_MAIN = pull({
	number: 4310,
	body: "Fixes #4312\n\n## Deviations\nNone.\n",
	base: {ref: "main"},
});

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
		expect(out.stderr.join("\n")).toContain("scanned 1 comment(s) and 0 review(s)");
		expect(out.stderr.at(-1)).toContain("cap 3 = 3 declared + 0 cleared round(s)");
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
	describe("the founder's cleared rounds", () => {
		const CONFIG =
			/^gh api -H Accept: application\/vnd\.github\.raw repos\/o\/r\/contents\/\.fabrika\.jsonc\?ref=main$/;
		const CONFIGURED = okOut('{"capClearAuthors": ["@usirin"]}');
		const AUTHORIZATION = 'Founder ruling 2026-08-18: "one more round."';
		const CAPPED = [
			{id: 1, body: `review-code: FAIL @ ${HEAD} — one`, createdAt: "2026-08-18T01:00:00Z"},
			{id: 2, body: `review-code: FAIL @ ${HEAD} — two`, createdAt: "2026-08-18T02:00:00Z"},
			{id: 3, body: `review-code: FAIL @ ${HEAD} — three`, createdAt: "2026-08-18T03:00:00Z"},
		];
		const GRANT = [
			{id: 4, body: AUTHORIZATION, author: "usirin", createdAt: "2026-08-18T03:10:00Z"},
			{
				id: 5,
				body: "cap-cleared: round 3 · 2026-08-18T03:11:00Z",
				author: "usirin",
				createdAt: "2026-08-18T03:11:00Z",
			},
		];

		it("caps the loop at the declared round when nothing is cleared", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[COMMENTS, comments(...CAPPED)],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			const parsed = JSON.parse(out.stdout);
			expect(parsed.rounds).toBe(3);
			expect(parsed.capReached).toBe(true);
		});

		it("folds an honoured clearance as budget, so the granted round proceeds", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[COMMENTS, comments(...CAPPED, ...GRANT)],
				[CONFIG, CONFIGURED],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			const parsed = JSON.parse(out.stdout);
			expect(parsed.capReached).toBe(false);
			expect(parsed.clearances).toHaveLength(1);
			expect(parsed.clearances[0]).toMatchObject({round: 3, by: "usirin", honoured: true});
		});

		it("spends the grant on the next round — it never re-arms", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[
					COMMENTS,
					comments(...CAPPED, ...GRANT, {
						id: 6,
						body: `review-code: FAIL @ ${HEAD} — four`,
						createdAt: "2026-08-18T04:00:00Z",
					}),
				],
				[CONFIG, CONFIGURED],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			const parsed = JSON.parse(out.stdout);
			expect(parsed.rounds).toBe(4);
			expect(parsed.capReached).toBe(true);
		});

		it("keeps an unauthorized marker visible as a refused row, never as budget", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[
					COMMENTS,
					comments(...CAPPED, {
						id: 5,
						body: "cap-cleared: round 3 · 2026-08-18T03:11:00Z",
						author: "an-agent",
						createdAt: "2026-08-18T03:11:00Z",
					}),
				],
				[CONFIG, CONFIGURED],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			const parsed = JSON.parse(out.stdout);
			expect(parsed.capReached).toBe(true);
			expect(parsed.clearances[0]).toMatchObject({honoured: false});
			expect(parsed.clearances[0].reason).toContain("grant-author set");
		});

		it("holds the whole fold UNKNOWN when the grant-author set cannot be read", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[COMMENTS, comments(...CAPPED, ...GRANT)],
				[CONFIG, errOut("gh: Bad gateway (HTTP 502)")],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
		});
	});
});
