/** `lane assembly` — the run's own worktree is placed, resumed or removed, and never the driver's. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runAssembly} from "./assembly-verb.ts";
import {APPEND_UNKNOWN, LANE_ABSENT, LANE_UNREADABLE, PRIMARY_CHECKOUT} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const ROOT = ".fabrika/lanes";
const EPIC = 5680;
const BRANCH = `epic/${EPIC}`;
const MAIN = "/checkout/repo";
const EXPECTED = `${MAIN}/.claude/worktrees/epic-${EPIC}`;
const LANE_FILES = {[`${ROOT}/${EPIC}/workflow.json`]: coderTemplateText()};

const LIST = /^git worktree list --porcelain$/;
const ADD = /^git worktree add /;
const REMOVE = /^git worktree remove /;
const FETCH = /^git fetch /;
const BRANCHES = /^git for-each-ref /;
const SET_HEAD = /^git remote set-head /;
const TRUNK = /^git rev-parse --verify origin\/HEAD/;
const ANCESTOR = /^git merge-base --is-ancestor /;

const NO_BRANCHES = okOut("main\n");
const BRANCH_SURVIVED = okOut(`main\n${BRANCH}\n`);
const TRUNK_HEAD = okOut("bbbb222\n");
/** `merge-base --is-ancestor` answers through its status alone: zero is contained, non-zero is not. */
const CONTAINED = okOut("");
const DIVERGED = errOut("");

const listing = (
	...blocks: ReadonlyArray<readonly [string, string | null] | readonly [string, string, "prunable"]>
): ExecResult =>
	okOut(
		blocks
			.map(
				([path, branch, prunable]) =>
					`worktree ${path}\nHEAD aaaa111\n${branch === null ? "detached" : `branch refs/heads/${branch}`}\n${
						prunable === undefined ? "" : "prunable gitdir file points to non-existent location\n"
					}`,
			)
			.join("\n"),
	);

