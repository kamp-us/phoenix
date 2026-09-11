/**
 * `review-ui route` — the escape from the unfillable namespace, and the fences that keep it from
 * becoming a second verdict path.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {COMPARE_FILE_CAP} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {read as readVerdict} from "../wire/verdict-marker.ts";
import {
	EMPTY_STDIN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_TREE,
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

	it("refuses on 11 rather than deriving the class from a truncated file list", async () => {
		const {outcome} = await run([
			[PULL, pull({changed: 400})],
			[FILES, PROSE_UI],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("truncated read");
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
			[COMMENTS, {status: 200, body: "[]"}],
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
					[COMMENTS, {status: 200, body: "[]"}],
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
