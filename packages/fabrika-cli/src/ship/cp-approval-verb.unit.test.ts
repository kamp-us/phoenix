import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {latestPerAuthor, runCpApproval} from "./cp-approval-verb.ts";
import {
	CODEOWNERS,
	comments,
	ENV,
	files,
	HEAD,
	OTHER_HEAD,
	pull,
	reviews,
	unexhaustedPage,
} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;
const OWNERS = /contents\/\.github\/CODEOWNERS/;
const CONFIG = /contents\/\.fabrika\.jsonc/;
const COMPARE = /^gh api repos\/o\/r\/compare\//;
const ROSTER = /^gh api --paginate orgs\/kamp-us\/teams\/control-plane\/members/;
const REVIEWS = /^gh api -i repos\/o\/r\/pulls\/4321\/reviews/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4321\/comments/;

const members = (...logins: ReadonlyArray<string>): ExecResult =>
	okOut(JSON.stringify(logins.map((login) => ({login}))));

const options = {pr: 4321, sha: HEAD, repo: null, json: false, env: ENV};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runCpApproval({...options, ...overrides}), fakeShell(script).layer),
	);

/** The §CP path set, so the boundary classifies `control-plane` and the table actually runs. */
const CP_FILES = files(".github/workflows/ci.yml", "README.md");

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
		const out = await run([
			[PULL, pull()],
			[FILES, files("apps/web/src/App.tsx", "README.md")],
			[OWNERS, okOut(CODEOWNERS)],
			[COMPARE, okOut("0")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("cp-approval\tn/a\tnot-control-plane\n");
	});

	it("discharges on a non-author member's APPROVED review bound to --sha", async () => {
		const out = await run([
			[PULL, pull({author: "usirin"})],
			[FILES, CP_FILES],
			[OWNERS, okOut(CODEOWNERS)],
			[COMPARE, okOut("0")],
			[ROSTER, members("usirin", "cansirin")],
			[REVIEWS, reviews({login: "cansirin", state: "APPROVED", commit: HEAD})],
		]);
		expect(out.stdout).toBe(`cp-approval\tdischarge\tmember-approval:cansirin@${HEAD}\n`);
	});

	it("refuses an unexhausted review read on 13 — an approval could sit on an unread page", async () => {
		const out = await run([
			[PULL, pull({author: "usirin"})],
			[FILES, CP_FILES],
			[OWNERS, okOut(CODEOWNERS)],
			[COMPARE, okOut("0")],
			[ROSTER, members("usirin", "cansirin")],
			[REVIEWS, unexhaustedPage()],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"ship cp-approval: the review read never reached a terminal page — pagination is unexhausted, so an approval could sit on a page nobody read; refusing the partial sweep.",
		);
	});

	it("does NOT discharge on an approval bound to a superseded head (#3769)", async () => {
		const out = await run([
			[PULL, pull({author: "usirin"})],
			[FILES, CP_FILES],
			[OWNERS, okOut(CODEOWNERS)],
			[COMPARE, okOut("0")],
			[ROSTER, members("usirin", "cansirin")],
			[REVIEWS, reviews({login: "cansirin", state: "APPROVED", commit: OTHER_HEAD})],
		]);
		expect(out.stdout).toBe("cp-approval\tstop\tawaiting-approval\n");
	});

	it("never counts the author's own approval", async () => {
		const out = await run([
			[PULL, pull({author: "usirin"})],
			[FILES, CP_FILES],
			[OWNERS, okOut(CODEOWNERS)],
			[COMPARE, okOut("0")],
			[ROSTER, members("usirin", "cansirin")],
			[REVIEWS, reviews({login: "usirin", state: "APPROVED", commit: HEAD})],
		]);
		expect(out.stdout).toBe("cp-approval\tstop\tawaiting-approval\n");
	});

	it("takes the sole-owner-authored arm through the head-bound self-approval marker", async () => {
		const out = await run([
			[PULL, pull({author: "usirin", comments: 1})],
			[FILES, CP_FILES],
			[OWNERS, okOut(CODEOWNERS)],
			[COMPARE, okOut("0")],
			[ROSTER, members("usirin")],
			[
				COMMENTS,
				comments({id: 1, author: "usirin", body: `control-plane-self-approval @ ${HEAD}`}),
			],
		]);
		expect(out.stdout).toBe(`cp-approval\tdischarge\tself-approval-marker@${HEAD}\n`);
	});

	it("stops on zero-owners when CODEOWNERS names no resolvable owner at all", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, files("a/b.ts", "README.md")],
			[OWNERS, okOut("/a/ owner@example.test\n")],
			[COMPARE, okOut("0")],
		]);
		expect(out.stdout).toBe("cp-approval\tstop\tzero-owners\n");
	});

	it("discharges on an individual @login owner's approval, with no roster read at all (#6299)", async () => {
		const out = await run([
			[PULL, pull({author: "usirin"})],
			[FILES, files("a/b.ts", "README.md")],
			[OWNERS, okOut("/a/ @cansirin\n")],
			[COMPARE, okOut("0")],
			[REVIEWS, reviews({login: "cansirin", state: "APPROVED", commit: HEAD})],
		]);
		expect(out.stdout).toBe(`cp-approval\tdischarge\tmember-approval:cansirin@${HEAD}\n`);
	});

	it("takes the self-approval path when the sole individual owner authored the PR", async () => {
		const out = await run([
			[PULL, pull({author: "usirin", comments: 1})],
			[FILES, files("a/b.ts", "README.md")],
			[OWNERS, okOut("/a/ @usirin\n")],
			[COMPARE, okOut("0")],
			[
				COMMENTS,
				comments({
					id: 1,
					author: "usirin",
					body: `control-plane-self-approval @ ${HEAD}`,
				}),
			],
		]);
		expect(out.stdout).toBe(`cp-approval\tdischarge\tself-approval-marker@${HEAD}\n`);
	});

	it("unions an individual owner with a team roster — GitHub's any-listed-owner semantics", async () => {
		const out = await run([
			[PULL, pull({author: "usirin"})],
			[FILES, CP_FILES],
			[OWNERS, okOut(`/.github/ @kamp-us/control-plane @outsider\n`)],
			[COMPARE, okOut("0")],
			[ROSTER, members("usirin")],
			[REVIEWS, reviews({login: "outsider", state: "APPROVED", commit: HEAD})],
		]);
		expect(out.stdout).toBe(`cp-approval\tdischarge\tmember-approval:outsider@${HEAD}\n`);
	});

	it("never answers n/a on a proven-absent CODEOWNERS — an empty boundary is the `unknown` hold", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, CP_FILES],
			[OWNERS, errOut("gh: Not Found (HTTP 404)")],
			[COMPARE, okOut("0")],
		]);
		expect(out.stdout).not.toContain("not-control-plane");
		expect(out.stdout).toBe("cp-approval\tstop\tzero-owners\n");
	});

	it("refuses a failed boundary read on 11 whatever the repo's config says (ADR 0220 §4)", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, CP_FILES],
			[OWNERS, errOut("gh: Bad gateway (HTTP 502)")],
			[CONFIG, okOut('{"unreadableCodeowners": "ship"}')],
			[COMPARE, okOut("0")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).not.toContain("not-control-plane");
	});

	it("refuses an UNREADABLE roster on 11 — never `stop`, never `awaiting approval` (#4223)", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, CP_FILES],
			[OWNERS, okOut(CODEOWNERS)],
			[COMPARE, okOut("0")],
			[ROSTER, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('the discharge is UNRESOLVED, not "awaiting approval"');
	});

	it("notices base drift so the approval is not spent on a head that must move (#4477)", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, files("apps/web/src/App.tsx", "README.md")],
			[OWNERS, okOut(CODEOWNERS)],
			[COMPARE, okOut("7")],
		]);
		expect(
			out.stderr.some((line) => line.includes("base-drift: head is 7 commits behind main")),
		).toBe(true);
	});

	it("refuses a truncated file sweep on 13", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 9})],
			[FILES, files("README.md")],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses a closed PR on 7 — nothing to discharge", async () => {
		const out = await run([[PULL, pull({state: "closed"})]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("ship cp-approval: PR #4321 is closed — nothing to discharge.");
	});

	it("refuses a malformed --sha rather than treating it as a pattern (#4223)", async () => {
		const out = await run([[PULL, pull()]], {sha: ""});
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toContain("never a pattern that matches every head");
	});
});
