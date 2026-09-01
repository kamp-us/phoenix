import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, okOut, once, type Scripted} from "../fakes.test-support.ts";
import {
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WORKTREE_HELD,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	adoptMarker,
	comments,
	GH_TOKEN_ENV,
	issue,
	LANE_UUID,
	marker,
	NONCE,
	NOT_FOUND,
	pull,
	served,
} from "./fixtures.test-support.ts";
import {runRetire} from "./retire-verb.ts";

const PRUNE = /^git worktree prune$/;
const TREES = /^git worktree list --porcelain$/;
const REMOVE = /^git worktree remove /;
const STATUS = /^git -C \S+ status --porcelain$/;
const ADD = /^git -C \S+ add --all$/;
const SALVAGE = /^git -C \S+ commit --no-verify/;
const SELF = /^git rev-parse --path-format=absolute/;
const REVLIST = /^git rev-list --count /;

/**
 * A clean tree needs no salvage — the common case, appended LAST so a test scripting a dirty one
 * wins over it (the fakes resolve by first match).
 */
const CLEAN: ReadonlyArray<Scripted> = [[STATUS, okOut("")]];
const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4312\/comments/;
const PERM = /^GET \S+\/repos\/o\/r\/collaborators\/agent\/permission/;
const WRITE = served({permission: "write"});

const BRANCH = `build/4312-editor-focus-loss-${NONCE}`;
const ORPHAN = "/trees/agent-a9bd";
const HERE = "/trees/agent-self";

const options = {
	number: 4312,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", ...GH_TOKEN_ENV} as Record<string, string | undefined>,
};

/** `git worktree list --porcelain`, as blocks of `worktree`/`HEAD`/`branch` lines. */
const trees = (...held: ReadonlyArray<{path: string; branch: string}>) =>
	okOut(
		held
			.map((tree) => `worktree ${tree.path}\nHEAD 0000000\nbranch refs/heads/${tree.branch}\n`)
			.join("\n"),
	);

/** What `git rev-parse` names for THIS run's checkout — the tree no retirement may remove. */
const here = okOut([`${HERE}/.git`, HERE].join("\n"));

const run = (script: ReadonlyArray<Scripted>) => {
	const shell = fakeSeams([...script, ...CLEAN]);
	return Effect.runPromise(Effect.provide(runRetire(options), shell.layer)).then((out) => ({
		out,
		calls: shell.calls,
	}));
};

/** The board with one authorized claim marker on #4312 and no adopt — the ordinary live lane. */
const CLAIMED: ReadonlyArray<Scripted> = [
	[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
	[PERM, WRITE],
];

describe("runRetire — the terminal-ticket license", () => {
	it("retires the tree holding the branch of a closed issue and reads the removal back", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[once(TREES), trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue({state: "closed"})],
			...CLAIMED,
			[SELF, here],
			[REMOVE, okOut("")],
			[TREES, trees()],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "retired",
			number: 4312,
			retired: [{path: ORPHAN, branch: BRANCH, license: "ticket-terminal", salvaged: false}],
			held: [],
		});
		expect(calls).toContain(`git worktree remove ${ORPHAN}`);
	});

	it("removes WITHOUT --force on any path — ADR 0321 bans it for every tree", async () => {
		const {calls} = await run([
			[PRUNE, okOut("")],
			[once(TREES), trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue({state: "closed"})],
			...CLAIMED,
			[SELF, here],
			[REMOVE, okOut("")],
			[TREES, trees()],
		]);

		expect(calls.filter((line) => REMOVE.test(line))).toEqual([`git worktree remove ${ORPHAN}`]);
		expect(calls.some((line) => line.includes("--force"))).toBe(false);
	});

	it("holds a pull request's tree until the PR MERGED — a closed-unmerged PR can reopen", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: `build/pr-4312-${NONCE}`})],
			[ISSUE, issue({state: "closed", pull_request: {url: "…"}})],
			[/^GET \S+\/repos\/o\/r\/pulls\/4312$/, pull({state: "closed", merged: false})],
			...CLAIMED,
			[SELF, here],
		]);

		expect(out.code).toBe(WORKTREE_HELD);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("retires a merged pull request's tree", async () => {
		const {out} = await run([
			[PRUNE, okOut("")],
			[once(TREES), trees({path: ORPHAN, branch: `build/pr-4312-${NONCE}`})],
			[ISSUE, issue({state: "closed", pull_request: {url: "…"}})],
			[/^GET \S+\/repos\/o\/r\/pulls\/4312$/, pull({state: "closed", merged: true})],
			...CLAIMED,
			[SELF, here],
			[REMOVE, okOut("")],
			[TREES, trees()],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).retired).toHaveLength(1);
	});
});