const CLEAN = listing([MAIN, "main"]);
const SEATED = listing([MAIN, "main"], [EXPECTED, BRANCH]);
const CONSCRIPTED = listing([MAIN, BRANCH]);
const STALE = listing([MAIN, "main"], [EXPECTED, BRANCH, "prunable"]);

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	remove = false,
	files: Record<string, string> = LANE_FILES,
) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(
			runAssembly({epic: EPIC, remove, root: ROOT, lane: String(EPIC)}),
			Layer.merge(shell.layer, fakeFs({files}).layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

describe("runAssembly", () => {
	it("places the run's worktree off origin/HEAD and answers its path, switching no checkout", async () => {
		const {outcome, calls} = await run([
			[once(LIST), CLEAN],
			[LIST, SEATED],
			[BRANCHES, NO_BRANCHES],
			[FETCH, okOut("")],
			[ADD, okOut("")],
			[/^git remote set-head /, okOut("")],
		]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe(EXPECTED);
		// `--no-track`: cut off `origin/HEAD` without it, the branch records `refs/heads/main` as its
		// upstream and the run's pushes aim at the default branch.
		expect(calls).toContain(`git worktree add --no-track -b ${BRANCH} ${EXPECTED} origin/HEAD`);
		expect(calls.some((line) => line.startsWith("git switch"))).toBe(false);
	});

	it("resumes an already-placed worktree still holding unlanded work, writing nothing", async () => {
		const {outcome, calls} = await run([
			[LIST, SEATED],
			[BRANCHES, BRANCH_SURVIVED],
			[FETCH, okOut("")],
			[SET_HEAD, okOut("")],
			[TRUNK, TRUNK_HEAD],
			[ANCESTOR, DIVERGED],
		]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe(EXPECTED);
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
		expect(calls.some((line) => line.startsWith("git worktree remove"))).toBe(false);
	});

	it("refuses the main working tree standing on the assembly branch, placing nothing", async () => {
		const {outcome, calls} = await run([[LIST, CONSCRIPTED]]);

		expect(outcome.code).toBe(PRIMARY_CHECKOUT);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(MAIN);
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
	});

	it("is UNKNOWN, never a placement, when the working trees cannot be read", async () => {
		const {outcome, calls} = await run([[LIST, errOut("not a git repository")]]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls).toEqual(["git worktree list --porcelain"]);
	});

	it("reports a placement that did not land rather than answering the path it meant to make", async () => {
		const {outcome} = await run([
			[LIST, CLEAN],
			[BRANCHES, NO_BRANCHES],
			[FETCH, okOut("")],
			[ADD, errOut("fatal: could not create work tree dir")],
		]);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("NOT placed");
	});

	it("never cuts the assembly branch off a stale base — a failed fetch places nothing", async () => {
		const {outcome, calls} = await run([
			[LIST, CLEAN],
			[BRANCHES, NO_BRANCHES],
			[FETCH, errOut("network is unreachable")],
		]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
	});

	it("removes the run's worktree at terminal, without --force", async () => {
		const {outcome, calls} = await run(
			[
				[once(LIST), SEATED],
				[LIST, CLEAN],
				[REMOVE, okOut("")],
			],
			true,
		);

		expect(outcome.code).toBe(0);
		expect(calls).toContain(`git worktree remove ${EXPECTED}`);
		expect(calls.some((line) => line.includes("--force"))).toBe(false);
	});

	it("tolerates a removal with nothing to remove, answering where the worktree belonged", async () => {
		const {outcome, calls} = await run([[LIST, CLEAN]], true);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe(EXPECTED);
		expect(calls.some((line) => line.startsWith("git worktree remove"))).toBe(false);
	});

	it("reports a removal that left the tree in place — git refusing a dirty tree is the answer", async () => {
		const {outcome} = await run(
			[
				[LIST, SEATED],
				[REMOVE, errOut("fatal: contains modified or untracked files")],
			],
			true,
		);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("NOT removed");
	});

	it("resumes a branch that outlived its worktree, checking it out rather than re-cutting it", async () => {
		const {outcome, calls} = await run([
			[once(LIST), CLEAN],
			[LIST, SEATED],
			[BRANCHES, BRANCH_SURVIVED],
			[FETCH, okOut("")],
			[SET_HEAD, okOut("")],
			[TRUNK, TRUNK_HEAD],
			[ANCESTOR, DIVERGED],
		]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe(EXPECTED);
		expect(calls).toContain(`git worktree add ${EXPECTED} ${BRANCH}`);
		expect(calls.some((line) => line.includes("worktree add --no-track"))).toBe(false);
		// A branch cut by an older fabrika carries a stale upstream into every resume.
		expect(calls).toContain(`git branch --unset-upstream ${BRANCH}`);
	});

	it("re-cuts a branch origin/HEAD already contains, and says so rather than answering a dead base", async () => {
		const {outcome, calls} = await run([
			[once(LIST), CLEAN],
			[LIST, SEATED],
			[BRANCHES, BRANCH_SURVIVED],
			[FETCH, okOut("")],
			[SET_HEAD, okOut("")],
			[TRUNK, TRUNK_HEAD],
			[ANCESTOR, CONTAINED],
			[ADD, okOut("")],
		]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe(EXPECTED);
		expect(calls).toContain(`git worktree add --no-track -B ${BRANCH} ${EXPECTED} origin/HEAD`);
		expect(outcome.stderr.join("\n")).toContain("re-cut");
		expect(calls.some((line) => line.includes("--force"))).toBe(false);
	});

	it("drops the seat of a contained branch before re-cutting it, and never forces that removal", async () => {
		const {outcome, calls} = await run([
			[once(LIST), SEATED],
			[once(LIST), CLEAN],
			[LIST, SEATED],
			[BRANCHES, BRANCH_SURVIVED],
			[FETCH, okOut("")],
			[SET_HEAD, okOut("")],
			[TRUNK, TRUNK_HEAD],
			[ANCESTOR, CONTAINED],
			[REMOVE, okOut("")],
			[ADD, okOut("")],
		]);

		expect(outcome.code).toBe(0);
		expect(calls).toContain(`git worktree remove ${EXPECTED}`);
		expect(calls).toContain(`git worktree add --no-track -B ${BRANCH} ${EXPECTED} origin/HEAD`);
		expect(calls.some((line) => line.includes("--force"))).toBe(false);
	});

	it("re-cuts nothing when the contained branch's seat holds work git will not drop", async () => {
		const {outcome, calls} = await run([
			[LIST, SEATED],
			[BRANCHES, BRANCH_SURVIVED],
			[FETCH, okOut("")],
			[SET_HEAD, okOut("")],
			[TRUNK, TRUNK_HEAD],
			[ANCESTOR, CONTAINED],
			[REMOVE, errOut("fatal: contains modified or untracked files")],
		]);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
	});

	it("is UNKNOWN, never a re-cut, when origin/HEAD names no commit after the fetch", async () => {
		const {outcome, calls} = await run([
			[LIST, CLEAN],
			[BRANCHES, BRANCH_SURVIVED],
			[FETCH, okOut("")],
			[SET_HEAD, okOut("")],
			[TRUNK, errOut("fatal: Needed a single revision")],
		]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
	});

	it("never judges an existing branch landed against a stale origin — a failed fetch places nothing", async () => {
		const {outcome, calls} = await run([
			[LIST, CLEAN],
			[BRANCHES, BRANCH_SURVIVED],
			[FETCH, errOut("network is unreachable")],
		]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
		expect(calls.some((line) => line.startsWith("git merge-base"))).toBe(false);
	});

	it("clears a worktree record whose directory is gone, then places the branch again", async () => {
		const {outcome, calls} = await run([
			[once(LIST), STALE],
			[once(LIST), CLEAN],
			[LIST, SEATED],
			[REMOVE, okOut("")],
			[BRANCHES, BRANCH_SURVIVED],
			[FETCH, okOut("")],
			[SET_HEAD, okOut("")],
			[TRUNK, TRUNK_HEAD],
			[ANCESTOR, DIVERGED],
			[ADD, okOut("")],
		]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe(EXPECTED);
		expect(calls).toEqual([
			"git worktree list --porcelain",
			"git for-each-ref --format=%(refname:short) refs/heads",
			"git fetch --quiet origin",
			"git remote set-head origin --auto",
			"git rev-parse --verify origin/HEAD^{commit}",
			`git merge-base --is-ancestor ${BRANCH} bbbb222`,
			`git worktree remove ${EXPECTED}`,
			"git worktree list --porcelain",
			`git worktree add ${EXPECTED} ${BRANCH}`,
			`git branch --unset-upstream ${BRANCH}`,
			"git worktree list --porcelain",
		]);
	});

	it("never answers the dead path of a stale record whose registration would not clear", async () => {
		const {outcome, calls} = await run([
			[LIST, STALE],
			[BRANCHES, BRANCH_SURVIVED],
			[FETCH, okOut("")],
			[SET_HEAD, okOut("")],
			[TRUNK, TRUNK_HEAD],
			[ANCESTOR, DIVERGED],
			[REMOVE, errOut("fatal: validation failed, cannot remove working tree")],
		]);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
	});

	it("clears the record left by a worktree already gone when --remove runs at terminal", async () => {
		const {outcome, calls} = await run(
			[
				[once(LIST), STALE],
				[LIST, CLEAN],
				[REMOVE, okOut("")],
			],
			true,
		);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe(EXPECTED);
		expect(calls).toContain(`git worktree remove ${EXPECTED}`);
		expect(calls.some((line) => line.includes("--force"))).toBe(false);
	});

	it("is UNKNOWN, never a placement, when the branch list cannot be read", async () => {
		const {outcome, calls} = await run([
			[LIST, CLEAN],
			[BRANCHES, errOut("fatal: not a git repository")],
		]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
		expect(calls.some((line) => line.startsWith("git fetch"))).toBe(false);
	});

	it("refuses a lane that was never emitted, before it touches any working tree", async () => {
		const {outcome, calls} = await run([[LIST, CLEAN]], false, {});

		expect(outcome.code).toBe(LANE_ABSENT);
		expect(calls).toEqual([]);
	});
});
