/**
 * What a plain `git worktree remove` does to a locked tree, run against real git.
 *
 * `build retire` releases a licensed tree's lock before its plain remove, and that rests on three
 * claims that are git's rather than this package's: a plain remove refuses a locked tree however
 * clean it is, `unlock` followed by a plain remove succeeds with no `--force`, and a plain remove
 * still refuses a dirty tree once it is unlocked — so releasing the lock spends none of the refusal
 * the salvage-first order leans on.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/6881#issuecomment-5519864099
 */
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
	execFileSync("git", [...args], {cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe"}).trim();

/** git's stderr for a command that must refuse, or a thrown error when it did not. */
const refusal = (cwd: string, ...args: ReadonlyArray<string>): string => {
	try {
		git(cwd, ...args);
	} catch (error) {
		return String((error as {stderr?: unknown}).stderr ?? "");
	}
	throw new Error(`git ${args.join(" ")} succeeded where a refusal was expected`);
};

const roots: Array<string> = [];
afterAll(() => {
	for (const root of roots) rmSync(root, {recursive: true, force: true});
	roots.length = 0;
});

/** A repo with one linked worktree on its own branch, locked the way the harness locks one. */
const open = (): {readonly repo: string; readonly tree: string} => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-locked-"));
	roots.push(root);
	const repo = join(root, "repo");
	git(root, "init", "--quiet", "--initial-branch=main", repo);
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	git(repo, "add", "seed.txt");
	git(repo, "commit", "--quiet", "-m", "seed");

	const tree = join(root, "tree");
	git(repo, "worktree", "add", "--quiet", "-b", "build/4312-lane-a9bd1234", tree, "HEAD");
	git(repo, "worktree", "lock", "--reason", "claude agent a9bd (pid 4242)", tree);
	return {repo, tree};
};

describe("a plain git worktree remove on a locked tree, against real git", () => {
	it(
		"refuses a clean locked tree outright",
		() => {
			const {repo, tree} = open();

			expect(refusal(repo, "worktree", "remove", tree)).toMatch(/locked working tree/);
			expect(existsSync(tree)).toBe(true);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"removes it after an unlock, with no --force, and leaves the branch",
		() => {
			const {repo, tree} = open();

			git(repo, "worktree", "unlock", tree);
			git(repo, "worktree", "remove", tree);

			expect(existsSync(tree)).toBe(false);
			expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(tree);
			expect(git(repo, "branch", "--list", "build/4312-lane-a9bd1234")).not.toBe("");
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"still refuses a dirty tree once unlocked — the unlock spends no content refusal",
		() => {
			const {repo, tree} = open();
			writeFileSync(join(tree, "unsaved.txt"), "work nobody committed\n");

			git(repo, "worktree", "unlock", tree);

			expect(refusal(repo, "worktree", "remove", tree)).toMatch(/modified or untracked files/);
			expect(existsSync(join(tree, "unsaved.txt"))).toBe(true);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);
});
