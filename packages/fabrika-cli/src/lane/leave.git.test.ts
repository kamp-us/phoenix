/**
 * `lane leave` run as the real process, from inside the tree it removes.
 *
 * The unit tier pins which commands run. Only a real process standing in a real linked worktree
 * can show the thing the verb exists for: that git takes the directory out from under the process
 * that asked, and that the re-read afterwards still answers from a directory that is gone.
 */
import {execFile, execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {TREES_KEPT} from "./codes.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
	execFileSync("git", args, {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();

interface Ran {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Run the verb with `cwd` as the process's own directory, the way a shell's last command does. */
const leaveFrom = (cwd: string): Promise<Ran> =>
	new Promise((resolve) => {
		execFile(
			process.execPath,
			["--experimental-strip-types", BIN, "lane", "leave"],
			{cwd, encoding: "utf8"},
			(error, stdout, stderr) =>
				resolve({code: typeof error?.code === "number" ? error.code : 0, stdout, stderr}),
		);
	});

const clone = () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-leave-")));
	const origin = join(home, "origin.git");
	const root = join(home, "checkout");
	execFileSync("git", ["init", "--bare", "--initial-branch=main", origin]);
	execFileSync("git", ["clone", origin, root], {stdio: "ignore"});
	git(root, "config", "user.email", "leave@example.test");
	git(root, "config", "user.name", "leave");
	writeFileSync(join(root, ".gitignore"), "node_modules/\n");
	git(root, "add", "-A");
	git(root, "commit", "-m", "base");
	git(root, "push", "-u", "origin", "HEAD:main");
	const tree = (name: string) => {
		const path = join(root, ".claude", "worktrees", name);
		git(root, "worktree", "add", "--detach", path, "origin/main");
		return path;
	};
	const commit = (path: string, name: string) => {
		writeFileSync(join(path, `${name}.txt`), `${name}\n`);
		git(path, "add", "-A");
		git(path, "commit", "-m", `work in ${name}`);
	};
	return {root, tree, commit, listed: () => git(root, "worktree", "list", "--porcelain")};
};

describe("lane leave over a real clone", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("removes the tree it was started in, directory and registration, when every commit is published", async () => {
		const {root, tree, commit, listed} = clone();
		const path = tree("operator");
		git(path, "switch", "-c", "build/42-pushed");
		commit(path, "pushed");
		git(path, "push", "-u", "origin", "build/42-pushed");
		mkdirSync(join(path, "node_modules"));
		writeFileSync(join(path, "node_modules", "installed.js"), "ignored\n");
		mkdirSync(join(path, "packages", "deep"), {recursive: true});

		// A subdirectory, because a shell's last command rarely runs from the tree's root.
		const ran = await leaveFrom(join(path, "packages", "deep"));

		expect(ran.stderr).toContain(`fabrika lane leave: removed ${path}`);
		expect(ran.code).toBe(0);
		expect(JSON.parse(ran.stdout)).toEqual({answer: "removed", worktree: path});
		expect(existsSync(path)).toBe(false);
		expect(listed()).not.toContain(path);
		expect(existsSync(join(root, ".git", "worktrees", "operator"))).toBe(false);
		// The removal takes the checkout and leaves the branch.
		expect(git(root, "branch", "--list", "build/42-pushed")).toContain("build/42-pushed");
	});

	it("keeps a tree with an uncommitted path and names the path and the reason", async () => {
		const {tree, listed} = clone();
		const path = tree("triager");
		writeFileSync(join(path, "notes.md"), "not committed\n");

		const ran = await leaveFrom(path);

		expect(ran.code).toBe(TREES_KEPT);
		expect(ran.stdout).toBe("");
		expect(ran.stderr).toContain(
			`fabrika lane leave: kept ${path} — uncommitted: 1 uncommitted path`,
		);
		expect(existsSync(join(path, "notes.md"))).toBe(true);
		expect(listed()).toContain(path);
	});

	it("keeps a tree whose commit is on no remote ref", async () => {
		const {tree, commit, listed} = clone();
		const path = tree("gate");
		commit(path, "local");

		const ran = await leaveFrom(path);

		expect(ran.code).toBe(TREES_KEPT);
		expect(ran.stderr).toContain(
			`fabrika lane leave: kept ${path} — unpublished: 1 commit on no remote ref`,
		);
		expect(existsSync(join(path, "local.txt"))).toBe(true);
		expect(listed()).toContain(path);
	});

	it("answers main from the main working tree and touches nothing", async () => {
		const {root, tree, listed} = clone();
		const linked = tree("bystander");

		const ran = await leaveFrom(root);

		expect(ran.code).toBe(0);
		expect(JSON.parse(ran.stdout)).toEqual({answer: "main", worktree: root});
		expect(existsSync(join(root, ".gitignore"))).toBe(true);
		expect(existsSync(linked)).toBe(true);
		expect(listed()).toContain(linked);
	});
});
