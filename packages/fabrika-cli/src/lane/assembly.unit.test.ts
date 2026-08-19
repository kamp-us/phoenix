/** The reads that decide whether an epic run's assembly seat is the driver's own checkout. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {Shell} from "../io/git.ts";
import {
	assemblySeat,
	assemblyWorktreePath,
	parseWorktreeList,
	splitTrees,
	standingInLinkedWorktree,
	type WorkingTrees,
	worktrees,
} from "./assembly.ts";

const MAIN = "/checkout/phoenix";
const LIST = `worktree ${MAIN}
HEAD aaaa111
branch refs/heads/main

worktree ${MAIN}/.claude/worktrees/epic-5680
HEAD bbbb222
branch refs/heads/epic/5680

worktree ${MAIN}/.claude/worktrees/agent-77
HEAD cccc333
detached
`;

const STALE = `worktree ${MAIN}
HEAD aaaa111
branch refs/heads/main

worktree ${MAIN}/.claude/worktrees/epic-5680
HEAD bbbb222
branch refs/heads/epic/5680
prunable gitdir file points to non-existent location
`;

const run = <A>(effect: Shell<A>, script: ExecResult): Promise<A> =>
	Effect.runPromise(Effect.provide(effect, fakeShell([[/^git /, script]]).layer));

describe("parseWorktreeList", () => {
	it("reads every tree with its short branch, main first — git's own ordering", () => {
		expect(parseWorktreeList(LIST)).toEqual([
			{path: MAIN, branch: "main", prunable: false},
			{path: `${MAIN}/.claude/worktrees/epic-5680`, branch: "epic/5680", prunable: false},
			{path: `${MAIN}/.claude/worktrees/agent-77`, branch: null, prunable: false},
		]);
	});

	it("keeps the prunable flag git prints for a record whose directory is gone", () => {
		expect(parseWorktreeList(STALE)).toEqual([
			{path: MAIN, branch: "main", prunable: false},
			{path: `${MAIN}/.claude/worktrees/epic-5680`, branch: "epic/5680", prunable: true},
		]);
	});

	it("reads a bare `prunable` line too, which git prints when it carries no reason", () => {
		expect(
			parseWorktreeList("worktree /gone\nHEAD aaaa111\nbranch refs/heads/epic/5680\nprunable\n"),
		).toEqual([{path: "/gone", branch: "epic/5680", prunable: true}]);
	});

	it("answers no tree at all for bytes carrying no worktree record, so a caller cannot read one", () => {
		expect(parseWorktreeList("")).toEqual([]);
		expect(parseWorktreeList("HEAD aaaa111\n")).toEqual([]);
	});
});

describe("assemblyWorktreePath", () => {
	it("derives the run's path from the epic number, under the main tree", () => {
		expect(assemblyWorktreePath(MAIN, 5680)).toBe(`${MAIN}/.claude/worktrees/epic-5680`);
	});

	it("does not double the separator on a main root that carries a trailing slash", () => {
		expect(assemblyWorktreePath(`${MAIN}/`, 5680)).toBe(`${MAIN}/.claude/worktrees/epic-5680`);
	});
});

describe("assemblySeat", () => {
	const trees = (text: string): WorkingTrees => {
		const split = splitTrees(parseWorktreeList(text));
		if (split === null) throw new Error("fixture carries no working tree");
		return split;
	};
	const entries = trees(LIST);

	it("names an assembly branch held by a linked worktree isolated", () => {
		expect(assemblySeat(entries, 5680, "epic/5680")).toEqual({
			_tag: "Isolated",
			path: `${MAIN}/.claude/worktrees/epic-5680`,
			expected: `${MAIN}/.claude/worktrees/epic-5680`,
		});
	});

	it("names the main working tree standing on the assembly branch conscripted (#6163)", () => {
		const conscripted = trees(`worktree ${MAIN}
HEAD aaaa111
branch refs/heads/epic/5680
`);

		expect(assemblySeat(conscripted, 5680, "epic/5680")).toEqual({
			_tag: "Conscripted",
			path: MAIN,
			expected: `${MAIN}/.claude/worktrees/epic-5680`,
		});
	});

	it("accepts a linked worktree the driver put elsewhere — the defect is the shared checkout, not the path", () => {
		const elsewhere = trees(`worktree ${MAIN}
HEAD aaaa111
branch refs/heads/main

worktree /tmp/assembly
HEAD bbbb222
branch refs/heads/epic/5680
`);

		expect(assemblySeat(elsewhere, 5680, "epic/5680")).toMatchObject({
			_tag: "Isolated",
			path: "/tmp/assembly",
		});
	});

	it("names a record whose directory is gone stale, never isolated at a dead path (#6163)", () => {
		expect(assemblySeat(trees(STALE), 5680, "epic/5680")).toEqual({
			_tag: "Stale",
			path: `${MAIN}/.claude/worktrees/epic-5680`,
			expected: `${MAIN}/.claude/worktrees/epic-5680`,
		});
	});

	it("answers absent, with the path one belongs at, when no tree holds the branch", () => {
		expect(assemblySeat(entries, 9999, "epic/9999")).toEqual({
			_tag: "Absent",
			expected: `${MAIN}/.claude/worktrees/epic-9999`,
		});
	});
});

describe("worktrees", () => {
	it("fails rather than answering an empty list git never printed", async () => {
		await expect(run(worktrees, okOut(""))).resolves.toMatchObject({_tag: "Failure"});
	});

	it("fails on a read fault instead of resolving to no trees", async () => {
		await expect(run(worktrees, errOut("not a git repository"))).resolves.toMatchObject({
			_tag: "Failure",
		});
	});
});

describe("standingInLinkedWorktree", () => {
	const paths = (gitDir: string, commonDir: string) => okOut(`${gitDir}\n${commonDir}\n`);

	it("reads the main working tree, where the two git dirs are one path", async () => {
		await expect(
			run(standingInLinkedWorktree, paths(`${MAIN}/.git`, `${MAIN}/.git`)),
		).resolves.toEqual({_tag: "Ok", value: false});
	});

	it("reads a linked worktree, where --git-dir sits under the common dir", async () => {
		await expect(
			run(standingInLinkedWorktree, paths(`${MAIN}/.git/worktrees/epic-5680`, `${MAIN}/.git`)),
		).resolves.toEqual({_tag: "Ok", value: true});
	});

	it("is UNKNOWN on a read fault — never the permissive `linked`", async () => {
		await expect(run(standingInLinkedWorktree, errOut("fatal"))).resolves.toMatchObject({
			_tag: "Failure",
		});
	});

	it("is UNKNOWN when git answers a shape that is not the two paths asked for", async () => {
		await expect(run(standingInLinkedWorktree, okOut(`${MAIN}/.git\n`))).resolves.toMatchObject({
			_tag: "Failure",
		});
	});
});
