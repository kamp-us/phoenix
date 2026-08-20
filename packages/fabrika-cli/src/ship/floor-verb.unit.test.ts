/**
 * The floor's whole value is that it refuses on a verdict that is WRONG, not only on one that is
 * MISSING — a guard that fires on absence alone is the class #5416 and #4887 keep re-landing. So the
 * battery below mutates the verdict four ways that all *look* like a governance verdict is there —
 * FAIL at head, PASS on another head, PASS from an author without write+, a marker in a neighbouring
 * namespace — and asserts each one still reds.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, unconfigured} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	GOVERNANCE_FLOOR_UNMET,
	INCOMPLETE_SCAN,
	PRECONDITION_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {comments, ENV, files, HEAD, OTHER_HEAD, pull, reviews} from "./fixtures.test-support.ts";
import {runFloor} from "./floor-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4321\/comments/;
const REVIEWS = /^gh api -i repos\/o\/r\/pulls\/4321\/reviews/;
const ACL = /^gh api repos\/o\/r\/collaborators\/[^ ]+\/permission/;

/** A fabrika-tree diff — `claude-plugins/` is one of the shipped governance roots. */
const FABRIKA_TREE = [
	FILES,
	files("claude-plugins/fabrika/skills/ship/SKILL.md", "apps/web/src/b.ts"),
] as const;

const options = {pr: 4321, sha: HEAD, repo: null, json: false, cwd: "/repo", env: ENV};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runFloor({...options, ...overrides}),
			Layer.merge(fakeShell([...script]).layer, unconfigured),
		),
	);

const marker = (namespace: string, polarity: string, sha: string): string =>
	`${namespace}: ${polarity} @ ${sha} — the clause`;

/** A governance-root PR carrying exactly one comment, with the ACL answer the test wants. */
const withVerdict = (body: string, permission = "write") =>
	[
		[PULL, pull({comments: 1})],
		FABRIKA_TREE,
		[COMMENTS, comments({id: 1, body})],
		[REVIEWS, reviews()],
		[ACL, okOut(permission)],
	] as const;

describe("runFloor", () => {
	it("is satisfied on a head-bound PASS from an authorized author", async () => {
		const out = await run([...withVerdict(marker("governance", "PASS", HEAD))]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`floor\tsatisfied\t${HEAD}\nns\tgovernance\tpass\n`);
	});

	it("answers n/a — not satisfied — when the diff touches no governance root", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, files("apps/web/src/a.ts", "apps/web/src/b.ts")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`floor\tn/a\t${HEAD}\nns\tgovernance\t-\n`);
		expect(out.stderr.join("\n")).toContain("not a discharged verdict");
	});

	it("reds when the verdict is ABSENT — the #5293/#5333 shape", async () => {
		const out = await run([
			[PULL, pull({comments: 0})],
			FABRIKA_TREE,
			[COMMENTS, comments()],
			[REVIEWS, reviews()],
		]);
		expect(out.code).toBe(GOVERNANCE_FLOOR_UNMET);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("is absent");
	});

	it("reds when the verdict is WRONG: a FAIL at this very head", async () => {
		const out = await run([...withVerdict(marker("governance", "FAIL", HEAD))]);
		expect(out.code).toBe(GOVERNANCE_FLOOR_UNMET);
		expect(out.stderr.join("\n")).toContain("is fail");
	});

	it("reds when the verdict is WRONG: a PASS bound to another head", async () => {
		const out = await run([...withVerdict(marker("governance", "PASS", OTHER_HEAD))]);
		expect(out.code).toBe(GOVERNANCE_FLOOR_UNMET);
		expect(out.stderr.join("\n")).toContain("is stale");
	});

	it("reds when the verdict is WRONG: a head-bound PASS from an author without write+", async () => {
		const out = await run([...withVerdict(marker("governance", "PASS", HEAD), "read")]);
		expect(out.code).toBe(GOVERNANCE_FLOOR_UNMET);
		expect(out.stderr.join("\n")).toContain("is absent");
	});

	it("reds when the verdict is WRONG: the PASS is in a neighbouring namespace", async () => {
		const out = await run([...withVerdict(marker("review-skill", "PASS", HEAD))]);
		expect(out.code).toBe(GOVERNANCE_FLOOR_UNMET);
		expect(out.stderr.join("\n")).toContain("is absent");
	});

	it("fails closed when the ACL cannot be read — UNKNOWN is never a discharge", async () => {
		const out = await run([
			[PULL, pull({comments: 1})],
			FABRIKA_TREE,
			[COMMENTS, comments({id: 1, body: marker("governance", "PASS", HEAD)})],
			[REVIEWS, reviews()],
			[ACL, errOut("HTTP 403")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("fails closed when the changed-file list cannot be read", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, errOut("HTTP 502")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain('never "n/a"');
	});

	it("refuses a short file list — a governance root could sit in the part nobody read", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 9})],
			[FILES, files("apps/web/src/a.ts")],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses a zero-file diff rather than answering n/a (ADR 0092)", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 0})],
			[FILES, files()],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
	});

	it("emits the same two outcomes as JSON", async () => {
		const out = await run([...withVerdict(marker("governance", "PASS", HEAD))], {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			outcome: "satisfied",
			sha: HEAD,
			namespace: "governance",
			state: "pass",
			scanned: 2,
		});
	});
});
