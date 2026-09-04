import {readFileSync} from "node:fs";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, okOut, once, type Scripted} from "../fakes.test-support.ts";
import {
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SURVIVOR_UNATTESTED,
	WORKTREE_HELD,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	comments,
	GH_TOKEN_ENV,
	LANE_UUID,
	marker,
	NONCE,
	SIBLING_NONCE,
	SIBLING_UUID,
	served,
} from "./fixtures.test-support.ts";
import {RETIRED_PREFIX} from "./retire-branch.ts";
import {runRetireBranch} from "./retire-branch-verb.ts";

const BRANCHES = /^git for-each-ref --format=%\(refname:short\) refs\/heads$/;
const PRUNE = /^git worktree prune$/;
const TREES = /^git worktree list --porcelain$/;
const RENAME = /^git branch -m /;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/6296\/comments/;
const PERM = /^GET \S+\/repos\/o\/r\/collaborators\/agent\/permission/;

const LIVE = `build/6296-editor-focus-loss-${NONCE}`;
const STALE = `build/6296-editor-focus-loss-${SIBLING_NONCE}`;
const RETIRED = `${RETIRED_PREFIX}6296-editor-focus-loss-${SIBLING_NONCE}`;

const options = {
	number: 6296,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", ...GH_TOKEN_ENV} as Record<string, string | undefined>,
};

const refs = (...names: ReadonlyArray<string>) => okOut([...names, "main"].join("\n"));

/** `git worktree list --porcelain`, as blocks of `worktree`/`HEAD`/`branch` lines. */
const trees = (...held: ReadonlyArray<{path: string; branch: string}>) =>
	okOut(
		held
			.map((tree) => `worktree ${tree.path}\nHEAD 0000000\nbranch refs/heads/${tree.branch}\n`)
			.join("\n"),
	);

