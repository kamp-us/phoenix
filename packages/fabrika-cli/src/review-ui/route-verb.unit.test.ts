/**
 * `review-ui route` — the escape from the unfillable namespace, and the fences that keep it from
 * becoming a second verdict path.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {COMPARE_FILE_CAP, PULL_FILES_CAP} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {emitAdvisory, reviewedHeadLine} from "../review/advisory.ts";
import {
	emit as emitVerdict,
	headSha,
	read as readVerdict,
	clause as toClause,
} from "../wire/verdict-marker.ts";
import {
	EMPTY_STDIN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_TREE,
	TEXT_REVIEW_UNMET,
	ZERO_SCOPE,
} from "./codes.ts";
import {runRoute} from "./route-verb.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const MOVED = "9fe12ab04f5a6b7c8d9e0f1a2b3c4d5e6f708192";
const URL = "https://example.test/pull/6326#issuecomment-512399";
const CLAUSE = "no rendered delta; both files are prose only";

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/6326$/;
const FILES = /^GET \S+\/repos\/o\/r\/pulls\/6326\/files\?/;
const USER = /^GET \S+api\.github\.com\/user$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/6326\/comments\?/;
const CREATE = /^POST \S+\/repos\/o\/r\/issues\/6326\/comments$/;
const PATCH = /^PATCH \S+\/repos\/o\/r\/issues\/comments\/\d+$/;
const READBACK = /^GET \S+\/repos\/o\/r\/issues\/comments\/\d+$/;

const BODY =
	"`shell-keys.ts` rewrites one JSDoc paragraph and the lint config two note strings. No component,\nroute, token or style changed.\n";

const served = (body: unknown): HttpReply => ({status: 200, body: JSON.stringify(body)});

const pull = (shape: {state?: string; head?: string; changed?: number} = {}): HttpReply =>
	served({
		number: 6326,
		state: shape.state ?? "open",
		head: {sha: shape.head ?? HEAD},
		base: {ref: "main"},
		body: "",
		changed_files: shape.changed ?? 2,
		comments: 0,
	});

const files = (...names: ReadonlyArray<string>): HttpReply =>
	served(names.map((filename) => ({filename})));

const PROSE_UI = files(
	"apps/site/src/flags/shell-keys.ts",
	"apps/site/src/styles/lint.config.json",
);

const options = {
	pr: 6326,
	sha: HEAD,
	clause: CLAUSE,
	verifiedAt: null as string | null,
	uiPrefixes: ["apps/site/src/", "apps/desk/src/"],
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
		string,
		string | undefined
	>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
};

/** The bytes the verb composes, so the read-back fixture is never a hand-typed second grammar. */
const composed = (sha = HEAD, clause = CLAUSE): string =>
	`routed-elsewhere: review-ui @ ${sha} — ${clause}\n\n${BODY.replace(/\n+$/, "")}\n`;

/** A `review-code` verdict comment, composed through the wire format the route reads it back with. */
const textVerdict = (polarity: "PASS" | "FAIL", sha = HEAD): Record<string, unknown> => {
	const head = headSha(sha);
	const clause = toClause("merge-ready");
	if (head === null || clause === null) throw new Error(`unusable fixture: ${sha}`);
	return {
		id: 4001,
		user: {login: "reviewer"},
		created_at: "2026-09-14T00:00:00Z",
		updated_at: "2026-09-14T00:00:00Z",
		body: emitVerdict({namespace: "review-code", polarity, sha: head, content: null, clause}),
	};
};

const happy = (): ReadonlyArray<Scripted> => [
	[PULL, pull()],
	[FILES, PROSE_UI],
	[USER, served({login: "reviewer"})],
	[COMMENTS, {status: 200, body: "[]"}],
	[CREATE, {status: 201, body: JSON.stringify({id: 512399, html_url: URL})}],
	[READBACK, served({body: composed()})],
];

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(Effect.provide(runRoute({...options, ...overrides}), seams.layer)).then(
		(outcome) => ({outcome, requests: seams.requests, bodies: seams.bodies}),
	);
};

