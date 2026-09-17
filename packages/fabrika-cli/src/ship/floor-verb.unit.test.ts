/**
 * The floor's whole value is that it refuses on a verdict that is WRONG, not only on one that is
 * MISSING — a guard that fires on absence alone keeps letting the wrong verdict through. So the
 * battery below mutates the verdict four ways that all *look* like a governance verdict is there —
 * FAIL at head, PASS on another head, PASS from an author without write+, a marker in a neighbouring
 * namespace — and asserts each one still reds.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted, unconfigured} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PULL_FILES_CAP} from "../io/pulls.ts";
import {
	GOVERNANCE_FLOOR_UNMET,
	INCOMPLETE_SCAN,
	PRECONDITION_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {comments, ENV, files, HEAD, OTHER_HEAD, pull} from "./fixtures.test-support.ts";
import {runFloor} from "./floor-verb.ts";

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
const FILES = /^GET \S+\/repos\/o\/r\/pulls\/4321\/files\?/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4321\/comments\?/;
const REVIEWS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/pulls\/4321\/reviews/;
const ACL = /^GET \S+\/repos\/o\/r\/collaborators\/[^/]+\/permission$/;

/** No native review on the PR — the floor is a marker question, so every test reads the same page. */
const NO_REVIEWS: readonly [RegExp, HttpReply] = [REVIEWS, {status: 200, body: "[]"}];

/** A canned `ExecResult` fixture as the body of a 200 — the same payload, off the served seam. */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

/** The permission endpoint's own shape — a `{permission}` record, not a bare word. */
const permissionServed = (permission: string): HttpReply => ({
	status: 200,
	body: JSON.stringify({permission}),
});

/** A fabrika-tree diff — `claude-plugins/` is one of the shipped governance roots. */
const FABRIKA_TREE = [
	FILES,
	served(files("claude-plugins/fabrika/skills/ship/SKILL.md", "apps/site/src/b.ts")),
] as const;

const options = {pr: 4321, sha: HEAD, repo: null, json: false, cwd: "/repo", env: ENV};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runFloor({...options, ...overrides}),
			Layer.merge(fakeSeams([...script, NO_REVIEWS]).layer, unconfigured),
		),
	);

const marker = (namespace: string, polarity: string, sha: string): string =>
	`${namespace}: ${polarity} @ ${sha} — the clause`;

/** A governance-root PR carrying exactly one comment, with the ACL answer the test wants. */
const withVerdict = (body: string, permission = "write") =>
	[
		[PULL, served(pull({comments: 1}))],
		FABRIKA_TREE,
		[COMMENTS, served(comments({id: 1, body}))],
		[ACL, permissionServed(permission)],
	] as const;

describe("runFloor", () => {
	it("is satisfied on a head-bound PASS from an authorized author", async () => {
		const out = await run([...withVerdict(marker("governance", "PASS", HEAD))]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`floor\tsatisfied\t${HEAD}\nns\tgovernance\tpass\n`);
	});

	it("answers n/a — not satisfied — when the diff touches no governance root", async () => {
		const out = await run([
			[PULL, served(pull())],
			[FILES, served(files("apps/site/src/a.ts", "apps/site/src/b.ts"))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`floor\tn/a\t${HEAD}\nns\tgovernance\t-\n`);
		expect(out.stderr.join("\n")).toContain("not a discharged verdict");
	});

	it("reds when the verdict is ABSENT — no verdict at this head at all", async () => {
		const out = await run([
			[PULL, served(pull({comments: 0}))],
			FABRIKA_TREE,
			[COMMENTS, served(comments())],
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
			[PULL, served(pull({comments: 1}))],
			FABRIKA_TREE,
			[COMMENTS, served(comments({id: 1, body: marker("governance", "PASS", HEAD)}))],
			[ACL, {status: 403, body: '{"message":"Forbidden"}'}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("fails closed when the changed-file list cannot be read", async () => {
		const out = await run([
			[PULL, served(pull())],
			[FILES, {status: 502, body: "{}"}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain('never "n/a"');
	});

	// The declared count is GitHub's own, computed against a base cached at the last push, so a list
	// short of it proved nothing about completeness. It used to refuse at 13 and red the floor check.
	it("reports a short file list in `scanned` and answers the floor anyway (#9322)", async () => {
		const out = await run([
			[PULL, served(pull({changedFiles: 9}))],
			[FILES, served(files("apps/site/src/a.ts"))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`floor\tn/a\t${HEAD}`);
		expect(out.stderr.join("\n")).toContain(
			"GitHub's file list for #4321 holds 1 paths against the 9 its own pull-request record declares",
		);
	});

	// The empty read is the seat that survives the retirement, driven by the list rather than the
	// declared count: a zero can never render as a satisfied floor.
	it("refuses an empty file list even where the record declares files (#9322)", async () => {
		const out = await run([
			[PULL, served(pull({changedFiles: 9}))],
			[FILES, served(files())],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.join("\n")).toContain(
			"ship floor: PR #4321 has zero changed files — whether it touches a governance root is unanswerable.",
		);
	});

	// The ceiling is the truncation pagination cannot catch: GitHub stops serving files at 3000 and
	// ends the Link chain there exactly as a complete read ends, so `n/a` would be answered over a
	// list that never carried the governance root.
	it("refuses a file list at the 3000-file ceiling on 13 (#9322)", async () => {
		const out = await run([
			[PULL, served(pull({changedFiles: PULL_FILES_CAP}))],
			[
				FILES,
				served(files(...Array.from({length: PULL_FILES_CAP}, (_, i) => `apps/site/src/f${i}.ts`))),
			],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.join("\n")).toContain(
			"ship floor: GitHub's file list for #4321 came back at its 3000-file ceiling, so the list is provably partial — a governance root could sit in the part the platform never served.",
		);
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