describe("runRetire — the adopted-session license", () => {
	it("retires the tree when an authorized adopt on the number names the holding lane's session", async () => {
		const {out} = await run([
			[PRUNE, okOut("")],
			[once(TREES), trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue()],
			[
				COMMENTS,
				comments(
					{id: 1, body: marker("s-9f2e", LANE_UUID)},
					{id: 2, body: adoptMarker("s-9f2e", "s-next", LANE_UUID)},
				),
			],
			[PERM, WRITE],
			[SELF, here],
			[REMOVE, okOut("")],
			[TREES, trees()],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).retired).toMatchObject([{license: "session-adopted"}]);
	});

	it("counts no adopt from an account below write — content is not authority (ADR 0055)", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue()],
			[
				COMMENTS,
				comments(
					{id: 1, body: marker("s-9f2e", LANE_UUID)},
					{id: 2, body: adoptMarker("s-9f2e", "s-next", LANE_UUID), author: "drive-by"},
				),
			],
			[PERM, WRITE],
			[/collaborators\/drive-by\/permission/, served({permission: "read"})],
			[SELF, here],
		]);

		expect(out.code).toBe(WORKTREE_HELD);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});
});

describe("runRetire — the unclaimed-lane license", () => {
	/** The board after `build release` consumed the dead builder's marker: nothing holds this lane. */
	const RELEASED: ReadonlyArray<Scripted> = [[COMMENTS, comments()]];

	it("retires an unclaimed tree that is clean and level with the base — the #7027 residue", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[once(TREES), trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue()],
			...RELEASED,
			[SELF, here],
			[REVLIST, okOut("0\n")],
			[REMOVE, okOut("")],
			[TREES, trees()],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "retired",
			retired: [{path: ORPHAN, branch: BRANCH, license: "lane-unclaimed", salvaged: false}],
		});
		expect(calls).toContain(`git rev-list --count origin/main..${BRANCH}`);
	});

	it("holds an unclaimed tree with uncommitted work, naming what blocks the removal", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue()],
			...RELEASED,
			[SELF, here],
			[STATUS, okOut(" M a.ts\n?? b.ts")],
			[REVLIST, okOut("0\n")],
		]);

		expect(out.code).toBe(WORKTREE_HELD);
		expect(out.stderr.join("\n")).toMatch(/2 uncommitted path\(s\)/);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("holds an unclaimed tree whose branch carries commits past the base", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue()],
			...RELEASED,
			[SELF, here],
			[REVLIST, okOut("3\n")],
		]);

		expect(out.code).toBe(WORKTREE_HELD);
		expect(out.stderr.join("\n")).toMatch(/3 commit\(s\) past origin\/main/);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("is UNKNOWN when what the branch carries cannot be counted — never 'it carries nothing'", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue()],
			...RELEASED,
			[SELF, here],
			[REVLIST, errOut("unknown revision origin/main")],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toMatch(/UNKNOWN/);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("holds a tree whose lane a live claim still carries, without reading the tree at all", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue()],
			...CLAIMED,
			[SELF, here],
		]);

		expect(out.code).toBe(WORKTREE_HELD);
		expect(calls.some((line) => REVLIST.test(line))).toBe(false);
	});
});