/** One authorized claim marker on #6296, carrying the live lane's nonce. */
const CLAIMED: ReadonlyArray<Scripted> = [
	[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
	[PERM, served({permission: "write"})],
];

const run = (script: ReadonlyArray<Scripted>) => {
	const shell = fakeSeams(script);
	return Effect.runPromise(Effect.provide(runRetireBranch(options), shell.layer)).then((out) => ({
		out,
		calls: shell.calls,
	}));
};

describe("runRetireBranch — the attested survivor", () => {
	it("renames the unattested branch out of build/ and reads the rename back", async () => {
		const {out, calls} = await run([
			[once(BRANCHES), refs(STALE, LIVE)],
			...CLAIMED,
			[PRUNE, okOut("")],
			[TREES, trees({path: "/repo", branch: "main"})],
			[RENAME, okOut("")],
			[BRANCHES, refs(RETIRED, LIVE)],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "retired",
			number: 6296,
			survivor: LIVE,
			retired: [{from: STALE, to: RETIRED}],
		});
		expect(calls).toContain(`git branch -m ${STALE} ${RETIRED}`);
	});

	it("proves no worktree holds a branch it is about to rename, BEFORE renaming it", async () => {
		const {calls} = await run([
			[once(BRANCHES), refs(STALE, LIVE)],
			...CLAIMED,
			[PRUNE, okOut("")],
			[TREES, trees({path: "/repo", branch: "main"})],
			[RENAME, okOut("")],
			[BRANCHES, refs(RETIRED, LIVE)],
		]);

		expect(calls.findIndex((line) => TREES.test(line))).toBeLessThan(
			calls.findIndex((line) => RENAME.test(line)),
		);
	});

	it("refuses a held branch and names the act that clears the hold", async () => {
		const {out, calls} = await run([
			[BRANCHES, refs(STALE, LIVE)],
			...CLAIMED,
			[PRUNE, okOut("")],
			[TREES, trees({path: "/trees/agent-a9bd", branch: STALE})],
		]);

		expect(out.code).toBe(WORKTREE_HELD);
		expect(out.stderr.join("\n")).toContain("fabrika build retire 6296");
		expect(calls.some((line) => RENAME.test(line))).toBe(false);
	});
});

describe("runRetireBranch — a survivor nobody attests to is never guessed", () => {
	it("renames nothing when no authorized marker carries a candidate's lane nonce", async () => {
		const {out, calls} = await run([
			[BRANCHES, refs(STALE, LIVE)],
			[COMMENTS, comments()],
		]);

		expect(out.code).toBe(SURVIVOR_UNATTESTED);
		expect(out.stderr.join("\n")).toMatch(/no authorized claim marker/);
		expect(calls.some((line) => RENAME.test(line))).toBe(false);
	});

	it("counts no marker from an account below write — content is not authority (ADR 0055)", async () => {
		const {out} = await run([
			[BRANCHES, refs(STALE, LIVE)],
			[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
			[PERM, served({permission: "read"})],
		]);

		expect(out.code).toBe(SURVIVOR_UNATTESTED);
	});

	it("renames nothing when two candidates are each attested by a live claim", async () => {
		const {out, calls} = await run([
			[BRANCHES, refs(STALE, LIVE)],
			[
				COMMENTS,
				comments(
					{id: 1, body: marker("s-9f2e", LANE_UUID)},
					{id: 2, body: marker("s-other", SIBLING_UUID)},
				),
			],
			[PERM, served({permission: "write"})],
		]);

		expect(out.code).toBe(SURVIVOR_UNATTESTED);
		expect(calls.some((line) => RENAME.test(line))).toBe(false);
	});

	it("is UNKNOWN when the claim markers cannot be read — never 'nobody attests'", async () => {
		const {out, calls} = await run([
			[BRANCHES, refs(STALE, LIVE)],
			[COMMENTS, {status: 502, body: '{"message":"Bad gateway"}'}],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toMatch(/never "none of them"/);
		expect(calls.some((line) => RENAME.test(line))).toBe(false);
	});
});

describe("runRetireBranch — fewer than two branches is not a deadlock", () => {
	it("answers none on a single candidate, reading no board state at all", async () => {
		const {out, calls} = await run([[BRANCHES, refs(LIVE)]]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "none", survivor: LIVE, retired: []});
		expect(calls.some((line) => COMMENTS.test(line))).toBe(false);
	});

	it("is ZERO_SCOPE when no branch in this clone was cut for the child", async () => {
		const {out} = await run([[BRANCHES, refs()]]);

		expect(out.code).toBe(ZERO_SCOPE);
	});

	it("is UNKNOWN when the local branches cannot be read", async () => {
		const {out} = await run([[BRANCHES, errOut("not a git repository")]]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});
});

describe("runRetireBranch — the rename is proven, never reported", () => {
	it("is WRITE_UNKNOWN when git refuses the rename", async () => {
		const {out} = await run([
			[BRANCHES, refs(STALE, LIVE)],
			...CLAIMED,
			[PRUNE, okOut("")],
			[TREES, trees({path: "/repo", branch: "main"})],
			[RENAME, errOut(`a branch named '${RETIRED}' already exists`)],
		]);

		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("is READBACK_MISMATCH when git exits 0 and the old name survives", async () => {
		const {out} = await run([
			[once(BRANCHES), refs(STALE, LIVE)],
			...CLAIMED,
			[PRUNE, okOut("")],
			[TREES, trees({path: "/repo", branch: "main"})],
			[RENAME, okOut("")],
			[BRANCHES, refs(STALE, LIVE)],
		]);

		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.join("\n")).toMatch(/NOT proven/);
	});
});

describe("runRetireBranch — no path deletes a branch (ADR 0324, first binding constraint)", () => {
	// The pin is over the source rather than a run: a delete path that exists but is unreachable in
	// the cases these tests script is exactly the defect the ruling bans, and no fake can prove its
	// absence. Both modules are read whole, so a delete added to either reds this.
	const source = [
		new URL("./retire-branch-verb.ts", import.meta.url),
		new URL("./retire-branch.ts", import.meta.url),
	].map((at) => readFileSync(at, "utf8"));

	it.each([
		["git branch -d", /["'`\s]-d["'`\s,\]]/],
		["git branch -D", /["'`\s]-D["'`\s,\]]/],
		["update-ref -d", /update-ref/],
		["branch --delete", /--delete/],
		["push --delete", /"push"/],
	])("carries no %s", (_name, forbidden) => {
		for (const text of source) expect(text).not.toMatch(forbidden);
	});

	it("reaches git through renameBranch and nothing else that writes a ref", () => {
		const [verb] = source;
		expect(verb).toContain("renameBranch");
		expect(verb).not.toMatch(/execCapture/);
	});
});
