/**
 * What `git worktree prune` does to a stale registration, run against real git.
 *
 * `build reap` clears its `Prune` verdicts by running that one command, and the whole design rests
 * on four claims that are git's rather than this package's: that a direct `prune` drops a stale
 * entry with no `--expire` window standing in the way, that it refuses to touch a live one, that
 * it *skips* a locked entry whose directory is gone — the state fourteen of the operator clone's
 * registrations sat in, locked by a harness process dead since August, which is why the verb
 * unlocks before it prunes — and that git's `prunable` flag reports on the worktree's `.git` file
 * rather than its directory, which is why the verb proves absence with its own stat and never with
 * that flag. Measured here rather than reasoned about (CLAUDE.md: ground platform claims in a real
 * run).
 *
 * Removing a *directory* out from under a registration is exactly how a dead session leaves one
 * behind, so the fixture creates that state the same way rather than simulating it.
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
	execFileSync("git", [...args], {cwd, env: GIT_ENV, encoding: "utf8"}).trim();

const roots: Array<string> = [];
afterAll(() => {
	for (const root of roots) rmSync(root, {recursive: true, force: true});
	roots.length = 0;
});

/** How many registrations `git worktree list` reports, the primary checkout included. */
const registrations = (repo: string): number =>
	git(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length;

interface Fixture {
	readonly repo: string;
	/** Two linked worktrees: one whose directory is then deleted, one left alone. */
	readonly dead: string;
	readonly live: string;
}

const open = (): Fixture => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-stale-"));
	roots.push(root);
	const repo = join(root, "repo");

	git(root, "init", "--quiet", "--initial-branch=main", repo);
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	git(repo, "add", "seed.txt");
	git(repo, "commit", "--quiet", "-m", "seed");

	const dead = join(root, "dead");
	const live = join(root, "live");
	git(repo, "worktree", "add", "--detach", "--quiet", dead, "HEAD");
	git(repo, "worktree", "add", "--detach", "--quiet", live, "HEAD");
	return {repo, dead, live};
};

describe("git worktree prune, against real git", () => {
	it(
		"clears a registration whose directory is gone and keeps the one still on disk",
		() => {
			const {repo, dead, live} = open();
			expect(registrations(repo)).toBe(3);

			rmSync(dead, {recursive: true, force: true});
			expect(git(repo, "worktree", "list", "--porcelain")).toMatch(/prunable/);

			git(repo, "worktree", "prune");

			expect(registrations(repo)).toBe(2);
			expect(git(repo, "worktree", "list", "--porcelain")).toContain(live);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"needs no --expire window: a registration stale for seconds is dropped by a direct prune",
		() => {
			const {repo, dead} = open();
			rmSync(dead, {recursive: true, force: true});

			// The `gc.worktreePruneExpire` default is `git gc`'s, not this command's. If it bound here,
			// a just-orphaned entry would survive and `build reap` would prune nothing it ever finds.
			git(repo, "worktree", "prune");

			expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(dead);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"SKIPS a locked registration whose directory is gone — the state unlock exists for",
		() => {
			const {repo, dead} = open();
			git(repo, "worktree", "lock", "--reason", "claude agent (pid 84894)", dead);
			rmSync(dead, {recursive: true, force: true});

			git(repo, "worktree", "prune");
			expect(git(repo, "worktree", "list", "--porcelain")).toContain(dead);

			git(repo, "worktree", "unlock", dead);
			git(repo, "worktree", "prune");
			expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(dead);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"calls a registration prunable on a DELETED .git FILE, while its checkout still holds work",
		() => {
			const {repo, dead} = open();
			writeFileSync(join(dead, "unsaved.txt"), "work nobody committed\n");
			rmSync(join(dead, ".git"), {force: true});

			// The flag's condition is the `.git` file, not the directory — so it fires here, where
			// there is a checkout and it is dirty. Seating "its directory is gone" off this would
			// clear the record and take `.git/worktrees/<id>` with it, which is where that worktree's
			// HEAD, index and reflog live. `build reap` proves absence with its own stat instead.
			expect(git(repo, "worktree", "list", "--porcelain")).toMatch(/prunable/);
			expect(existsSync(dead)).toBe(true);
			expect(existsSync(join(dead, "unsaved.txt"))).toBe(true);

			git(repo, "worktree", "prune");

			expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(dead);
			expect(existsSync(join(repo, ".git", "worktrees", "dead"))).toBe(false);
			expect(existsSync(join(dead, "unsaved.txt"))).toBe(true);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"leaves a live registration alone however many times it runs",
		() => {
			const {repo, live} = open();

			git(repo, "worktree", "prune");
			git(repo, "worktree", "prune");

			expect(git(repo, "worktree", "list", "--porcelain")).toContain(live);
			expect(registrations(repo)).toBe(3);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);
});
