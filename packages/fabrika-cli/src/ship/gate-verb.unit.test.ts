import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	comments,
	ENV,
	files,
	HEAD,
	OTHER_HEAD,
	pull,
	reviews,
	unexhaustedPage,
} from "./fixtures.test-support.ts";
import {inForce, requiredWithFloor, runGate} from "./gate-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4321\/comments/;
const REVIEWS = /^gh api -i repos\/o\/r\/pulls\/4321\/reviews/;
const ACL = /^gh api repos\/o\/r\/collaborators\/[^ ]+\/permission/;

/** The default two-file diff, under no governance root — the floor stays off unless a test asks. */
const ORDINARY = [FILES, files("apps/web/src/a.ts", "apps/web/src/b.ts")] as const;
/** A fabrika-tree diff: `claude-plugins/` is one of the four governance roots. */
const FABRIKA_TREE = [
	FILES,
	files("claude-plugins/fabrika/skills/ship/SKILL.md", "apps/web/src/b.ts"),
] as const;

const options = {
	pr: 4321,
	sha: HEAD,
	require: ["review-code"] as ReadonlyArray<string>,
	cp: false,
	repo: null,
	json: false,
	env: ENV,
};

/**
 * `ORDINARY` is appended, not prepended: `fakeShell` resolves on the FIRST matching pattern, so a
 * test that scripts its own file list still wins and every other test reads an ordinary diff.
 */
const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runGate({...options, ...overrides}), fakeShell([...script, ORDINARY]).layer),
	);

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
		expect(out.stderr.at(-1)).toContain("is not a gateable namespace");
	});

	it("admits --require governance and gates on it like any other namespace (#5199)", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[COMMENTS, comments()],
				[REVIEWS, reviews()],
			],
			{require: ["governance"]},
		);
		expect(out.code).not.toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe([`gate\tblocked\t${HEAD}`, "ns\tgovernance\tabsent\t-", ""].join("\n"));
	});

	// This was the round-2 tripwire, asserting the same posted marker read `absent` while
	// `verdict-marker`'s NAMESPACE_PREFIXES could not carry the namespace. #5199's surface change 2
	// widened it, so the true behaviour is the one asserted now: an authorized, head-bound
	// `governance` PASS satisfies the namespace. Without this the gate requires `governance` (from
	// `ship scope`) and nothing can ever satisfy it — a permanent block on every governance-root PR.
	it("satisfies the namespace from a posted governance PASS marker (#5199 surface change 2)", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[COMMENTS, comments({id: 1, body: marker("governance", "PASS", HEAD)})],
				[REVIEWS, reviews()],
				[ACL, okOut("write")],
			],
			{require: ["governance"]},
		);
		expect(out.stdout).toBe(
			[`gate\tsatisfied\t${HEAD}`, "ns\tgovernance\tpass\tmarker", ""].join("\n"),
		);
	});

	it("blocks on a posted governance FAIL rather than passing it — the widening carries both polarities", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[COMMENTS, comments({id: 1, body: marker("governance", "FAIL", HEAD)})],
				[REVIEWS, reviews()],
				[ACL, okOut("write")],
			],
			{require: ["governance"]},
		);
		expect(out.stdout).toBe(
			[`gate\tblocked\t${HEAD}`, "ns\tgovernance\tfail\tmarker", ""].join("\n"),
		);
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

	it("refuses a truncated changed-file read on 13 — the floor may not rest on it", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 9})],
			[FILES, files("claude-plugins/fabrika/skills/ship/SKILL.md")],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});

	it("refuses a zero-file diff on 7 — a conjunction over an empty diff proves nothing", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 0})],
			[FILES, files()],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});

// The #5036 unit: `--require` was caller-asserted end to end, so a fabrika-tree PR shipped with no
// governance verdict simply by never passing the flag. The floor is what makes that unrepresentable.
describe("runGate — the governance floor (#5036)", () => {
	it("requires governance on a fabrika-tree diff the caller never asked to gate on it", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				FABRIKA_TREE,
				[COMMENTS, comments({id: 1, body: marker("review-skill", "PASS", HEAD)})],
				[REVIEWS, reviews()],
				[ACL, okOut("write")],
			],
			{require: ["review-skill"]},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`gate\tblocked\t${HEAD}`,
				"ns\treview-skill\tpass\tmarker",
				"ns\tgovernance\tabsent\t-",
				"",
			].join("\n"),
		);
		expect(
			out.stderr.some((line) => line.includes("the diff's floor, not the caller's option")),
		).toBe(true);
	});

	it("satisfies the floored namespace from a posted governance PASS", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 2})],
				FABRIKA_TREE,
				[
					COMMENTS,
					comments(
						{id: 1, body: marker("review-skill", "PASS", HEAD)},
						{id: 2, body: marker("governance", "PASS", HEAD)},
					),
				],
				[REVIEWS, reviews()],
				[ACL, okOut("write")],
			],
			{require: ["review-skill"]},
		);
		expect(out.stdout).toBe(
			[
				`gate\tsatisfied\t${HEAD}`,
				"ns\treview-skill\tpass\tmarker",
				"ns\tgovernance\tpass\tmarker",
				"",
			].join("\n"),
		);
	});

	it("counts the floored namespace in --json `required`, so coverage cannot narrow silently", async () => {
		const out = await run(
			[[PULL, pull()], FABRIKA_TREE, [COMMENTS, comments()], [REVIEWS, reviews()]],
			{require: ["review-skill"], json: true},
		);
		expect(JSON.parse(out.stdout)).toMatchObject({outcome: "blocked", required: 2});
	});

	it("leaves a diff under no governance root gated exactly as before", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				ORDINARY,
				[COMMENTS, comments({id: 1, body: marker("review-code", "PASS", HEAD)})],
				[REVIEWS, reviews()],
				[ACL, okOut("write")],
			],
			{require: ["review-code"]},
		);
		expect(out.stdout).toBe(
			[`gate\tsatisfied\t${HEAD}`, "ns\treview-code\tpass\tmarker", ""].join("\n"),
		);
	});
});

describe("requiredWithFloor", () => {
	it("adds governance on a governance-root diff", () => {
		const result = requiredWithFloor(
			["review-skill"],
			["claude-plugins/fabrika/skills/ship/SKILL.md"],
		);
		expect(result.required).toEqual(["review-skill", "governance"]);
		expect(result.floored).toEqual(["governance"]);
	});

	it("adds nothing when the caller already asked for it — the floor never duplicates", () => {
		const result = requiredWithFloor(["governance"], [".decisions/0001-a.md"]);
		expect(result.required).toEqual(["governance"]);
		expect(result.floored).toEqual([]);
	});

	it("leaves an ordinary diff's required set untouched", () => {
		const result = requiredWithFloor(["review-code"], ["apps/web/src/a.ts"]);
		expect(result.required).toEqual(["review-code"]);
		expect(result.floored).toEqual([]);
	});
});