describe("review-ui route", () => {
	it("posts the head-bound record and reads it back", async () => {
		const {outcome} = await run(happy());
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "routed",
			namespace: "review-ui",
			sha: HEAD,
			uiFiles: 2,
			upsert: "created",
		});
	});

	it("posts bytes the verdict reader refuses to read as a verdict", async () => {
		const {requests, bodies} = await run(happy());
		const at = requests.findIndex((request) => CREATE.test(request));
		expect(bodies[at]).toContain("routed-elsewhere: review-ui @");
		expect(readVerdict(composed())._tag).toBe("Absent");
	});

	it("upserts onto its own prior record rather than stacking a second claim", async () => {
		const {outcome} = await run([
			[PULL, pull()],
			[FILES, PROSE_UI],
			[USER, served({login: "reviewer"})],
			[
				COMMENTS,
				served([
					{
						id: 77,
						user: {login: "reviewer"},
						created_at: "2026-08-19T00:00:00Z",
						updated_at: "2026-08-19T00:00:00Z",
						body: composed(MOVED),
					},
				]),
			],
			[PATCH, served({html_url: URL})],
			[READBACK, served({body: composed()})],
		]);
		expect(JSON.parse(outcome.stdout)).toMatchObject({upsert: "edited"});
	});

	// The whole point of the verb: this is the shape that was unshippable, because `review-ui` had no
	// legal emission for it and `ship gate` blocks on the absence.
	it("refuses on 7 when the diff raises no ui class — there is nothing to route", async () => {
		const {outcome} = await run([
			[PULL, pull({changed: 1})],
			[FILES, files("packages/fabrika-cli/src/wire/registry.ts")],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("raises no ui class");
	});

	// The record's count is computed against a base cached at the last push, so a shortfall against it
	// is the platform disagreeing with itself. Reported, and the route lands.
	it("reports the declared-count disagreement and routes anyway", async () => {
		const {outcome} = await run([[PULL, pull({changed: 400})], ...happy().slice(1)]);
		expect(outcome.code).toBe(0);
		expect(outcome.stderr.join("\n")).toContain("against the 400 its own pull-request record");
	});

	it("refuses on 7 when GitHub serves an empty changed-file list", async () => {
		const {outcome} = await run([
			[PULL, pull({changed: 2})],
			[FILES, files()],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("served no changed files");
	});

	// The ceiling is the one truncation the enumeration cannot rule out on its own, and it can only
	// ever shrink the ui count — so the zero-class refusal would fire on a PR the gate is raising.
	it("refuses on 11 when the file list arrives at the platform's ceiling", async () => {
		const {outcome} = await run([
			[PULL, pull({changed: PULL_FILES_CAP})],
			[FILES, files(...Array.from({length: PULL_FILES_CAP}, (_, i) => `packages/x/f${i}.ts`))],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain(`${PULL_FILES_CAP}-file ceiling`);
	});

	it("refuses on 12 when the live head moved past --sha", async () => {
		const {outcome} = await run([[PULL, pull({head: MOVED})]]);
		expect(outcome.code).toBe(STALE_TREE);
	});

	it("refuses a blank clause on 10 — a route with no reason records nothing checkable", async () => {
		const {outcome} = await run(happy(), {clause: "   "});
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});

	it("refuses a --sha that is not a head on 10", async () => {
		const {outcome} = await run(happy(), {sha: "not-a-sha"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});

	it("refuses an empty body on 3 — an unexplained route is an assertion nobody can check", async () => {
		const {outcome} = await run(happy(), {
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "  \n"}),
		});
		expect(outcome.code).toBe(EMPTY_STDIN);
	});

	// The hand-verification stands for the record's head exactly when no ui-class file changed in
	// between, so the range decides the evidence rather than a gate's eye.
	describe("--verified-at", () => {
		const VERIFIED = "8efd315a1f2e3d4c5b6a7988776655443322110f";
		const COMPARE = new RegExp(`^GET \\S+/repos/o/r/compare/${VERIFIED}\\.\\.\\.${HEAD}$`);
		const compare = (...names: ReadonlyArray<string>): HttpReply =>
			served({status: "ahead", files: names.map((filename) => ({filename}))});

		const withRange = (reply: HttpReply): ReadonlyArray<Scripted> => [
			[PULL, pull()],
			[FILES, PROSE_UI],
			[COMPARE, reply],
			[USER, served({login: "reviewer"})],
			// A route resting on a hand-verification asserts the text PASS, so one has to stand.
			[COMMENTS, served([textVerdict("PASS")])],
			[CREATE, {status: 201, body: JSON.stringify({id: 512399, html_url: URL})}],
			[READBACK, served({body: composed()})],
		];

		it("posts over a range that raises nothing, and records which head backs it", async () => {
			const {outcome} = await run(
				withRange(compare("packages/fabrika-cli/src/wire/registry.ts", "docs/notes.md")),
				{verifiedAt: VERIFIED},
			);
			expect(outcome.code).toBe(0);
			expect(JSON.parse(outcome.stdout)).toMatchObject({answer: "routed", verifiedAt: VERIFIED});
		});

		it("posts over the empty range where the hand-verification ran at --sha itself", async () => {
			const SAME = new RegExp(`^GET \\S+/repos/o/r/compare/${HEAD}\\.\\.\\.${HEAD}$`);
			const {outcome} = await run(
				[
					[PULL, pull()],
					[FILES, PROSE_UI],
					[SAME, served({status: "identical", total_commits: 0, files: []})],
					[USER, served({login: "reviewer"})],
					[COMMENTS, served([textVerdict("PASS")])],
					[CREATE, {status: 201, body: JSON.stringify({id: 512399, html_url: URL})}],
					[READBACK, served({body: composed()})],
				],
				{verifiedAt: HEAD},
			);
			expect(outcome.code).toBe(0);
			expect(JSON.parse(outcome.stdout)).toMatchObject({verifiedAt: HEAD});
		});

		it("refuses on 12 when the range raises the ui class, naming the files that spent it", async () => {
			const {outcome} = await run(
				withRange(compare("apps/site/src/page/usage.tsx", "docs/notes.md")),
				{verifiedAt: VERIFIED},
			);
			expect(outcome.code).toBe(STALE_TREE);
			expect(outcome.stderr.join("\n")).toContain("apps/site/src/page/usage.tsx");
			expect(outcome.stderr.join("\n")).toContain("is spent");
		});

		it("posts nothing when the range refuses — the record is never written first", async () => {
			const {requests} = await run(withRange(compare("apps/site/src/page/usage.tsx")), {
				verifiedAt: VERIFIED,
			});
			expect(requests.some((request) => CREATE.test(request) || PATCH.test(request))).toBe(false);
		});

		it("refuses on 11 rather than clearing the evidence against a capped comparison", async () => {
			const capped = compare(
				...Array.from({length: COMPARE_FILE_CAP}, (_, at) => `docs/f${at}.md`),
			);
			const {outcome} = await run(withRange(capped), {verifiedAt: VERIFIED});
			expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
			expect(outcome.stderr.join("\n")).toContain("ceiling");
		});

		it("refuses on 11 when the two heads have diverged — the merge-base list is not the range", async () => {
			const diverged = served({
				status: "diverged",
				files: [{filename: "docs/notes.md"}],
			});
			const {outcome, requests} = await run(withRange(diverged), {verifiedAt: VERIFIED});
			expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
			expect(outcome.stderr.join("\n")).toContain("not an ancestor");
			expect(requests.some((request) => CREATE.test(request) || PATCH.test(request))).toBe(false);
		});

		it("refuses on 11 when the comparison cannot be read at all", async () => {
			const {outcome} = await run(withRange({status: 502, body: '{"message":"Bad gateway"}'}), {
				verifiedAt: VERIFIED,
			});
			expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		});

		it("refuses an off-vocabulary --verified-at on 10, before any read", async () => {
			const {outcome, requests} = await run(happy(), {verifiedAt: "not-a-sha"});
			expect(outcome.code).toBe(OFF_VOCABULARY);
			expect(requests).toEqual([]);
		});

		it("reads no range at all when it is omitted", async () => {
			const {outcome, requests} = await run(happy());
			expect(outcome.code).toBe(0);
			expect(JSON.parse(outcome.stdout).verifiedAt).toBeNull();
			expect(requests.some((request) => request.includes("/compare/"))).toBe(false);
		});
	});

	// The clause a hand-verification route carries asserts a text review PASS beside it, and the verb
	// asserted that while reading neither half.
	describe("the text review the record rests on", () => {
		const VERIFIED = "8efd315a1f2e3d4c5b6a7988776655443322110f";
		const COMPARE = new RegExp(`^GET \\S+/repos/o/r/compare/${VERIFIED}\\.\\.\\.${HEAD}$`);
		const CLEAR = served({status: "ahead", files: [{filename: "docs/notes.md"}]});

		const withComments = (...comments: ReadonlyArray<unknown>): ReadonlyArray<Scripted> => [
			[PULL, pull()],
			[FILES, PROSE_UI],
			[USER, served({login: "reviewer"})],
			[COMMENTS, served(comments)],
			[CREATE, {status: 201, body: JSON.stringify({id: 512399, html_url: URL})}],
			[READBACK, served({body: composed()})],
		];

		const onHandVerification = (...comments: ReadonlyArray<unknown>): ReadonlyArray<Scripted> => [
			[PULL, pull()],
			[FILES, PROSE_UI],
			[COMPARE, CLEAR],
			[USER, served({login: "reviewer"})],
			[COMMENTS, served(comments)],
			[CREATE, {status: 201, body: JSON.stringify({id: 512399, html_url: URL})}],
			[READBACK, served({body: composed()})],
		];

		it("refuses on 20 over a standing FAIL at this head, posting nothing", async () => {
			const {outcome, requests} = await run(withComments(textVerdict("FAIL")));
			expect(outcome.code).toBe(TEXT_REVIEW_UNMET);
			expect(outcome.stderr.join("\n")).toContain("review-code stands FAIL");
			expect(requests.some((request) => CREATE.test(request) || PATCH.test(request))).toBe(false);
		});

		it("refuses on 20 over a standing FAIL even where the hand-verification is current", async () => {
			const {outcome} = await run(onHandVerification(textVerdict("FAIL")), {
				verifiedAt: VERIFIED,
			});
			expect(outcome.code).toBe(TEXT_REVIEW_UNMET);
		});

		it("posts over a standing PASS at this head and records which half it read", async () => {
			const {outcome} = await run(withComments(textVerdict("PASS")));
			expect(outcome.code).toBe(0);
			expect(JSON.parse(outcome.stdout)).toMatchObject({answer: "routed", textReview: "pass"});
		});

		// The exception's clause names both halves, so the evidence path is where absence refuses.
		it("refuses on 20 when a hand-verification route has no text verdict at this head", async () => {
			const {outcome, requests} = await run(onHandVerification(), {verifiedAt: VERIFIED});
			expect(outcome.code).toBe(TEXT_REVIEW_UNMET);
			expect(outcome.stderr.join("\n")).toContain("no standing review-code verdict");
			expect(requests.some((request) => CREATE.test(request) || PATCH.test(request))).toBe(false);
		});

		// A prose-only route asserts nothing about the text lane, so it says so rather than blocking.
		it("posts with no text verdict at all, stating that the record asserts none", async () => {
			const {outcome} = await run(withComments());
			expect(outcome.code).toBe(0);
			expect(JSON.parse(outcome.stdout)).toMatchObject({textReview: "absent"});
			expect(outcome.stderr.join("\n")).toContain("asserts nothing about the text lane");
		});

		// A FAIL the head has moved past is not in force - `ship gate` reads it stale too.
		it("does not refuse over a FAIL bound to another head", async () => {
			const {outcome} = await run(withComments(textVerdict("FAIL", MOVED)));
			expect(outcome.code).toBe(0);
			expect(JSON.parse(outcome.stdout)).toMatchObject({textReview: "absent"});
		});

		it("reads the control-plane advisory carrier as the PASS it is", async () => {
			const {outcome} = await run(
				onHandVerification({
					id: 4002,
					user: {login: "owner"},
					created_at: "2026-09-14T00:00:00Z",
					updated_at: "2026-09-14T00:00:00Z",
					body: `${emitAdvisory("review-code", "merge-ready")}\n${reviewedHeadLine(HEAD)}\n`,
				}),
				{verifiedAt: VERIFIED},
			);
			expect(outcome.code).toBe(0);
			expect(JSON.parse(outcome.stdout)).toMatchObject({textReview: "pass"});
		});

		// `ship gate` and `lane prove` both read a `[FAIL]` row inside an advisory as a fail; a third
		// reader that read it as a pass is how one comment cleared this route and refused at the gate.
		it("reads a [FAIL] row inside an advisory as the FAIL its sibling readers read", async () => {
			const {outcome, requests} = await run(
				onHandVerification({
					id: 4003,
					user: {login: "owner"},
					created_at: "2026-09-14T00:00:00Z",
					updated_at: "2026-09-14T00:00:00Z",
					body: `${emitAdvisory("review-code", "merge-ready")}\n${reviewedHeadLine(HEAD)}\n\n- [FAIL] review-code\n`,
				}),
				{verifiedAt: VERIFIED},
			);
			expect(outcome.code).toBe(TEXT_REVIEW_UNMET);
			expect(outcome.stderr.join("\n")).toContain("review-code stands FAIL");
			expect(requests.some((request) => CREATE.test(request) || PATCH.test(request))).toBe(false);
		});
	});

	it("refuses on 9 when the read-back is not the record that was sent", async () => {
		const {outcome} = await run([
			[PULL, pull()],
			[FILES, PROSE_UI],
			[USER, served({login: "reviewer"})],
			[COMMENTS, {status: 200, body: "[]"}],
			[CREATE, {status: 201, body: JSON.stringify({id: 512399, html_url: URL})}],
			[READBACK, served({body: composed(MOVED)})],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});