describe("runRetire — what it refuses to touch", () => {
	it("never removes the tree this run is standing in, however terminal the ticket", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: HERE, branch: BRANCH})],
			[ISSUE, issue({state: "closed"})],
			...CLAIMED,
			[SELF, here],
		]);

		expect(out.code).toBe(WORKTREE_HELD);
		expect(out.stderr.join("\n")).toMatch(/the tree this run is standing in/);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("answers none — never a refusal — when no tree holds the number's lane branch", async () => {
		const {out} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: "/repo", branch: "main"})],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "none", retired: [], held: []});
	});

	it("is ZERO_SCOPE on a number the board proves absent — there is nothing to license a release", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, NOT_FOUND],
		]);

		expect(out.code).toBe(ZERO_SCOPE);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("is UNKNOWN when the claim markers cannot be read — never 'not adopted'", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue()],
			[COMMENTS, {status: 502, body: '{"message":"Bad gateway"}'}],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toMatch(/never "not adopted"/);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("is UNKNOWN when this run cannot recognise its own tree — it must remove nothing then", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue({state: "closed"})],
			...CLAIMED,
			[SELF, errOut("not a git repository")],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});
});

describe("runRetire — ADR 0321's salvage runs before the tree goes", () => {
	it("commits a dirty tree's work onto its own branch, then removes it", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[once(TREES), trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue({state: "closed"})],
			...CLAIMED,
			[SELF, here],
			[STATUS, okOut(" M worker/app.ts\n?? notes.md\n")],
			[ADD, okOut("")],
			[SALVAGE, okOut("")],
			[REMOVE, okOut("")],
			[TREES, trees()],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).retired).toMatchObject([{salvaged: true}]);
		expect(calls.findIndex((line) => SALVAGE.test(line))).toBeLessThan(
			calls.findIndex((line) => REMOVE.test(line)),
		);
	});

	it("commits nothing in a clean tree", async () => {
		const {calls} = await run([
			[PRUNE, okOut("")],
			[once(TREES), trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue({state: "closed"})],
			...CLAIMED,
			[SELF, here],
			[REMOVE, okOut("")],
			[TREES, trees()],
		]);

		expect(calls.some((line) => SALVAGE.test(line))).toBe(false);
	});

	it("leaves the tree standing when the salvage fails — removing it would destroy the only copy", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue({state: "closed"})],
			...CLAIMED,
			[SELF, here],
			[STATUS, okOut(" M worker/app.ts\n")],
			[ADD, okOut("")],
			[SALVAGE, errOut("cannot commit on a detached HEAD with no changes staged")],
		]);

		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("is UNKNOWN when the tree's own status cannot be read — it salvages and removes nothing", async () => {
		const {out, calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue({state: "closed"})],
			...CLAIMED,
			[SELF, here],
			[STATUS, errOut("not a git repository")],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});
});

describe("runRetire — the removal is proven, never reported", () => {
	it("reports a refused removal as an incident rather than overriding it with --force", async () => {
		const {out} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue({state: "closed"})],
			...CLAIMED,
			[SELF, here],
			[REMOVE, errOut("cannot remove a locked working tree")],
		]);

		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toMatch(/ADR 0321 bans --force/);
	});

	it("is READBACK_MISMATCH when git exits 0 and the registration survives", async () => {
		const {out} = await run([
			[PRUNE, okOut("")],
			[once(TREES), trees({path: ORPHAN, branch: BRANCH})],
			[ISSUE, issue({state: "closed"})],
			...CLAIMED,
			[SELF, here],
			[REMOVE, okOut("")],
			[TREES, trees({path: ORPHAN, branch: BRANCH})],
		]);

		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.join("\n")).toMatch(/still registered/);
	});

	it("prunes the registrations whose directory is gone before it reads which trees hold what", async () => {
		const {calls} = await run([
			[PRUNE, okOut("")],
			[TREES, trees({path: "/repo", branch: "main"})],
		]);

		expect(calls.findIndex((line) => PRUNE.test(line))).toBeLessThan(
			calls.findIndex((line) => TREES.test(line)),
		);
	});
});
