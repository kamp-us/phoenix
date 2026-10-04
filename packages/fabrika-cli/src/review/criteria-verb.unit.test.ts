import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {emit, markedIssue, rulingUrl, scopeDigest} from "../wire/decision-ruling.ts";
import {markerTime} from "../wire/grill-marker.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runCriteria} from "./criteria-verb.ts";
import {issue} from "./fixtures.test-support.ts";

const ISSUE = /GET .*\/repos\/o\/r\/issues\/4287(\?|$)/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4287\/comments\?/;
const TRUNK = /^GET .*\/repos\/o\/r$/;
const CODEOWNERS = /contents\/\.github\/CODEOWNERS\?ref=main$/;
const MEMBERS = /^GET .*\/orgs\/o\/teams\/control-plane\/members/;

const RULER = "usirin";
const RULING_COMMENT = 900001;
const REPO = "o/r";
const RULING_URL = `https://github.com/${REPO}/issues/4287#issuecomment-${RULING_COMMENT}`;

/** A canned payload as the platform serves it — the fixtures speak `ExecResult`, the seam HTTP. */
const served = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});
const json = (body: unknown): HttpReply => ({status: 200, body: JSON.stringify(body)});

/** The three reads `controlPlaneRoster` makes, resolving to a one-account control plane. */
const ROSTER: ReadonlyArray<Scripted> = [
	[TRUNK, json({default_branch: "main"})],
	[CODEOWNERS, {status: 200, body: "/packages/fabrika-cli/ @o/control-plane\n"}],
	[MEMBERS, json([{login: RULER}])],
];

/** One page of comments, each `[id, author, body, written?]` — written an hour before the marker's stamp unless the case says otherwise. */
const comments = (...rows: ReadonlyArray<readonly [number, string, string, string?]>): HttpReply =>
	json(
		rows.map(([id, author, body, written = "2026-09-20T05:00:00Z"]) => ({
			id,
			user: {login: author},
			created_at: written,
			updated_at: written,
			body,
		})),
	);

const AFTER_RULING = "2026-09-20T07:00:00Z";
const commentUrl = (id: number): string =>
	`https://github.com/${REPO}/issues/4287#issuecomment-${id}`;

/** The marker `decision rule` posts, over whatever criterion the case says it replaces. */
const marker = (supersedes: string = ""): string =>
	emit({
		issue: markedIssue(4287) ?? (0 as never),
		digest: scopeDigest("4d90e1bb27ac") ?? ("" as never),
		ruling: rulingUrl(RULING_URL) ?? ("" as never),
		supersedes: supersedes === "" ? null : (Number(supersedes) as never),
		at: markerTime("2026-09-20T06:00:00Z") ?? ("" as never),
	});

const RULING_COMMENTS = comments(
	[RULING_COMMENT, RULER, "The first delay is `base * 2`, not `base`."],
	[900002, RULER, marker()],
);

const options = {
	issue: 4287,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(runCriteria({...options, ...overrides}), fakeSeams(script).layer),
	);

/** The ordinary board: the issue, its comments, and the roster the author gate resolves. */
const board = (commentPage: HttpReply = comments(), body?: string): ReadonlyArray<Scripted> => [
	[ISSUE, served(issue(body))],
	[COMMENTS, commentPage],
	...ROSTER,
];

