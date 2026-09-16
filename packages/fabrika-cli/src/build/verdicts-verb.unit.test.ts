import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {CAP_ROUND} from "../retry-budget.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	comments,
	GATEWAY,
	GH_TOKEN_ENV,
	HEAD,
	issue,
	NOT_FOUND,
	OLD_HEAD,
	PRIOR_HEADS,
	pull,
	served,
} from "./fixtures.test-support.ts";
import {runChildVerdicts, runVerdicts} from "./verdicts-verb.ts";

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4310$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4310\/comments/;
const REVIEWS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/pulls\/4310\/reviews/;
const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4312$/;

const FAIL_NOW = `review-code: FAIL @ ${HEAD} — the debounce fix races the unmount`;
const failAt = (sha: string) => `review-code: FAIL @ ${sha} — the debounce fix races the unmount`;
const PASS_STALE = `review-doc: PASS @ ${OLD_HEAD} — guide matches shipped behavior`;

const NO_REVIEWS = served([]);
const PR = pull({number: 4310, body: "Fixes #4312\n\n## Deviations\nNone.\n"});
const PR_ON_MAIN = pull({
	number: 4310,
	body: "Fixes #4312\n\n## Deviations\nNone.\n",
	base: {ref: "main"},
});

const options = {
	pr: 4310,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", ...GH_TOKEN_ENV} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(Effect.provide(runVerdicts(options), fakeSeams(script).layer));

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

	/** "The FAIL is old" and "there is no FAIL" are different facts. */
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
			[COMMENTS, served([])],
			[REVIEWS, served([{id: 98001, state: "CHANGES_REQUESTED", body: "the debounce races"}])],
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
					{id: 1, body: failAt(PRIOR_HEADS[0]), createdAt: at(0)},
					{id: 2, body: failAt(PRIOR_HEADS[0]), createdAt: at(5)},
					{id: 3, body: failAt(PRIOR_HEADS[1]), createdAt: at(400)},
					{id: 4, body: failAt(PRIOR_HEADS[2]), createdAt: at(900)},
					{id: 5, body: failAt(PRIOR_HEADS[3]), createdAt: at(1400)},
				),
			],
			[REVIEWS, NO_REVIEWS],
			[ISSUE, issue()],
		]);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.rounds).toBe(CAP_ROUND);
		expect(parsed.capReached).toBe(true);
	});

	/**
	 * Two heads, two gates each, minutes between the gates at one head: a wall-clock rule reads that
	 * as four rounds and spends the cap on gate latency.
	 */
	it("counts two gates grading one head as ONE round, however far apart they post", async () => {
		const out = await run([
			[PULL, PR],
			[
				COMMENTS,
				comments(
					{
						id: 1,
						body: `governance: FAIL @ ${PRIOR_HEADS[0]} — the ADR collides`,
						createdAt: "2026-08-18T20:36:29Z",
					},
					{
						id: 2,
						body: `review-doc: FAIL @ ${PRIOR_HEADS[0]} — the guide drifted`,
						createdAt: "2026-08-18T20:44:35Z",
					},
					{
						id: 3,
						body: `governance: FAIL @ ${HEAD} — the ADR still collides`,
						createdAt: "2026-08-18T20:56:57Z",
					},
					{
						id: 4,
						body: `review-doc: FAIL @ ${HEAD} — the guide still drifted`,
						createdAt: "2026-08-18T21:01:05Z",
					},
				),
			],
			[REVIEWS, NO_REVIEWS],
			[ISSUE, issue()],
		]);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.rounds).toBe(2);
		expect(parsed.capReached).toBe(false);
	});

	it("lists only the criteria appended at or past the cap round, by their provenance tag", async () => {
		const out = await run([
			[PULL, PR],
			[COMMENTS, served([])],
			[REVIEWS, NO_REVIEWS],
			[
				ISSUE,
				issue({
					body: [
						"### Acceptance criteria",
						"",
						"- [ ] focus stays put",
						"- [ ] an e2e covers the empty-list case <!-- ac:review pr:#4310 round:4 -->",
						"- [ ] an earlier one <!-- ac:review pr:#4310 round:1 -->",
						"",
					].join("\n"),
				}),
			],
		]);
		expect(JSON.parse(out.stdout).frozenCriteria).toEqual([
			{text: "an e2e covers the empty-list case", appendedRound: CAP_ROUND},
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
		expect(out.stderr.at(-1)).toContain(
			`cap ${CAP_ROUND} = ${CAP_ROUND} declared, nothing cleared`,
		);
	});

	/**
	 * The three mergeability heads. A conflicting PR is repair work no gate emits a FAIL for, so an
	 * all-PASS fold over one read as the Repair section's proven no-work answer and stranded the PR;
	 * the platform's uncomputed read is its own third value, never the clean one.
	 */
	describe("mergeability", () => {
		const PASS_NOW = `review-code: PASS @ ${HEAD} — merge-ready`;
		const folded = (overrides: Record<string, unknown>) =>
			run([
				[PULL, pull({number: 4310, base: {ref: "main"}, ...overrides})],
				[COMMENTS, comments({id: 1, body: PASS_NOW})],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);

		it("reads a mergeable PR as mergeable", async () => {
			const out = await folded({mergeable: true, mergeable_state: "clean"});
			expect(JSON.parse(out.stdout).mergeability).toBe("mergeable");
			expect(out.stderr.join("\n")).toContain("build verdicts: PR #4310 merges cleanly into main.");
		});

		it("reads a conflicting PR as conflicting, and says so beside the PASS row", async () => {
			const out = await folded({mergeable: false, mergeable_state: "dirty"});
			const parsed = JSON.parse(out.stdout);
			expect(parsed.mergeability).toBe("conflicting");
			expect(parsed.rows[0].polarity).toBe("PASS");
			expect(out.stderr.join("\n")).toContain(
				"build verdicts: PR #4310 is CONFLICTING against main — a base conflict is repair work no gate emits a FAIL for, so this fold is not a clean answer.",
			);
		});

		it("keeps a null mergeable UNKNOWN — never collapsed to a clean value", async () => {
			const out = await folded({mergeable: null, mergeable_state: "unknown"});
			expect(JSON.parse(out.stdout).mergeability).toBe("unknown");
			expect(out.stderr.join("\n")).toContain("is UNKNOWN — GitHub had not computed it yet");
		});
	});

	it("refuses a proven-absent PR on 7", async () => {
		const out = await run([[PULL, NOT_FOUND]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("build verdicts: PR #4310 is proven absent or closed.");
	});

	it("refuses an unreadable comment page on 11 — never a shorter list", async () => {
		const out = await run([
			[PULL, PR],
			[COMMENTS, GATEWAY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('the verdict state is UNKNOWN, never "none"');
	});

	it("refuses an unreadable review page on 11 too", async () => {
		const out = await run([
			[PULL, PR],
			[COMMENTS, served([])],
			[REVIEWS, GATEWAY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("paginates both list reads", async () => {
		const seams = fakeSeams([
			[PULL, PR],
			[COMMENTS, served([])],
			[REVIEWS, NO_REVIEWS],
			[ISSUE, issue()],
		]);
		await Effect.runPromise(Effect.provide(runVerdicts(options), seams.layer));
		expect(seams.requests.filter((line) => line.includes("per_page=100")).length).toBe(2);
	});
	describe("the founder's cleared rounds", () => {
		const CONFIG = /^GET \S+\/repos\/o\/r\/contents\/\.fabrika\.jsonc\?ref=main$/;
		const CONFIGURED: HttpReply = {
			status: 200,
			body: JSON.stringify({capClearAuthors: ["@usirin"]}),
		};
		const PERMISSION = /^GET \S+\/repos\/o\/r\/collaborators\/usirin\/permission/;
		const WRITES = served({permission: "admin"});
		const AUTHORIZATION = 'Founder ruling 2026-08-18: "one more round."';
		// One graded head per round, so the set spends the whole declared budget — a round is a head,
		// not a span of clock.
		const CAPPED = [
			{
				id: 1,
				body: `review-code: FAIL @ ${PRIOR_HEADS[0]} — one`,
				createdAt: "2026-08-18T01:00:00Z",
			},
			{
				id: 2,
				body: `review-code: FAIL @ ${PRIOR_HEADS[1]} — two`,
				createdAt: "2026-08-18T02:00:00Z",
			},
			{
				id: 3,
				body: `review-code: FAIL @ ${PRIOR_HEADS[2]} — three`,
				createdAt: "2026-08-18T03:00:00Z",
			},
			{
				id: 4,
				body: `review-code: FAIL @ ${PRIOR_HEADS[3]} — four`,
				createdAt: "2026-08-18T03:05:00Z",
			},
		];
		const GRANT = [
			{id: 5, body: AUTHORIZATION, author: "usirin", createdAt: "2026-08-18T03:10:00Z"},
			{
				id: 6,
				body: `cap-cleared: round ${CAP_ROUND} · 2026-08-18T03:11:00Z`,
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
			expect(parsed.rounds).toBe(CAP_ROUND);
			expect(parsed.capReached).toBe(true);
		});

		it("folds an honoured clearance as budget, so the granted round proceeds", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[COMMENTS, comments(...CAPPED, ...GRANT)],
				[CONFIG, CONFIGURED],
				[PERMISSION, WRITES],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			const parsed = JSON.parse(out.stdout);
			expect(parsed.capReached).toBe(false);
			expect(parsed.clearances).toHaveLength(1);
			expect(parsed.clearances[0]).toMatchObject({round: CAP_ROUND, by: "usirin", honoured: true});
		});

		it("spends the grant on the next round — it never re-arms", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[
					COMMENTS,
					comments(...CAPPED, ...GRANT, {
						id: 7,
						body: `review-code: FAIL @ ${HEAD} — the granted round`,
						createdAt: "2026-08-18T04:00:00Z",
					}),
				],
				[CONFIG, CONFIGURED],
				[PERMISSION, WRITES],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			const parsed = JSON.parse(out.stdout);
			expect(parsed.rounds).toBe(CAP_ROUND + 1);
			expect(parsed.capReached).toBe(true);
		});

		/**
		 * The bare second stamp: without the adjacency clause the read takes the last prior comment
		 * by that author — grant #1's own marker, which carries an ISO date — and every grant after
		 * the first is authorized by nothing.
		 */
		it("refuses a second marker whose only precedent is the first grant's marker", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[
					COMMENTS,
					comments(
						...CAPPED,
						...GRANT,
						{
							id: 7,
							body: `review-code: FAIL @ ${HEAD} — the granted round`,
							createdAt: "2026-08-18T04:00:00Z",
						},
						{
							id: 8,
							body: `cap-cleared: round ${CAP_ROUND + 1} · 2026-08-18T05:00:00Z`,
							author: "usirin",
							createdAt: "2026-08-18T05:00:00Z",
						},
					),
				],
				[CONFIG, CONFIGURED],
				[PERMISSION, WRITES],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			const parsed = JSON.parse(out.stdout);
			const bare = parsed.clearances.find((row: {round: number}) => row.round === CAP_ROUND + 1);
			expect(bare).toMatchObject({honoured: false, authorization: null});
			expect(bare.reason).toContain("immediately before");
			expect(parsed.capReached).toBe(true);
		});

		/** A committed set narrows the ACL; it never stands in for one. */
		it("refuses a configured author who resolves below write at the ACL", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[COMMENTS, comments(...CAPPED, ...GRANT)],
				[CONFIG, CONFIGURED],
				[PERMISSION, served({permission: "read"})],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			const parsed = JSON.parse(out.stdout);
			expect(parsed.capReached).toBe(true);
			expect(parsed.clearances[0]).toMatchObject({honoured: false});
			expect(parsed.clearances[0].reason).toContain("below write");
		});

		it("holds the fold UNKNOWN when a configured author's permission cannot be read", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[COMMENTS, comments(...CAPPED, ...GRANT)],
				[CONFIG, CONFIGURED],
				[PERMISSION, GATEWAY],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
		});

		it("keeps an unauthorized marker visible as a refused row, never as budget", async () => {
			const out = await run([
				[PULL, PR_ON_MAIN],
				[
					COMMENTS,
					comments(...CAPPED, {
						id: 6,
						body: `cap-cleared: round ${CAP_ROUND} · 2026-08-18T03:11:00Z`,
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
				[CONFIG, GATEWAY],
				[REVIEWS, NO_REVIEWS],
				[ISSUE, issue()],
			]);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
		});
	});
});

/**
 * The child arm — where a lane sent to repair by `build claim --resume` reads its findings. A child
 * opens no PR, so the whole fold is the range-bound comments on the issue.
 */
describe("runChildVerdicts", () => {
	const BASE = "9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4";
	const TIP = "03135b917283a4b5c6d7e8f90a1b2c3d4e5f6071";
	const NEXT_TIP = "5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
	const CHILD_COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4312\/comments/;
	const range = (polarity: string, tip = TIP) =>
		`review-code: ${polarity} range:${BASE}..${tip} content:2f1a9c4e0b7d — the child's range`;

	const runChild = (script: ReadonlyArray<Scripted>) =>
		Effect.runPromise(
			Effect.provide(
				runChildVerdicts({
					issue: 4312,
					repo: null,
					env: {CLAUDE_PIPELINE_REPO: "o/r", ...GH_TOKEN_ENV} as Record<string, string | undefined>,
				}),
				fakeSeams(script).layer,
			),
		);

	it("folds the standing verdict per gate with the range it was formed over", async () => {
		const out = await runChild([
			[ISSUE, issue()],
			[CHILD_COMMENTS, comments({id: 8801, body: `${range("FAIL")}\n\nthe finding's text`})],
		]);
		expect(out.code).toBe(0);
		const answered = JSON.parse(out.stdout);
		expect(answered.rows).toMatchObject([
			{
				gate: "review-code",
				polarity: "FAIL",
				range: `${BASE}..${TIP}`,
				commentId: 8801,
				kind: "range-marker",
			},
		]);
		expect(answered.rows[0].body).toContain("the finding's text");
	});

	it("counts one round per graded tip, so two gates over one range stay one round", async () => {
		const out = await runChild([
			[ISSUE, issue()],
			[
				CHILD_COMMENTS,
				comments(
					{id: 1, body: range("FAIL")},
					{id: 2, body: `governance: FAIL range:${BASE}..${TIP} content:2f1a9c4e0b7d — no`},
					{id: 3, body: range("FAIL", NEXT_TIP)},
				),
			],
		]);
		expect(JSON.parse(out.stdout).rounds).toBe(2);
	});

	it("reports no clearance and says why — a grant is recorded against a base branch", async () => {
		const out = await runChild([
			[ISSUE, issue()],
			[CHILD_COMMENTS, comments({id: 8801, body: range("PASS")})],
		]);
		expect(JSON.parse(out.stdout).clearances).toEqual([]);
		expect(out.stderr.join("\n")).toContain("a child has no PR");
	});

	it("refuses a PR on 7 — its verdicts are head-bound", async () => {
		const out = await runChild([[ISSUE, issue({pull_request: {}})]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("drop --issue and pass --pr");
	});

	it("refuses an unreadable comment page on 11 — never 'none'", async () => {
		const out = await runChild([
			[ISSUE, issue()],
			[CHILD_COMMENTS, GATEWAY],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});
});
