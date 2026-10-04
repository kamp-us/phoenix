/** `lane leave` — the tree a shell stands in goes, and one that holds work stays and is named. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeSeams, okOut, once, type Scripted} from "../fakes.test-support.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE, TREES_KEPT} from "./codes.ts";
import {runLeave} from "./leave-verb.ts";

const MAIN = "/checkout/repo";
const TREE = `${MAIN}/.claude/worktrees/agent-operator`;

const LIST = /^git worktree list --porcelain$/;
const RELIST = new RegExp(`^git -C ${MAIN} worktree list --porcelain$`);
const REMOVE = new RegExp(`^git -C ${MAIN} worktree remove ${TREE}$`);
const STATUS = new RegExp(`^git -C ${TREE} status --porcelain$`);
const AHEAD = new RegExp(`^git -C ${TREE} rev-list --count HEAD --not --remotes$`);
const HEAD = new RegExp(`^git -C ${TREE} rev-parse HEAD$`);

const block = (path: string, prunable = false): string =>
	`worktree ${path}\nHEAD aaaa111\n${path === MAIN ? "branch refs/heads/main" : "detached"}\n${
		prunable ? "prunable gitdir file points to non-existent location\n" : ""
	}`;

const listing = (...linked: ReadonlyArray<string>) =>
	okOut([MAIN, ...linked].map((path) => block(path)).join("\n"));

const CLEAN: ReadonlyArray<Scripted> = [
	[STATUS, okOut("")],
	[AHEAD, okOut("0\n")],
];

interface Scene {
	readonly tree?: Attempt<string>;
	/** Whether the tree's directory still stands when it is probed after the removal. */
	readonly stands?: boolean;
	readonly unprobeable?: boolean;
}

const run = (script: ReadonlyArray<Scripted>, scene: Scene = {}) => {
	const shell = fakeSeams(script);
	const fs = fakeFs({
		files: {},
		unprobeable: scene.unprobeable === true ? [TREE] : [],
		directories: scene.stands === true ? [MAIN, TREE] : [MAIN],
	});
	return Effect.runPromise(
		Effect.provide(runLeave({tree: scene.tree ?? ok(TREE)}), Layer.merge(shell.layer, fs.layer)),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

const mutations = (calls: ReadonlyArray<string>) =>
	calls.filter((line) => line.includes("worktree remove"));

describe("runLeave", () => {
	it("removes a clean tree whose commits are published, with a plain removal addressed at the main tree", async () => {
		const {outcome, calls} = await run([
			[LIST, listing(TREE)],
			...CLEAN,
			[REMOVE, okOut("")],
			[RELIST, listing()],
		]);

		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({answer: "removed", worktree: TREE});
		expect(mutations(calls)).toEqual([`git -C ${MAIN} worktree remove ${TREE}`]);
		expect(calls.some((line) => line.includes("--force"))).toBe(false);
	});

	it("keeps a tree with uncommitted paths and names its path and the reason", async () => {
		const {outcome, calls} = await run([
			[LIST, listing(TREE)],
			[STATUS, okOut(" M src/a.ts\n?? notes.md\n")],
		]);

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(
			`fabrika lane leave: kept ${TREE} — uncommitted: 2 uncommitted paths`,
		);
		expect(mutations(calls)).toEqual([]);
	});

	it("keeps a tree with commits on no remote ref, since no lane's pull request can carry them", async () => {
		const {outcome, calls} = await run([
			[LIST, listing(TREE)],
			[STATUS, okOut("")],
			[AHEAD, okOut("2\n")],
			[HEAD, okOut(`${"a".repeat(40)}\n`)],
		]);

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stderr.join("\n")).toContain(
			`fabrika lane leave: kept ${TREE} — unpublished: 2 commits on no remote ref — no lane names a merged pull request that could carry them`,
		);
		expect(mutations(calls)).toEqual([]);
	});

	it("keeps a tree whose status cannot be read", async () => {
		const {outcome, calls} = await run([
			[LIST, listing(TREE)],
			[STATUS, errOut("fatal: not a work tree")],
		]);

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stderr.join("\n")).toContain(`fabrika lane leave: kept ${TREE} — unreadable:`);
		expect(mutations(calls)).toEqual([]);
	});

	it("keeps a tree whose commits cannot be counted against the remote refs", async () => {
		const {outcome, calls} = await run([
			[LIST, listing(TREE)],
			[STATUS, okOut("")],
			[AHEAD, errOut("fatal: bad revision")],
		]);

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stderr.join("\n")).toContain(`fabrika lane leave: kept ${TREE} — unreadable:`);
		expect(mutations(calls)).toEqual([]);
	});

	it("keeps a tree git holds no live registration for, without reading inside it", async () => {
		const {outcome, calls} = await run([
			[LIST, okOut([block(MAIN), block(TREE, true)].join("\n"))],
		]);

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stderr.join("\n")).toContain(`fabrika lane leave: kept ${TREE} — unregistered:`);
		expect(calls).toEqual(["git worktree list --porcelain"]);
	});

	it("answers main in the main working tree and runs no removal", async () => {
		const {outcome, calls} = await run([[LIST, listing(TREE)]], {tree: ok(MAIN)});

		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({answer: "main", worktree: MAIN});
		expect(calls).toEqual(["git worktree list --porcelain"]);
	});

	it("refuses as UNKNOWN when the tree it runs in or the working trees cannot be read", async () => {
		const unread = await run([], {tree: fail("not a git repository")});
		expect(unread.outcome.code).toBe(LANE_UNREADABLE);
		expect(unread.calls).toEqual([]);

		const unlisted = await run([[LIST, errOut("fatal: unable to read")]]);
		expect(unlisted.outcome.code).toBe(LANE_UNREADABLE);
		expect(mutations(unlisted.calls)).toEqual([]);
	});

	it("reports a tree git declined to remove as kept, with git's own reason", async () => {
		const {outcome} = await run(
			[
				[LIST, listing(TREE)],
				...CLEAN,
				[REMOVE, errOut("fatal: working trees containing submodules cannot be removed")],
				[RELIST, listing(TREE)],
			],
			{stands: true},
		);

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stderr.join("\n")).toContain(
			`fabrika lane leave: kept ${TREE} — remove-refused:`,
		);
		expect(outcome.stderr.join("\n")).toContain("submodules");
	});

	it("is UNKNOWN when the removal ran and the working trees cannot be listed again", async () => {
		const {outcome} = await run([
			[once(LIST), listing(TREE)],
			...CLEAN,
			[REMOVE, okOut("")],
			[RELIST, errOut("fatal: unable to read")],
		]);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});
});