describe("runCriteria", () => {
	it("prints the body block with no ruling standing — today's answer, one source column on", async () => {
		const out = await run(board());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				"criteria\t2",
				"rulings\t0",
				"body\topen\tthe first retry delay equals `base`",
				"body\tchecked\tthe retry guide documents the delay table",
				"",
			].join("\n"),
		);
	});

	it("folds a standing ruling into the set, carrying the founder's own words", async () => {
		const out = await run(board(RULING_COMMENTS));
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[1]).toBe("rulings\t1");
		expect(out.stdout).toContain(
			`ruling\topen\tThe first delay is \`base * 2\`, not \`base\`.\t${RULING_URL}`,
		);
		expect(out.stderr.join("\n")).toContain("2 body criteria plus 1 standing ruling(s)");
	});

	/**
	 * The author gate is the whole authority the marker carries: posting one takes nothing but the
	 * ability to comment, so a read honouring the format alone would let any agent token in the
	 * pipeline write a constraint the review gate then enforces.
	 */
	it("does not fold a conforming marker from an off-roster author, and counts it", async () => {
		const out = await run(
			board(
				comments(
					[RULING_COMMENT, RULER, "The first delay is `base * 2`."],
					[900002, "some-agent", marker()],
				),
			),
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[1]).toBe("rulings\t0");
		expect(out.stderr.join("\n")).toContain("1 from an account off that roster");
	});

	/**
	 * The ACL is three reads, and on an issue whose every comment is a machine marker with no ruling
	 * among them there is nothing to check against it.
	 */
	it("resolves no roster while every comment is a machine marker and none is a ruling", async () => {
		const out = await run(
			[
				[ISSUE, served(issue())],
				[COMMENTS, comments([900001, RULER, "build-claim: build:s:n · 2026-09-20T05:00:00Z"])],
			],
			{json: true},
		);
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("the control-plane roster was not resolved");
		expect(JSON.parse(out.stdout)).not.toHaveProperty("unmarked");
	});

	/**
	 * An owner who wrote a rule as a plain comment used to read exactly like an issue nobody ruled
	 * on. The comment is still no ruling; what changes is that the verb points at it.
	 */
	describe("comments by a control-plane account that no ruling marker records", () => {
		it("names one on an issue carrying no marker at all", async () => {
			const out = await run(board(comments([900010, RULER, "Use `base * 3` instead."])), {
				json: true,
			});
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout)).toMatchObject({
				rulings: 0,
				unmarked: {state: "counted", count: 1, comments: [commentUrl(900010)]},
			});
			expect(out.stderr.join("\n")).toContain(
				`1 comment(s) by a control-plane account on #4287 carry no ruling marker: ${commentUrl(900010)}`,
			);
		});

		it("names one newer than the marked ruling, and not the comment that ruling cites", async () => {
			const out = await run(
				board(
					comments(
						[RULING_COMMENT, RULER, "The first delay is `base * 2`, not `base`."],
						[900002, RULER, marker()],
						[900010, RULER, "Changed my mind: `base * 3`.", AFTER_RULING],
					),
				),
				{json: true},
			);
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout)).toMatchObject({
				rulings: 1,
				unmarked: {state: "counted", count: 1, comments: [commentUrl(900010)]},
			});
			expect(out.stderr.join("\n")).toContain(
				"are newer than the newest standing ruling and carry no ruling marker",
			);
		});

		it("leaves one older than the marked ruling out, and prints what it always printed", async () => {
			const out = await run(
				board(
					comments(
						[900010, RULER, "An early thought, before the ruling."],
						[RULING_COMMENT, RULER, "The first delay is `base * 2`, not `base`."],
						[900002, RULER, marker()],
					),
				),
				{json: true},
			);
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout)).not.toHaveProperty("unmarked");
			expect(out.stderr.join("\n")).not.toContain("carry no ruling marker");
		});

		it("never counts a machine marker or an off-roster author, however new", async () => {
			const out = await run(
				board(
					comments(
						[RULING_COMMENT, RULER, "The first delay is `base * 2`, not `base`."],
						[900002, RULER, marker()],
						[900011, RULER, "build-claim: build:s:n · 2026-09-20T07:00:00Z", AFTER_RULING],
						[900012, RULER, "<!-- fabrika-triage-claim session=s -->\nclaimed", AFTER_RULING],
						[900013, RULER, "**review: PASS @ a1b2c3d — criteria met**", AFTER_RULING],
						[900014, "some-agent", "I think the delay should be longer.", AFTER_RULING],
					),
				),
				{json: true},
			);
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout)).not.toHaveProperty("unmarked");
		});

		/** A roster that did not resolve says nothing about who commented, so it is never a zero. */
		it("answers unknown, on exit 0, when the roster does not resolve and no marker stands", async () => {
			const out = await run(
				[
					[ISSUE, served(issue())],
					[COMMENTS, comments([900010, RULER, "Use `base * 3` instead."])],
					[TRUNK, {status: 502, body: "{}"}],
				],
				{json: true},
			);
			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout)).toMatchObject({rulings: 0, unmarked: {state: "unknown"}});
			expect(out.stderr.join("\n")).toContain("is UNKNOWN, never zero");
		});
	});

	it("counts a drifted marker rather than reading it as nobody having ruled", async () => {
		const drifted = "decision-ruled: #4287 @ NOTADIGEST · ruling:x · 2026-09-20T06:00:00Z\n";
		const out = await run(board(comments([900002, RULER, drifted])));
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("1 drifted marker(s) disregarded");
	});

	it("reports the body criterion a ruling supersedes, and keeps the row", async () => {
		const out = await run(
			board(
				comments(
					[RULING_COMMENT, RULER, "The first delay is `base * 2`, not `base`."],
					[900002, RULER, marker("1")],
				),
			),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("body\tsuperseded\tthe first retry delay equals `base`");
		expect(out.stderr.join("\n")).toContain("1 body row(s) superseded");
	});

	it("names a supersedes the block has no row for, rather than grading around it", async () => {
		const out = await run(
			board(comments([RULING_COMMENT, RULER, "Ruled."], [900002, RULER, marker("9")])),
		);
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("a ruling names supersedes:9");
	});

	it("emits the record with --json", async () => {
		const out = await run(board(RULING_COMMENTS), {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "criteria",
			issue: 4287,
			count: 2,
			rulings: 1,
		});
		expect(JSON.parse(out.stdout).criteria.at(-1)).toMatchObject({
			source: "ruling",
			ruling: RULING_URL,
		});
	});

	it("reads a CLOSED issue's contract anyway, with a notice — a re-review is legitimate", async () => {
		const out = await run([
			[ISSUE, served(issue(undefined, "closed"))],
			[COMMENTS, comments()],
			...ROSTER,
		]);
		expect(out.code).toBe(0);
		expect(out.stderr[0]).toContain("#4287 is closed");
	});

	it("refuses an issue proven absent on 7", async () => {
		const out = await run([[ISSUE, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("review criteria: issue #4287 not found in o/r.");
	});

	it("refuses an ABSENT block on 7, naming the wire reason", async () => {
		const out = await run(board(comments(), "no contract here"));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("carries no acceptance-criteria block — absent:");
		expect(out.stderr.at(-1)).toContain("Grade nothing; the contract is missing.");
	});

	it("reds a DRIFTED heading as malformed — never as `there were none`", async () => {
		const out = await run(board(comments(), "## Acceptance Criteria\n\n- [ ] a thing\n"));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("is malformed:");
		expect(out.stderr.at(-1)).toContain('not "there were none"');
	});

	it("gives absent and malformed the same code and never the same message", async () => {
		const absent = await run(board(comments(), "nothing"));
		const malformed = await run(board(comments(), "## Acceptance Criteria\n\n- [ ] x\n"));
		expect(absent.code).toBe(malformed.code);
		expect(absent.stderr.at(-1)).not.toBe(malformed.stderr.at(-1));
	});

	it("refuses an unreadable issue on 11 — whether a block exists is UNKNOWN", async () => {
		const out = await run([[ISSUE, {status: 502, body: "{}"}]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("whether a block exists is UNKNOWN");
	});

	/**
	 * The fail-open direction this verb exists to close, one layer down: reporting "no ruling stands"
	 * off a roster that did not resolve grades a PR against a spec the founder may already have moved.
	 */
	it("refuses on 11 when the roster does not resolve — never the body alone", async () => {
		const out = await run([
			[ISSUE, served(issue())],
			[COMMENTS, RULING_COMMENTS],
			[TRUNK, {status: 502, body: "{}"}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("the graded set is UNKNOWN, never the body alone");
	});

	it("refuses on 11 when the comments do not read", async () => {
		const out = await run([
			[ISSUE, served(issue())],
			[COMMENTS, {status: 502, body: "{}"}],
			...ROSTER,
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the graded set is UNKNOWN, never the body alone");
	});
});
