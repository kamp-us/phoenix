import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, linkNext, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {latestPerAuthor, runCpApproval} from "./cp-approval-verb.ts";
import {CODEOWNERS, comments, ENV, files, HEAD, OTHER_HEAD, pull} from "./fixtures.test-support.ts";

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
const FILES = /^GET \S+\/repos\/o\/r\/pulls\/4321\/files\?/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4321\/comments\?/;

const OWNERS = /contents\/\.github\/CODEOWNERS/;
const CONFIG = /contents\/\.fabrika\.jsonc/;
const COMPARE = /\/repos\/o\/r\/compare\//;
const ROSTER = /\/orgs\/kamp-us\/teams\/control-plane\/members/;
const REVIEWS = /\/repos\/o\/r\/pulls\/4321\/reviews/;

const members = (...logins: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(logins.map((login) => ({login}))),
});

/** The compare read the base-drift notice is derived from: how far the head sits behind. */
const behind = (commits: number): HttpReply => ({
	status: 200,
	body: JSON.stringify({behind_by: commits}),
});

/**
 * One served page of the reviews read.
 *
 * No `Link` header is a terminal page — the completeness proof the verb refuses without. `next: true`
 * is the page that never terminates, so the read can never prove it saw every approval.
 */
const reviewPage = (
	rows: ReadonlyArray<{login: string; state: string; commit: string; at?: string}>,
	options: {next?: boolean} = {},
): HttpReply => ({
	status: 200,
	body: JSON.stringify(
		rows.map((row) => ({
			user: {login: row.login},
			state: row.state,
			commit_id: row.commit,
			submitted_at: row.at ?? "2026-08-08T00:00:00Z",
		})),
	),
	headers:
		options.next === true
			? linkNext("https://api.github.com/repos/o/r/pulls/4321/reviews?per_page=100&page=2")
			: undefined,
});

const options = {pr: 4321, sha: HEAD, repo: null, json: false, env: ENV};

/** A canned `ExecResult` fixture as the body of a 200 — the same payload, off the served seam. */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

const run = (
	shell: ReadonlyArray<Scripted>,
	http: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runCpApproval({...options, ...overrides}), fakeSeams([...shell, ...http]).layer),
	);

/** The §CP path set, so the boundary classifies `control-plane` and the table actually runs. */
const CP_FILES = served(files(".github/workflows/ci.yml", "README.md"));

const OWNED: HttpReply = {status: 200, body: CODEOWNERS};

describe("latestPerAuthor", () => {
	it("resolves after the pages are joined, so a later revocation beats an earlier approval", () => {
		const resolved = latestPerAuthor([
			{login: "a", submittedAt: "2026-08-08T01:00:00Z", state: "APPROVED"},
			{login: "a", submittedAt: "2026-08-08T02:00:00Z", state: "DISMISSED"},
		]);
		expect(resolved).toEqual([
			{login: "a", submittedAt: "2026-08-08T02:00:00Z", state: "DISMISSED"},
		]);
	});
});

