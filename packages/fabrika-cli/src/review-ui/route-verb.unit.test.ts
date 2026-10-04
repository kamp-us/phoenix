/**
 * `review-ui route` — the escape from the unfillable namespace, and the fences that keep it from
 * becoming a second verdict path.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {
	fakeSeams,
	type HttpReply,
	type Scripted,
	uiConfiguredOnPlatform,
} from "../fakes.test-support.ts";
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
	HAND_CHECK_INADMISSIBLE,
	NO_PREVIEW_MODE_UNMET,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	PREVIEW_EXISTS,
	READBACK_MISMATCH,
	STALE_TREE,
	TEXT_REVIEW_UNMET,
	ZERO_SCOPE,
} from "./codes.ts";
import {type RouteOptions, runRoute} from "./route-verb.ts";

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
	const seams = fakeSeams([...script, ...uiConfiguredOnPlatform()]);
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
	// A clean end, not a refusal: the exit code alone separates it from an unread PR, so a caller
	// never parses the sentence to pick between ROUTED-ELSEWHERE and CANT-SEE.
	it("answers none on 0 when the diff raises no ui class, posting nothing", async () => {
		const {outcome, requests} = await run([
			[PULL, pull({changed: 1})],
			[FILES, files("packages/fabrika-cli/src/wire/registry.ts")],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "none",
			namespace: "review-ui",
			sha: HEAD,
			uiFiles: 0,
		});
		expect(requests.some((request) => CREATE.test(request) || PATCH.test(request))).toBe(false);
	});

	it("keeps an absent or closed PR on 7, distinct from the no-ui-class answer", async () => {
		const absent = await run([[PULL, {status: 404, body: '{"message":"Not Found"}'}]]);
		const closed = await run([[PULL, pull({state: "closed"})]]);
		const clean = await run([
			[PULL, pull({changed: 1})],
			[FILES, files("packages/fabrika-cli/src/wire/registry.ts")],
		]);
		expect(absent.outcome.code).toBe(ZERO_SCOPE);
		expect(closed.outcome.code).toBe(ZERO_SCOPE);
		expect(clean.outcome.code).not.toBe(ZERO_SCOPE);
		expect(absent.outcome.stdout).toBe("");
		expect(closed.outcome.stdout).toBe("");
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
			// The one comparison is the merge base the class config is read at, never a range.
			expect(requests.filter((request) => request.includes("/compare/"))).toEqual([
				expect.stringMatching(/\/compare\/main\.\.\.[0-9a-f]+\?per_page=1$/),
			]);
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

describe("review-ui route --no-preview", () => {
	const run = (script: ReadonlyArray<Scripted>, overrides: Partial<RouteOptions> = {}) => {
		const seams = fakeSeams([...script, ...uiConfiguredOnPlatform()]);
		return Effect.runPromise(
			Effect.provide(runRoute({...options, ...overrides}), seams.layer),
		).then((outcome) => ({outcome, requests: seams.requests, bodies: seams.bodies}));
	};
	const TRUNK = /^GET \S+api\.github\.com\/repos\/o\/r$/;
	const CODEOWNERS = /contents\/\.github\/CODEOWNERS\?ref=main$/;
	const MEMBERS = /^GET \S+\/orgs\/o\/teams\/control-plane\/members/;
	const OWNER = "owner";
	const HAND_CHECK_ID = 7001;
	const SHOT = "![row](https://github.com/user-attachments/assets/1234)";

	const handCheck = (author = OWNER, body = `Hand-checked at ${HEAD}.\n\n${SHOT}`) => ({
		id: HAND_CHECK_ID,
		user: {login: author},
		created_at: "2026-09-29T00:00:00Z",
		updated_at: "2026-09-29T00:00:00Z",
		body,
	});

	const roster: ReadonlyArray<Scripted> = [
		[TRUNK, served({default_branch: "main"})],
		[CODEOWNERS, {status: 200, body: "/packages/ @o/control-plane\n"}],
		[MEMBERS, served([{login: OWNER}])],
	];

	const flagged = (basis: "hand-check" | "skip", tail = ""): string =>
		`routed-elsewhere: review-ui @ ${HEAD} basis:${basis} — ${CLAUSE}\n\n${BODY.replace(/\n+$/, "")}\n${tail}`;

	const HAND_CHECK_TAIL = `\nHand-check: comment ${HAND_CHECK_ID} by ${OWNER}, at ${HEAD}.\n`;

	const script = (
		comments: ReadonlyArray<unknown>,
		readback: string,
		extra: ReadonlyArray<Scripted> = [],
	): ReadonlyArray<Scripted> => [
		[PULL, pull()],
		[FILES, PROSE_UI],
		[USER, served({login: "reviewer"})],
		[COMMENTS, served(comments)],
		...extra,
		[CREATE, {status: 201, body: JSON.stringify({id: 512399, html_url: URL})}],
		[READBACK, served({body: readback})],
	];

	const under = (
		mode: "require-render" | "hand-check" | "skip",
		handCheckRef: string | null = null,
	) => ({
		noPreview: {rules: [{paths: ["apps/site/**"], mode}], handCheck: handCheckRef},
	});

	it("posts a record flagged basis:skip where every ui file resolves to skip", async () => {
		const {outcome, requests, bodies} = await run(script([], flagged("skip")), under("skip"));
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({answer: "routed", basis: "skip"});
		const at = requests.findIndex((request) => CREATE.test(request));
		expect(bodies[at]).toContain(`review-ui @ ${HEAD} basis:skip —`);
		expect(outcome.stderr.join("\n")).toContain("reviewUi.whenNoPreview resolves skip");
	});

	it("refuses on 21 where a file needs a render, naming it and posting nothing", async () => {
		const {outcome, requests} = await run(script([], flagged("skip")), {
			noPreview: {
				rules: [{paths: ["apps/site/src/flags/**"], mode: "skip"}],
				handCheck: null,
			},
		});
		expect(outcome.code).toBe(NO_PREVIEW_MODE_UNMET);
		expect(outcome.stderr.join("\n")).toContain("apps/site/src/styles/lint.config.json");
		expect(outcome.stderr.join("\n")).toContain("require-render");
		expect(outcome.stderr.join("\n")).toContain("- `apps/site/src/styles/lint.config.json`");
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("refuses on 21 under require-render even with a hand-check named", async () => {
		const {outcome} = await run(
			script([handCheck(), textVerdict("PASS")], flagged("hand-check", HAND_CHECK_TAIL), roster),
			under("require-render", String(HAND_CHECK_ID)),
		);
		expect(outcome.code).toBe(NO_PREVIEW_MODE_UNMET);
	});

	it("refuses on 21 under hand-check when no owner's hand-check at this head is on the PR", async () => {
		const {outcome, requests} = await run(
			script(
				[handCheck("agent"), handCheck(OWNER, `Hand-checked at ${MOVED}.\n\n${SHOT}`)],
				flagged("hand-check"),
				roster,
			),
			under("hand-check"),
		);
		expect(outcome.code).toBe(NO_PREVIEW_MODE_UNMET);
		expect(outcome.stderr.join("\n")).toContain("no comment on it is an owner's hand-check");
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("prints the note on 21, naming the fact an owner's comment at this head failed", async () => {
		const textOnly = {...handCheck(OWNER, `Looks right at ${HEAD}.`), id: 7002};
		const {outcome} = await run(
			script([textOnly], flagged("hand-check"), roster),
			under("hand-check"),
		);
		expect(outcome.code).toBe(NO_PREVIEW_MODE_UNMET);
		const stderr = outcome.stderr.join("\n");
		expect(stderr).toContain(`Hand-checked at ${HEAD}.`);
		expect(stderr).toContain("#issuecomment-7002) by `owner` names the right commit but has no");
	});

	it("leaves its own earlier note out of the comments that came close", async () => {
		const first = await run(script([], flagged("hand-check"), roster), under("hand-check"));
		const lines = first.outcome.stderr;
		const note = lines.slice(lines.indexOf("----- note begins -----") + 1, -2).join("\n");
		const {outcome} = await run(
			script([handCheck(OWNER, note)], flagged("hand-check"), roster),
			under("hand-check"),
		);
		expect(outcome.code).toBe(NO_PREVIEW_MODE_UNMET);
		expect(outcome.stderr.join("\n")).not.toContain("came close");
	});

	it("finds the owner's hand-check itself when none is named", async () => {
		const {outcome, requests, bodies} = await run(
			script([handCheck(), textVerdict("PASS")], flagged("hand-check", HAND_CHECK_TAIL), roster),
			under("hand-check"),
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			basis: "hand-check",
			handCheck: HAND_CHECK_ID,
		});
		const at = requests.findIndex((request) => CREATE.test(request));
		expect(bodies[at]).toContain(`Hand-check: comment ${HAND_CHECK_ID} by ${OWNER}`);
	});

	it("posts a record flagged basis:hand-check over an owner's screenshots at this head", async () => {
		const {outcome, requests, bodies} = await run(
			script([handCheck(), textVerdict("PASS")], flagged("hand-check", HAND_CHECK_TAIL), roster),
			under("hand-check", `https://forge.example/o/r/pull/6326#issuecomment-${HAND_CHECK_ID}`),
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "routed",
			basis: "hand-check",
			textReview: "pass",
		});
		const at = requests.findIndex((request) => CREATE.test(request));
		expect(bodies[at]).toContain("basis:hand-check");
		expect(bodies[at]).toContain(`Hand-check: comment ${HAND_CHECK_ID} by ${OWNER}`);
	});

	it("refuses on 22 when the hand-check is not an owner's", async () => {
		const {outcome, requests} = await run(
			script([handCheck("agent"), textVerdict("PASS")], flagged("hand-check"), roster),
			under("hand-check", String(HAND_CHECK_ID)),
		);
		expect(outcome.code).toBe(HAND_CHECK_INADMISSIBLE);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("refuses on 22 when the hand-check names another head", async () => {
		const {outcome} = await run(
			script(
				[handCheck(OWNER, `Hand-checked at ${MOVED}.\n\n${SHOT}`), textVerdict("PASS")],
				flagged("hand-check"),
				roster,
			),
			under("hand-check", String(HAND_CHECK_ID)),
		);
		expect(outcome.code).toBe(HAND_CHECK_INADMISSIBLE);
		expect(outcome.stderr.join("\n")).toContain("does not name the head");
	});

	it("refuses on 20 when a hand-check route has no text verdict at this head", async () => {
		const {outcome} = await run(
			script([handCheck()], flagged("hand-check"), roster),
			under("hand-check", String(HAND_CHECK_ID)),
		);
		expect(outcome.code).toBe(TEXT_REVIEW_UNMET);
	});

	const preview = (body: string) => ({
		id: 7100,
		user: {login: "kampus-bot"},
		created_at: "2026-09-29T00:00:00Z",
		updated_at: "2026-09-29T00:00:00Z",
		body,
	});
	const deployed = (sha: string, app = "web") =>
		`<!-- preview-deploy:${app} -->\n- **${app}** — Stage \`pr-6326\` → https://pr-6326-${app}.example.test <sub>(${sha})</sub>`;

	it("refuses on 23 where the PR announces a preview at this head, under skip or hand-check", async () => {
		const skipped = await run(script([preview(deployed(HEAD))], flagged("skip")), under("skip"));
		expect(skipped.outcome.code).toBe(PREVIEW_EXISTS);
		expect(skipped.outcome.stderr.join("\n")).toContain("run review-ui render");
		expect(skipped.requests.some((request) => CREATE.test(request))).toBe(false);

		const checked = await run(
			script(
				[preview(deployed(HEAD)), handCheck(), textVerdict("PASS")],
				flagged("hand-check"),
				roster,
			),
			under("hand-check", String(HAND_CHECK_ID)),
		);
		expect(checked.outcome.code).toBe(PREVIEW_EXISTS);
		expect(checked.requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("refuses on 23 where the announced preview lags the head, or names several apps", async () => {
		const behind = await run(script([preview(deployed(MOVED))], flagged("skip")), under("skip"));
		expect(behind.outcome.code).toBe(PREVIEW_EXISTS);
		expect(behind.outcome.stderr.join("\n")).toContain("wait for it to redeploy");

		const two = await run(
			script([preview(`${deployed(HEAD, "api")}\n${deployed(HEAD)}`)], flagged("skip")),
			under("skip"),
		);
		expect(two.outcome.code).toBe(PREVIEW_EXISTS);
	});

	const noPreviewMarker = (sha: string) =>
		"<!-- preview-deploy -->\n### No preview deploy\n" +
		`<!-- preview-deploy:none head:${sha} -->\n` +
		"- No preview deploy for this PR — its diff touches no deploy-relevant path, " +
		"so no preview stack was minted and `e2e` is not applicable. " +
		`<sub>(${sha.slice(0, 7)})</sub>`;

	it("routes per whenNoPreview over the workflow's no-preview marker at this head", async () => {
		const skipped = await run(
			script([preview(noPreviewMarker(HEAD))], flagged("skip")),
			under("skip"),
		);
		expect(skipped.outcome.code).toBe(0);
		expect(JSON.parse(skipped.outcome.stdout)).toMatchObject({answer: "routed", basis: "skip"});

		const required = await run(
			script([preview(noPreviewMarker(HEAD))], flagged("skip")),
			under("require-render"),
		);
		expect(required.outcome.code).toBe(NO_PREVIEW_MODE_UNMET);
		expect(required.requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("refuses on 11 where the no-preview marker names another head, posting nothing", async () => {
		const {outcome, requests} = await run(
			script([preview(noPreviewMarker(MOVED))], flagged("skip")),
			under("skip"),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("refuses on 11 where the preview announcement does not read", async () => {
		const {outcome, requests} = await run(
			script([preview("<!-- preview-deploy:web -->\nno url here")], flagged("skip")),
			under("skip"),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("refuses --verified-at beside --no-preview on 10, before any read", async () => {
		const {outcome, requests} = await run([], {...under("skip"), verifiedAt: HEAD});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(requests).toEqual([]);
	});

	it("refuses a --hand-check that names no comment on 10, before any read", async () => {
		const {outcome, requests} = await run([], under("hand-check", "row screenshot"));
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(requests).toEqual([]);
	});
});