describe("runCpApproval", () => {
	it("answers n/a on a proven-ordinary PR, computed from the same cp derivation `ship scope` prints", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[FILES, served(files("apps/web/src/App.tsx", "README.md"))],
			],
			[
				[OWNERS, OWNED],
				[COMPARE, behind(0)],
			],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("cp-approval\tn/a\tnot-control-plane\n");
	});

	it("discharges on a non-author member's APPROVED review bound to --sha", async () => {
		const out = await run(
			[
				[PULL, served(pull({author: "usirin"}))],
				[FILES, CP_FILES],
			],
			[
				[OWNERS, OWNED],
				[COMPARE, behind(0)],
				[ROSTER, members("usirin", "cansirin")],
				[REVIEWS, reviewPage([{login: "cansirin", state: "APPROVED", commit: HEAD}])],
			],
		);
		expect(out.stdout).toBe(`cp-approval\tdischarge\tmember-approval:cansirin@${HEAD}\n`);
	});

	it("refuses an unexhausted review read on 13 — an approval could sit on an unread page", async () => {
		const out = await run(
			[
				[PULL, served(pull({author: "usirin"}))],
				[FILES, CP_FILES],
			],
			[
				[OWNERS, OWNED],
				[COMPARE, behind(0)],
				[ROSTER, members("usirin", "cansirin")],
				[REVIEWS, reviewPage([], {next: true})],
			],
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"ship cp-approval: the review read never reached a terminal page — pagination is unexhausted, so an approval could sit on a page nobody read; refusing the partial sweep.",
		);
	});

	it("does NOT discharge on an approval bound to a superseded head (#3769)", async () => {
		const out = await run(
			[
				[PULL, served(pull({author: "usirin"}))],
				[FILES, CP_FILES],
			],
			[
				[OWNERS, OWNED],
				[COMPARE, behind(0)],
				[ROSTER, members("usirin", "cansirin")],
				[REVIEWS, reviewPage([{login: "cansirin", state: "APPROVED", commit: OTHER_HEAD}])],
			],
		);
		expect(out.stdout).toBe("cp-approval\tstop\tawaiting-approval\n");
	});

	it("never counts the author's own approval", async () => {
		const out = await run(
			[
				[PULL, served(pull({author: "usirin"}))],
				[FILES, CP_FILES],
			],
			[
				[OWNERS, OWNED],
				[COMPARE, behind(0)],
				[ROSTER, members("usirin", "cansirin")],
				[REVIEWS, reviewPage([{login: "usirin", state: "APPROVED", commit: HEAD}])],
			],
		);
		expect(out.stdout).toBe("cp-approval\tstop\tawaiting-approval\n");
	});

	it("takes the sole-owner-authored arm through the head-bound self-approval marker", async () => {
		const out = await run(
			[
				[PULL, served(pull({author: "usirin", comments: 1}))],
				[FILES, CP_FILES],
				[
					COMMENTS,
					served(
						comments({id: 1, author: "usirin", body: `control-plane-self-approval @ ${HEAD}`}),
					),
				],
			],
			[
				[OWNERS, OWNED],
				[COMPARE, behind(0)],
				[ROSTER, members("usirin")],
			],
		);
		expect(out.stdout).toBe(`cp-approval\tdischarge\tself-approval-marker@${HEAD}\n`);
	});

	it("stops on zero-owners when CODEOWNERS names no resolvable owner at all", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[FILES, served(files("a/b.ts", "README.md"))],
			],
			[
				[OWNERS, {status: 200, body: "/a/ owner@example.test\n"}],
				[COMPARE, behind(0)],
			],
		);
		expect(out.stdout).toBe("cp-approval\tstop\tzero-owners\n");
	});

	it("discharges on an individual @login owner's approval, with no roster read at all (#6299)", async () => {
		const out = await run(
			[
				[PULL, served(pull({author: "usirin"}))],
				[FILES, served(files("a/b.ts", "README.md"))],
			],
			[
				[OWNERS, {status: 200, body: "/a/ @cansirin\n"}],
				[COMPARE, behind(0)],
				[REVIEWS, reviewPage([{login: "cansirin", state: "APPROVED", commit: HEAD}])],
			],
		);
		expect(out.stdout).toBe(`cp-approval\tdischarge\tmember-approval:cansirin@${HEAD}\n`);
	});

	it("takes the self-approval path when the sole individual owner authored the PR", async () => {
		const out = await run(
			[
				[PULL, served(pull({author: "usirin", comments: 1}))],
				[FILES, served(files("a/b.ts", "README.md"))],
				[
					COMMENTS,
					served(
						comments({
							id: 1,
							author: "usirin",
							body: `control-plane-self-approval @ ${HEAD}`,
						}),
					),
				],
			],
			[
				[OWNERS, {status: 200, body: "/a/ @usirin\n"}],
				[COMPARE, behind(0)],
			],
		);
		expect(out.stdout).toBe(`cp-approval\tdischarge\tself-approval-marker@${HEAD}\n`);
	});

	it("unions an individual owner with a team roster — GitHub's any-listed-owner semantics", async () => {
		const out = await run(
			[
				[PULL, served(pull({author: "usirin"}))],
				[FILES, CP_FILES],
			],
			[
				[OWNERS, {status: 200, body: "/.github/ @kamp-us/control-plane @outsider\n"}],
				[COMPARE, behind(0)],
				[ROSTER, members("usirin")],
				[REVIEWS, reviewPage([{login: "outsider", state: "APPROVED", commit: HEAD}])],
			],
		);
		expect(out.stdout).toBe(`cp-approval\tdischarge\tmember-approval:outsider@${HEAD}\n`);
	});

	it("never answers n/a on a proven-absent CODEOWNERS — an empty boundary is the `unknown` hold", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[FILES, CP_FILES],
			],
			[
				[OWNERS, {status: 404, body: '{"message":"Not Found"}'}],
				[COMPARE, behind(0)],
			],
		);
		expect(out.stdout).not.toContain("not-control-plane");
		expect(out.stdout).toBe("cp-approval\tstop\tzero-owners\n");
	});

	it("refuses a failed boundary read on 11 whatever the repo's config says (ADR 0220 §4)", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[FILES, CP_FILES],
			],
			[
				[OWNERS, {status: 502, body: '{"message":"Bad gateway"}'}],
				[CONFIG, {status: 200, body: '{"unreadableCodeowners": "ship"}'}],
				[COMPARE, behind(0)],
			],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).not.toContain("not-control-plane");
	});

	it("refuses an UNREADABLE roster on 11 — never `stop`, never `awaiting approval` (#4223)", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[FILES, CP_FILES],
			],
			[
				[OWNERS, OWNED],
				[COMPARE, behind(0)],
				[ROSTER, {status: 502, body: '{"message":"Bad gateway"}'}],
			],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('the discharge is UNRESOLVED, not "awaiting approval"');
	});

	it("notices base drift so the approval is not spent on a head that must move (#4477)", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				[FILES, served(files("apps/web/src/App.tsx", "README.md"))],
			],
			[
				[OWNERS, OWNED],
				[COMPARE, behind(7)],
			],
		);
		expect(
			out.stderr.some((line) => line.includes("base-drift: head is 7 commits behind main")),
		).toBe(true);
	});

	it("refuses a truncated file sweep on 13", async () => {
		const out = await run(
			[
				[PULL, served(pull({changedFiles: 9}))],
				[FILES, served(files("README.md"))],
			],
			[],
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses a closed PR on 7 — nothing to discharge", async () => {
		const out = await run([[PULL, served(pull({state: "closed"}))]], []);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("ship cp-approval: PR #4321 is closed — nothing to discharge.");
	});

	it("refuses a malformed --sha rather than treating it as a pattern (#4223)", async () => {
		const out = await run([[PULL, served(pull())]], [], {sha: ""});
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toContain("never a pattern that matches every head");
	});
});
